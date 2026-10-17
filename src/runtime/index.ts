// The runtime's entry point (spec §5). runtime-node.ts bundles this file to an IIFE named __x2uRuntime, and every
// userscript calls __x2uRuntime.start(config, code, background, injectables, pages) once per page.
// Content scripts start at once, so document_start stays early; joining the other tabs (registry, bus, election) is
// asynchronous, and messages sent before it finishes wait in the router.
import { createAssets } from "./assets.ts";
import { startBackground } from "./background.ts";
import { createLogger, readLastError, withFallback } from "./chrome.ts";
import type { BackgroundCode, GroupCode, InjectableCode, PageCode, PageKind, RuntimeConfig } from "./config.ts";
import { runContent, withGlobals } from "./content.ts";
import { leaderOf, startElection } from "./elect.ts";
import { createGm } from "./gm.ts";
import { createI18n } from "./i18n.ts";
import { tabIdentity } from "./identity.ts";
import { showMenus } from "./menus.ts";
import { createMessaging } from "./messaging.ts";
import { EXECUTE_ACTION, listenForCommands } from "./commands.ts";
import { createLocalStorage } from "./local-storage.ts";
import { createPages } from "./pages.ts";
import { createNetwork } from "./net.ts";
import { createInjector } from "./scripting.ts";
import { startRegistry, type Registry, type TabInfo, type TabState } from "./registry.ts";
import { startBus } from "./bus.ts";
import { createStorage } from "./storage.ts";
import { createTabs } from "./tabs.ts";

export function start(
  config: RuntimeConfig,
  code: readonly GroupCode[],
  background: BackgroundCode | null = null,
  injectables: InjectableCode = {},
  pageCode: Partial<Record<PageKind, PageCode>> = {},
): void {
  const log = createLogger(config.name);
  try {
    const gm = createGm();
    if (!gm.caps.valueListeners) {
      log.error(`${gm.handler} isn't supported: ext2userscript supports Tampermonkey and Violentmonkey`);
      return;
    }
    const frame = window.top !== window;
    // Each namespace fakes the content-script members Chrome has and this version doesn't implement yet.
    const i18n = withFallback(log, "i18n", createI18n(config, log), ["detectLanguage"]);
    const assets = createAssets(config.assets, config.id, i18n.getMessage, log);
    const getURL = (path: string) => assets.url(path);
    const storage = createStorage(gm, config.ns, log);
    let registry: Registry | undefined;
    let tabs: ReturnType<typeof createTabs> | undefined;
    let pages: ReturnType<typeof createPages> | undefined;
    let leading = false;
    // One copy of the extension's localStorage per tab, for its background and its pages.
    let local: Promise<Storage> | undefined;
    const localStorage = () => (local ??= createLocalStorage(gm, config.ns, log));
    let activeAt = document.visibilityState === "visible" ? Date.now() : 0;
    const state = (): TabState => ({
      url: location.href,
      title: document.title,
      frame,
      active: document.visibilityState === "visible",
      activeAt,
      status: document.readyState === "complete" ? "complete" : "loading",
      ...(pages?.current() ? { page: pages.current() } : {}),
    });

    const messaging = createMessaging({
      extensionId: config.id,
      log,
      leader: () => (registry ? leaderOf(registry) : undefined),
      exists: (id) => registry !== undefined && (id === registry.me || registry.live().some((tab) => tab.id === id)),
      sender: (from) =>
        from === "background"
          ? { id: config.id, url: `chrome-extension://${config.id}/${config.background?.entry ?? ""}`, origin: `chrome-extension://${config.id}` }
          : from === "page"
            ? { id: config.id, url: pages?.url(), origin: `chrome-extension://${config.id}` }
            : { id: config.id, url: location.href, origin: location.origin, frameId: frame ? 1 : 0, ...(tabs ? { tab: tabs.selfTab() } : {}) },
      // This tab's page (unless it is the sender), and every other tab's.
      pages: (from) =>
        registry ? [...(pages?.current() && from !== "page" ? [registry.me] : []), ...registry.live().flatMap((tab) => (tab.page ? [tab.id] : []))] : [],
      control: async (op, args) => {
        const injected = injector.run(op, args);
        if (injected) return injected;
        if (!tabs) throw new Error("this tab isn't ready");
        return tabs.control(op, args);
      },
    });
    // Without a background, a message for it fails at once instead of waiting for one to start.
    if (!background) messaging.setBackgroundReady(true);
    // The manifest's keyboard shortcuts, in every frame: a shortcut pressed before this page has joined waits for it.
    // _execute_action opens the popup right here, when there is one.
    else {
      listenForCommands(window, config, (type, data) => {
        if (!EXECUTE_ACTION.has((data as { name: string }).name) || !config.pages?.popup) return messaging.emit(type, data);
        if (!frame) void pages?.open("popup");
        return Promise.resolve();
      }, log);
    }

    const runtime = withFallback(log, "runtime", {
      id: config.id,
      get lastError() {
        return readLastError();
      },
      getURL,
      getManifest: () => structuredClone(config.manifest),
      ...messaging.runtime("content"),
    }, []);
    const extension = withFallback(log, "extension", {
      getURL,
      inIncognitoContext: false,
      get lastError() {
        return readLastError();
      },
    }, ["sendRequest", "onRequest"]);
    const dom = withFallback(log, "dom", {}, ["openOrClosedShadowRoot"]);
    // The namespaces Chrome gives content scripts. chrome.tabs and the rest are undefined there, as in Chrome.
    const network = createNetwork({
      gm,
      asset: assets.file,
      assetPathOf: assets.pathOf,
      extensionId: config.id,
      // Relative URLs resolve as the page's own requests do, against its <base href> when it has one.
      base: () => document.baseURI,
      cookies: "when-included",
      origin: location.origin,
      hosts: [...(config.permissions?.origins ?? []), ...(config.permissions?.optionalOrigins ?? [])],
      fetch: globalThis.fetch.bind(globalThis),
      XMLHttpRequest: globalThis.XMLHttpRequest,
    });
    const contentChrome = { runtime, storage, i18n, extension, dom };
    // Scripts and styles the background's scripting API sends this page.
    const injector = createInjector({ gm, chrome: contentChrome, network, injectables, withGlobals, log });
    runContent(config, code, { gm, chrome: contentChrome, assets, log, network });

    void (async () => {
      const me = await tabIdentity(gm, config.ns, frame);
      const joined = await startRegistry(gm, config.ns, me, state);
      registry = joined;
      const pageTabs = createTabs({ gm, registry: joined, messaging, log, dispatching: () => leading });
      tabs = pageTabs;
      let handle: { pause(): void; resume(): void; global: unknown } | undefined;
      if (!frame && config.pages) {
        pages = createPages({
          config,
          code: pageCode,
          gm,
          log,
          assets,
          i18n,
          storage,
          tabs: pageTabs.api,
          messaging,
          localStorage,
          backgroundGlobal: () => (leading ? handle?.global : undefined),
          // Other tabs learn at once which page is open here, so their messages reach it.
          changed: () => void joined.touch(),
        });
      }
      const bus = await startBus(gm, config.ns, joined, messaging.handle);
      messaging.attach((to, wire) => bus.send(to, wire));
      joined.onRemoved((id) => messaging.peerGone(id));

      // This page's own changes: other tabs learn them from its heartbeat; its own background learns them here.
      let last: TabInfo = { ...joined.self(), ts: Date.now() };
      const changed = () => {
        const now: TabInfo = { ...joined.self(), ts: Date.now() };
        pageTabs.updated(now, last);
        last = now;
        void joined.touch();
      };
      addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") activeAt = Date.now();
        changed();
      });
      addEventListener("popstate", changed);
      addEventListener("hashchange", changed);
      // status "complete" (a load that already happened reaches other tabs with the next heartbeat).
      addEventListener("load", changed);
      addEventListener("pagehide", () => void joined.leave());
      addEventListener("pageshow", (event) => {
        if (event.persisted) void joined.rejoin();
      });

      if (frame || (!background && !config.pages)) return;
      // The background's context-menu items and toolbar button, and the extension's pages, as this tab's menu commands.
      void showMenus({ gm, ns: config.ns, log, config, tabId: () => joined.me, emit: messaging.emit, open: (kind) => void pages?.open(kind) });
      if (!background) return;
      let starting = false;
      startElection(joined, {
        acquire: () => {
          leading = true;
          if (handle) return handle.resume();
          if (starting) return;
          starting = true;
          startBackground({ config, code: background, gm, log, assets, i18n, storage, tabs: pageTabs.api, messaging, localStorage }).then(
            (started) => {
              handle = started;
              if (!leading) started.pause();
            },
            (error: unknown) => log.error("the background couldn't start:", error),
          );
        },
        lose: () => {
          leading = false;
          handle?.pause();
        },
      });
    })().catch((error: unknown) => log.error("couldn't join the other tabs:", error));
  } catch (error) {
    log.error("couldn't start:", error);
  }
}
