// The popup and options pages at runtime (spec §6): one open at a time per tab, in the modal of ui.ts. Each opening
// builds the page anew, gives its code a chrome object of its own, and takes it all down on close: the listeners the page
// added, and the ports it opened, which the background sees disconnect.
// - runtime, storage, i18n, extension, tabs, scripting, windows and cookies work in the page, as in the background.
// - alarms, menus, the toolbar button, commands, notifications and permissions keep their state in the leader's
//   background, so a page's calls go there (messaging's "call" event); their events don't fire in the page.
import type { Assets } from "./assets.ts";
import { createEvent, method, platformInfo, readLastError, RUNTIME_ENUMS, withFallback, type Logger } from "./chrome.ts";
import { createCookies } from "./cookies.ts";
import type { PageCode, PageKind, RuntimeConfig } from "./config.ts";
import type { Gm } from "./gm.ts";
import { proxyGlobal } from "./global.ts";
import type { Messaging, Port } from "./messaging.ts";
import { createNetwork } from "./net.ts";
import { createScripting } from "./scripting.ts";
import { buildPage, finishLoading, openModal, type Modal } from "./ui.ts";
import { createWindows } from "./windows.ts";

/** Namespaces whose state the leader's background keeps: a page calls them there. */
export const CALLED_IN_BACKGROUND = new Set(["alarms", "contextMenus", "menus", "action", "browserAction", "pageAction", "commands", "notifications", "permissions"]);

export type PagesDeps = {
  config: RuntimeConfig;
  code: Partial<Record<PageKind, PageCode>>;
  gm: Gm;
  log: Logger;
  assets: Assets;
  i18n: object;
  storage: object;
  /** chrome.tabs as the background has it. */
  tabs: object;
  messaging: Messaging;
  localStorage(): Promise<Storage>;
  /** The background's global object when this tab leads and its background has started, for getBackgroundPage. */
  backgroundGlobal(): unknown;
  /** The page open in this tab changed (registry state). */
  changed(kind: PageKind | undefined): void;
};

export function createPages(deps: PagesDeps) {
  const { config, log } = deps;
  let current: { kind: PageKind; modal: Modal } | undefined;
  let opening: Promise<void> | undefined;

  const open = async (kind: PageKind): Promise<void> => {
    const page = config.pages?.[kind];
    if (!page) throw new Error(`ext2userscript: this extension has no ${kind} page`);
    await opening;
    if (current?.kind === kind) return current.modal.win.focus();
    current?.modal.close();
    const cleanups: Array<() => void> = [];
    const modal = openModal(kind, config.name, () => {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch (error) {
          log.error(error);
        }
      }
      if (current?.modal === modal) {
        current = undefined;
        deps.changed(undefined);
      }
    });
    current = { kind, modal };
    deps.changed(kind);
    opening = (async () => {
      const url = `chrome-extension://${config.id}/${page.path}`;
      const localStorage = await deps.localStorage();
      await buildPage(modal.doc, page, { gm: deps.gm, assets: deps.assets });
      const network = createNetwork({
        gm: deps.gm,
        asset: deps.assets.file,
        assetPathOf: deps.assets.pathOf,
        extensionId: config.id,
        base: () => url,
        cookies: "unless-omitted",
        origin: location.origin,
        hosts: [...(config.permissions?.origins ?? []), ...(config.permissions?.optionalOrigins ?? [])],
        fetch: globalThis.fetch.bind(globalThis),
        XMLHttpRequest: globalThis.XMLHttpRequest,
      });
      const chrome = scopeToPage(pageChrome(deps, open), cleanups);
      const global = proxyGlobal(modal.win, { chrome, browser: chrome, localStorage, fetch: network.fetch, XMLHttpRequest: network.XMLHttpRequest, close: () => modal.close(), frameElement: null, opener: null }, [
        "window", "self", "globalThis", "top", "parent", "frames",
      ]);
      const code = deps.code[kind];
      try {
        code?.(chrome, chrome, global, global, global, modal.doc, modal.win.location, modal.win.history, localStorage, network.fetch, network.XMLHttpRequest, global.setTimeout, global.setInterval, global.clearTimeout, global.clearInterval, modal.win.DOMParser, `chrome-extension://${config.id}/`)();
      } catch (error) {
        log.error(`the ${kind} page's code failed:`, error);
      }
      finishLoading(modal.win, modal.doc);
    })().catch((error: unknown) => {
      log.error(`the ${kind} page couldn't open:`, error);
      modal.close();
    });
    await opening;
  };

  return {
    open,
    /** The page open in this tab, if any. */
    current: (): PageKind | undefined => current?.kind,
    /** Where the open page lives, for messages it sends (sender.url). */
    url: () => (current ? `chrome-extension://${config.id}/${config.pages?.[current.kind]?.path ?? ""}` : undefined),
    close: () => current?.modal.close(),
  };
}

/** The page's chrome object: what an extension page has, as the background has it (spec §5.2). */
function pageChrome(deps: PagesDeps, open: (kind: PageKind) => Promise<void>): object {
  const { config, log, messaging } = deps;
  const getURL = (path: string) => deps.assets.url(path);
  const never = () => createEvent<() => void>(log).event;
  const backgroundPage = () => {
    const global = deps.backgroundGlobal();
    if (global === undefined) throw new Error("ext2userscript: the background runs in another tab, so its page can't be reached from here");
    return global;
  };
  const runtime = withFallback(log, "runtime", {
    id: config.id,
    get lastError() {
      return readLastError();
    },
    getURL,
    getManifest: () => structuredClone(config.manifest),
    ...messaging.runtime("page"),
    // In Chrome these fire in the background only.
    onInstalled: never(),
    onStartup: never(),
    onSuspend: never(),
    getPlatformInfo: method(log, async () => platformInfo()),
    getBackgroundPage: method(log, async () => backgroundPage()),
    // The options page replaces the popup in the same modal.
    openOptionsPage: method(log, () => open("options")),
    ...structuredClone(RUNTIME_ENUMS),
  }, "all");
  const extension = withFallback(log, "extension", {
    getURL,
    getBackgroundPage: () => {
      try {
        return backgroundPage();
      } catch {
        return null;
      }
    },
    // ponytail: no views, as other pages' windows live in other tabs; the page's own window when Chrome would list it.
    getViews: () => [],
    inIncognitoContext: false,
    get lastError() {
      return readLastError();
    },
  }, "all");
  const tabs = deps.tabs as { query(query: object): Promise<Array<{ id: number }>> } & Record<string, unknown>;
  const scripting = createScripting({ messaging, assets: deps.assets, log, currentTab: async () => (await tabs.query({ active: true }))[0]?.id });
  const known: Record<string, object> = {
    runtime,
    storage: deps.storage,
    i18n: deps.i18n,
    extension,
    tabs: withFallback(log, "tabs", { ...tabs, ...scripting.tabs, ...messaging.tabsFrom("page") }, "all"),
    scripting: withFallback(log, "scripting", scripting.scripting, "all"),
    windows: withFallback(log, "windows", createWindows(deps.tabs as Parameters<typeof createWindows>[0], log), "all"),
    cookies: withFallback(log, "cookies", createCookies(deps.gm, log), "all"),
  };
  for (const namespace of CALLED_IN_BACKGROUND) known[namespace] = inBackground(namespace, messaging, log);
  const fallbacks = new Map<string, object>();
  return new Proxy(known, {
    get(target, property) {
      if (typeof property === "symbol" || property in target || property === "then" || property === "toJSON") return Reflect.get(target, property);
      let namespace = fallbacks.get(property);
      if (!namespace) fallbacks.set(property, (namespace = withFallback(log, property, {}, "all")));
      return namespace;
    },
  });
}

/** A namespace whose methods run in the leader's background; its events never fire in the page. */
function inBackground(namespace: string, messaging: Messaging, log: Logger): object {
  const members = new Map<string, unknown>();
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string" || property === "then" || property === "toJSON") return undefined;
      let member = members.get(property);
      if (member === undefined) {
        member = /^on[A-Z]/.test(property)
          ? {
              addListener: () => log.once(`page:${namespace}.${property}`, `ext2userscript: chrome.${namespace}.${property} fires in the background only; the page's listener will never be called`),
              removeListener: () => {},
              hasListener: () => false,
              hasListeners: () => false,
            }
          : method(log, (...args: unknown[]) => messaging.emit("call", { namespace, member: property, args }, "page"));
        members.set(property, member);
      }
      return member;
    },
  });
}

/**
 * The page's view of its chrome object: listeners it adds to events are removed, and ports it opens disconnected, when
 * it closes. Namespaces and events are wrapped once each, so they compare equal across reads.
 */
export function scopeToPage(chrome: object, cleanups: Array<() => void>): object {
  const wrapped = new WeakMap<object, object>();
  // Own properties only: a namespace with fallbacks answers every name, addListener included.
  const isEvent = (value: object): value is { addListener(fn: unknown): void; removeListener(fn: unknown): void } =>
    Object.prototype.hasOwnProperty.call(value, "addListener") && Object.prototype.hasOwnProperty.call(value, "removeListener");
  const isPort = (value: unknown): value is Port => typeof value === "object" && value !== null && typeof (value as Port).disconnect === "function" && "onDisconnect" in value;
  const wrap = (value: object): object => {
    let view = wrapped.get(value);
    if (view) return view;
    view = isEvent(value)
      ? new Proxy(value, {
          get(target, property, receiver) {
            if (property !== "addListener") return Reflect.get(target, property, receiver);
            return (listener: unknown) => {
              target.addListener(listener);
              cleanups.push(() => target.removeListener(listener));
            };
          },
        })
      : new Proxy(value, {
          get(target, property, receiver) {
            const member = Reflect.get(target, property, receiver);
            if (property === "connect" && typeof member === "function") {
              return (...args: unknown[]) => {
                const port: unknown = member.apply(target, args);
                if (isPort(port)) cleanups.push(() => port.disconnect());
                return port;
              };
            }
            return member !== null && typeof member === "object" ? wrap(member) : member;
          },
        });
    wrapped.set(value, view);
    return view;
  };
  return wrap(chrome);
}
