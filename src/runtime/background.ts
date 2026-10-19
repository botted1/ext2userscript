// The background (spec §5.4): runs on the leader tab only, from the top, once per page. An extension with pages but
// no background still gets a leader, which keeps the extension's state (menus, alarms, the button) for the pages. Before its code runs, the leader
// checks install and session state and loads localStorage; after, it fires the service-worker events and
// runtime.onInstalled / onStartup. A leader that steps down pauses: messages and events stop reaching the background's
// listeners (its timers keep running, a ceiling the spec accepts); if it leads again, it resumes without running the
// code a second time.
import { createAlarms } from "./alarms.ts";
import type { Assets } from "./assets.ts";
import { createEvent, createLogger, method, platformInfo, readLastError, RUNTIME_ENUMS, withFallback, type Logger } from "./chrome.ts";
import { createCommands, EXECUTE_ACTION } from "./commands.ts";
import { createCookies } from "./cookies.ts";
import type { BackgroundCode, PageKind, RuntimeConfig } from "./config.ts";
import type { Gm } from "./gm.ts";
import { createBackgroundGlobal } from "./global.ts";
import { keys } from "./keys.ts";
import { checkLifecycle } from "./lifecycle.ts";
import { createMenus, type MenuClick } from "./menus.ts";
import type { Messaging } from "./messaging.ts";
import { createNetwork } from "./net.ts";
import { createNotifications } from "./notifications.ts";
import { CALLED_IN_BACKGROUND } from "./pages.ts";
import { createPermissions } from "./permissions.ts";
import { REGISTRY_TIMING } from "./registry.ts";
import { createScripting } from "./scripting.ts";
import { createWindows } from "./windows.ts";

export type BackgroundDeps = {
  config: RuntimeConfig;
  /** The background's code; null for an extension without one, whose leader keeps only the extension's state for its pages. */
  code: BackgroundCode | null;
  gm: Gm;
  log: Logger;
  assets: Assets;
  i18n: object;
  storage: object;
  tabs: object;
  messaging: Messaging;
  /** The extension's localStorage, which this tab's pages share. */
  localStorage(): Promise<Storage>;
};

export async function startBackground(deps: BackgroundDeps): Promise<{ pause(): void; resume(): void; global: unknown }> {
  const { config, gm, log, assets, messaging } = deps;
  const background = deps.code ? config.background : undefined;
  const lifecycle = await checkLifecycle(gm, config.ns, String((config.manifest as { version?: unknown }).version ?? ""));
  const localStorage = await deps.localStorage();
  const alarms = await createAlarms(gm, config.ns, log);
  // A persistent MV2 background page makes its menu each time it starts; an event page or service worker makes it once.
  const persistent = background !== undefined && !background.worker && (config.manifest as { background?: { persistent?: unknown } }).background?.persistent !== false;
  const menus = await createMenus({ gm, ns: config.ns, log, config, persistent });
  messaging.onEvent("menu-click", (data, sender) => menus.click(data as MenuClick, sender.tab));
  messaging.onEvent("action-click", (_data, sender) => menus.actionClick(sender.tab));
  const commands = createCommands(config, log);
  messaging.onEvent("command", (data, sender) => {
    const { name } = data as { name: string };
    // _execute_action opens the popup when there is one (not converted yet), and clicks the button otherwise.
    if (!EXECUTE_ACTION.has(name)) commands.fire(name, sender.tab);
    else if (!config.action?.popup) menus.actionClick(sender.tab);
  });
  let active = true;
  // While it leads, the session stamp stays fresh, so a new leader in this browser session doesn't fire onStartup.
  setInterval(() => {
    if (active) void gm.setValue(keys(config.ns).session, { t: Date.now() });
  }, REGISTRY_TIMING.heartbeatMs);

  const permissions = await createPermissions(gm, config.ns, log, config);
  // The background's global object, for getBackgroundPage; it exists once the code below has made it.
  let backgroundGlobal: unknown;
  const onInstalled = createEvent<(details: object) => void>(log);
  const onStartup = createEvent<() => void>(log);
  const onSuspend = createEvent<() => void>(log);
  const getURL = (path: string) => assets.url(path);
  const runtime = withFallback(log, "runtime", {
    id: config.id,
    get lastError() {
      return readLastError();
    },
    getURL,
    getManifest: () => structuredClone(config.manifest),
    ...messaging.runtime("background"),
    onInstalled: onInstalled.event,
    onStartup: onStartup.event,
    // The background never suspends while its tab is open.
    onSuspend: onSuspend.event,
    getPlatformInfo: method(log, async () => platformInfo()),
    openOptionsPage: method(log, () => openPage("options")),
    setUninstallURL: method(log, async () => {}),
    getBackgroundPage: method(log, async () => backgroundGlobal),
    ...structuredClone(RUNTIME_ENUMS),
  }, "all");
  const extension = withFallback(log, "extension", {
    getURL,
    getBackgroundPage: () => backgroundGlobal,
    inIncognitoContext: false,
    get lastError() {
      return readLastError();
    },
  }, "all");
  const tabs = deps.tabs as { query(query: object): Promise<Array<{ id: number }>> } & Record<string, unknown>;
  /** Opens the popup or options page in the active tab, as Chrome shows it over the current window. */
  const openPage = async (kind: PageKind) => {
    const tab = (await tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!tab) throw new Error(`ext2userscript: no tab is open to show the ${kind} page in`);
    await messaging.control(tab.id, "open-page", { kind });
  };
  const action = { ...menus.action, openPopup: method(log, () => openPage("popup")) };
  const scripting = createScripting({ messaging, assets, log, currentTab: async () => (await tabs.query({ active: true }))[0]?.id });
  const known: Record<string, object> = {
    runtime,
    storage: deps.storage,
    i18n: deps.i18n,
    // MV2's tabs.executeScript, insertCSS and removeCSS sit next to the rest of chrome.tabs.
    tabs: withFallback(log, "tabs", { ...tabs, ...scripting.tabs }, "all"),
    scripting: withFallback(log, "scripting", scripting.scripting, "all"),
    extension,
    alarms: withFallback(log, "alarms", alarms.api, "all"),
    commands: withFallback(log, "commands", commands.api, "all"),
    notifications: withFallback(log, "notifications", createNotifications({ gm, log, dataUrl: assets.dataUrl }), "all"),
    cookies: withFallback(log, "cookies", createCookies(gm, log), "all"),
    permissions: withFallback(log, "permissions", permissions, "all"),
    windows: withFallback(log, "windows", createWindows(deps.tabs as Parameters<typeof createWindows>[0], log), "all"),
    contextMenus: withFallback(log, "contextMenus", menus.contextMenus, "all"),
    menus: withFallback(log, "menus", menus.contextMenus, "all"),
    // MV3's action, and MV2's browserAction and pageAction: one toolbar button, shown as a menu command.
    action: withFallback(log, "action", action, "all"),
    browserAction: withFallback(log, "browserAction", action, "all"),
    pageAction: withFallback(log, "pageAction", action, "all"),
  };
  // The extension's pages call these namespaces here, where their state lives (pages.ts).
  messaging.onEvent("call", (data) => {
    const { namespace, member, args } = data as { namespace: string; member: string; args: unknown[] };
    const fn = CALLED_IN_BACKGROUND.has(namespace) ? (known[namespace] as Record<string, unknown>)[member] : undefined;
    if (typeof fn !== "function") throw new Error(`ext2userscript: chrome.${namespace}.${member} isn't available`);
    return fn(...args);
  });
  const chrome = backgroundChrome(known, log);
  if (background && deps.code) backgroundGlobal = run(background, deps.code);

  /** Runs the background's code from the top, in its wrapper (spec §3.3), and returns its global object. */
  function run(background: NonNullable<RuntimeConfig["background"]>, code: BackgroundCode): unknown {
    const importScripts = () => {
      throw new Error("ext2userscript: importScripts works only with string literals, which are inlined when the extension is converted");
    };
    const self = `chrome-extension://${config.id}/${background.entry}`;
    // A service worker has fetch but no XMLHttpRequest, as in Chrome; a background page has both.
    const network = createNetwork({
      gm,
      asset: assets.file,
      assetPathOf: assets.pathOf,
      extensionId: config.id,
      base: () => self,
      cookies: "unless-omitted",
      origin: location.origin,
      hosts: [...(config.permissions?.origins ?? []), ...(config.permissions?.optionalOrigins ?? [])],
      fetch: globalThis.fetch.bind(globalThis),
      XMLHttpRequest: globalThis.XMLHttpRequest,
    });
    const XMLHttpRequest = background.worker ? undefined : network.XMLHttpRequest;
    const ownLocation = backgroundLocation(config.id, background);
    const { global, fire, expose } = createBackgroundGlobal({ chrome, browser: chrome, importScripts, localStorage, fetch: network.fetch, XMLHttpRequest, location: ownLocation });
    const meta: { url: string; exports?: () => object } = { url: self };
    try {
      code(
        chrome,
        chrome,
        global,
        global,
        // A service worker has no window or document; code that checks for them must see that.
        background.worker ? undefined : global,
        background.worker ? undefined : document,
        importScripts,
        localStorage,
        network.fetch,
        XMLHttpRequest,
        ownLocation,
        meta,
        // this is the background's global, as at a background script's top level.
      ).call(global);
    } catch (error) {
      createLogger(`${config.name} background`).error(error);
    }
    // A background page's top-level var and function declarations are its window's properties, which pages reach with
    // getBackgroundPage().
    if (meta.exports) expose(meta.exports());
    // A service worker gets install and activate when the extension is installed or updated, as in Chrome.
    if (background.worker && lifecycle.installed) {
      setTimeout(() => {
        fire("install");
        fire("activate");
      });
    }
    return global;
  }
  messaging.setBackgroundReady(true);
  setTimeout(() => {
    if (lifecycle.installed) onInstalled.dispatch(lifecycle.installed);
    if (lifecycle.startup) onStartup.dispatch();
  });
  return {
    global: backgroundGlobal,
    pause: () => {
      active = false;
      messaging.setBackgroundReady(false);
      alarms.pause();
    },
    resume: () => {
      active = true;
      messaging.setBackgroundReady(true);
      void alarms.resume();
    },
  };
}

/**
 * The background's chrome object: the namespaces it implements, and, as the background has every API the manifest asks
 * for, a namespace whose members fail with a named error for any other name (so top-level code that sets one up, such
 * as chrome.alarms.create(...), doesn't stop the rest of the background). Only a name shaped like a Chrome namespace
 * gets one: a bundler's interop check (chrome.__esModule) must find nothing, or it takes chrome for an ES module.
 */
export function backgroundChrome(known: Record<string, unknown>, log: Logger): Record<string, unknown> {
  const fallbacks = new Map<string, object>();
  return new Proxy(known, {
    get(target, property) {
      if (typeof property === "symbol" || property in target || !/^[a-z][a-zA-Z\d]*$/.test(property) || property === "then" || property === "toJSON") return Reflect.get(target, property);
      let namespace = fallbacks.get(property);
      if (!namespace) fallbacks.set(property, (namespace = withFallback(log, property, {}, "all")));
      return namespace;
    },
  });
}

/**
 * The background's own location, not the tab's, as Chrome gives it: libraries tell a background from a content script by
 * location.pathname. Its service worker's script, its page, or _generated_background_page.html for background scripts.
 * On a web page a chrome-extension: URL's origin is "null", so origin is spelled out.
 */
export function backgroundLocation(id: string, background: { worker: boolean; entry: string }) {
  const page = background.worker || background.entry.endsWith(".html") ? background.entry : "_generated_background_page.html";
  const url = new URL(`chrome-extension://${id}/${page}`);
  return { href: url.href, origin: `chrome-extension://${id}`, protocol: url.protocol, host: url.host, hostname: url.hostname, port: "", pathname: url.pathname, search: "", hash: "", toString: () => url.href };
}
