// The background (spec §5.4): runs on the leader tab only, from the top, once per page. Before its code runs, the leader
// checks install and session state and loads localStorage; after, it fires the service-worker events and
// runtime.onInstalled / onStartup. A leader that steps down pauses: messages and events stop reaching the background's
// listeners (its timers keep running, a ceiling the spec accepts); if it leads again, it resumes without running the
// code a second time.
import type { Assets } from "./assets.ts";
import { createEvent, createLogger, method, readLastError, withFallback, type Logger } from "./chrome.ts";
import type { BackgroundCode, RuntimeConfig } from "./config.ts";
import type { Gm } from "./gm.ts";
import { createBackgroundGlobal } from "./global.ts";
import { keys } from "./keys.ts";
import { checkLifecycle } from "./lifecycle.ts";
import { createLocalStorage } from "./local-storage.ts";
import type { Messaging } from "./messaging.ts";
import { REGISTRY_TIMING } from "./registry.ts";

export type BackgroundDeps = {
  config: RuntimeConfig;
  code: BackgroundCode;
  gm: Gm;
  log: Logger;
  assets: Assets;
  i18n: object;
  storage: object;
  tabs: object;
  messaging: Messaging;
};

const platform = () => {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "win" : /Mac OS X/.test(ua) ? "mac" : /CrOS/.test(ua) ? "cros" : /Android/.test(ua) ? "android" : "linux";
  return { os, arch: /arm|aarch64/i.test(ua) ? "arm64" : "x86-64", nacl_arch: "x86-64" };
};

export async function startBackground(deps: BackgroundDeps): Promise<{ pause(): void; resume(): void }> {
  const { config, gm, log, assets, messaging } = deps;
  const background = config.background;
  if (!background) throw new Error("startBackground: this extension has no background");
  const lifecycle = await checkLifecycle(gm, config.ns, String((config.manifest as { version?: unknown }).version ?? ""));
  const localStorage = await createLocalStorage(gm, config.ns, log);
  let active = true;
  // While it leads, the session stamp stays fresh, so a new leader in this browser session doesn't fire onStartup.
  setInterval(() => {
    if (active) void gm.setValue(keys(config.ns).session, { t: Date.now() });
  }, REGISTRY_TIMING.heartbeatMs);

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
    getPlatformInfo: method(log, async () => platform()),
    setUninstallURL: method(log, async () => {}),
  }, "all");
  const extension = withFallback(log, "extension", {
    getURL,
    inIncognitoContext: false,
    get lastError() {
      return readLastError();
    },
  }, "all");
  const known: Record<string, object> = {
    runtime,
    storage: deps.storage,
    i18n: deps.i18n,
    tabs: withFallback(log, "tabs", deps.tabs, "all"),
    extension,
  };
  // The background has every API the manifest asks for. Ones this version doesn't implement fail with a named error when
  // used, so top-level code that sets them up (chrome.alarms.create(...)) doesn't stop the rest of the background.
  const fallbacks = new Map<string, object>();
  const chrome = new Proxy(known, {
    get(target, property) {
      if (typeof property === "symbol" || property in target || property === "then" || property === "toJSON") return Reflect.get(target, property);
      let namespace = fallbacks.get(property);
      if (!namespace) fallbacks.set(property, (namespace = withFallback(log, property, {}, "all")));
      return namespace;
    },
  });
  const importScripts = () => {
    throw new Error("ext2userscript: importScripts works only with string literals, which are inlined when the extension is converted");
  };
  const { global, fire } = createBackgroundGlobal({ chrome, browser: chrome, importScripts, localStorage });
  try {
    deps.code(
      chrome,
      chrome,
      global,
      global,
      // A service worker has no window or document; code that checks for them must see that.
      background.worker ? undefined : global,
      background.worker ? undefined : document,
      importScripts,
      localStorage,
      { url: `chrome-extension://${config.id}/${background.entry}` },
    )();
  } catch (error) {
    createLogger(`${config.name} background`).error(error);
  }
  messaging.setBackgroundReady(true);
  setTimeout(() => {
    // A service worker gets install and activate when the extension is installed or updated, as in Chrome.
    if (background.worker && lifecycle.installed) {
      fire("install");
      fire("activate");
    }
    if (lifecycle.installed) onInstalled.dispatch(lifecycle.installed);
    if (lifecycle.startup) onStartup.dispatch();
  });
  return {
    pause: () => {
      active = false;
      messaging.setBackgroundReady(false);
    },
    resume: () => {
      active = true;
      messaging.setBackgroundReady(true);
    },
  };
}
