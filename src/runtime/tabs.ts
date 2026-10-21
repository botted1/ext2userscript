// chrome.tabs for the background (spec §5.2), from the tab registry: every page where the userscript runs is a tab,
// in one synthetic window (id 1). Events come from registry changes; update, reload and remove ask the target page
// to act on itself; create opens a tab with gm.openInTab and waits for it to join.
import { createEvent, method, type Logger } from "./chrome.ts";
import type { Gm, TabControl } from "./gm.ts";
import { urlMatches } from "./match.ts";
import type { Messaging } from "./messaging.ts";
import type { Registry, TabInfo } from "./registry.ts";

export type ChromeTab = {
  id: number;
  index: number;
  windowId: number;
  active: boolean;
  highlighted: boolean;
  pinned: boolean;
  incognito: boolean;
  discarded: boolean;
  autoDiscardable: boolean;
  groupId: number;
  status: "loading" | "complete";
  url: string;
  title: string;
};

export const WINDOW_ID = 1;
/** How long tabs.create waits for the new page to join the registry. */
const CREATE_WAIT_MS = 5_000;
/**
 * A same-origin navigation keeps the tab id, so a tab that rejoins this soon after leaving was navigating, which Chrome
 * reports as onUpdated, not onRemoved and onCreated. onRemoved waits this long for a closed tab.
 * ponytail: a page slower than this to start its userscript reports remove plus create, as a cross-origin one does.
 */
const REJOIN_MS = 5_000;

type Query = { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean; windowId?: number; url?: string | string[]; title?: string; index?: number; status?: string };

/** The Tab object Chrome hands out, for one registry entry. */
export function toChromeTab(info: Pick<TabInfo, "id" | "url" | "title" | "active" | "status">, index: number): ChromeTab {
  return {
    id: info.id,
    index,
    windowId: WINDOW_ID,
    active: info.active,
    highlighted: info.active,
    pinned: false,
    incognito: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    status: info.status ?? "complete",
    url: info.url,
    title: info.title,
  };
}

export function createTabs(deps: { gm: Gm; registry: Registry; messaging: Messaging; log: Logger; dispatching(): boolean; rejoinMs?: number }) {
  const { gm, registry, messaging, log } = deps;
  const opened = new Map<number, TabControl>();
  const onCreated = createEvent<(tab: ChromeTab) => void>(log);
  const onRemoved = createEvent<(tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void>(log);
  const onUpdated = createEvent<(tabId: number, change: Record<string, unknown>, tab: ChromeTab) => void>(log);
  const onActivated = createEvent<(info: { tabId: number; windowId: number }) => void>(log);

  /** Every tab, this page included, oldest first; frames aren't tabs. */
  const all = (): ChromeTab[] => {
    const me = registry.self();
    const infos = [...registry.live(), ...(me.present ? [{ ...me, ts: Date.now() }] : [])].filter((tab) => !tab.frame).sort((a, b) => a.since - b.since || a.id - b.id);
    return infos.map((info, index) => toChromeTab(info, index));
  };
  const find = (tabId: number) => {
    const tab = all().find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  };
  /** The most recently activated visible tab: what Chrome calls the active tab of the current window. */
  const current = () => {
    const me = registry.self();
    const infos = [...registry.live(), me].filter((tab) => !tab.frame && tab.active);
    return infos.sort((a, b) => b.activeAt - a.activeAt)[0]?.id;
  };
  const emit = (dispatch: () => void) => {
    if (deps.dispatching()) dispatch();
  };

  const leaving = new Map<number, ReturnType<typeof setTimeout>>();
  registry.onAdded((info) => {
    if (info.frame) return;
    const left = leaving.get(info.id);
    if (left === undefined) return emit(() => onCreated.dispatch(find(info.id)));
    clearTimeout(left);
    leaving.delete(info.id);
    emit(() => onUpdated.dispatch(info.id, { status: info.status ?? "complete", url: info.url }, find(info.id)));
  });
  registry.onRemoved((id) => {
    leaving.set(id, setTimeout(() => {
      leaving.delete(id);
      opened.delete(id);
      emit(() => onRemoved.dispatch(id, { windowId: WINDOW_ID, isWindowClosing: false }));
    }, deps.rejoinMs ?? REJOIN_MS));
  });
  /** Also called for this page's own changes, which the registry doesn't report to itself. */
  const updated = (info: TabInfo, previous: TabInfo) => {
    if (info.frame) return;
    const change: Record<string, unknown> = {};
    if (info.url !== previous.url) change.url = info.url;
    if (info.title !== previous.title) change.title = info.title;
    if (Object.keys(change).length > 0 || info.status !== previous.status) {
      emit(() => onUpdated.dispatch(info.id, { status: info.status ?? "complete", ...change }, find(info.id)));
    }
    if (info.active && info.activeAt !== previous.activeAt) emit(() => onActivated.dispatch({ tabId: info.id, windowId: WINDOW_ID }));
  };
  registry.onUpdated(updated);

  const create = async (properties: { url?: string; active?: boolean } = {}): Promise<ChromeTab> => {
    const url = properties.url ?? "about:blank";
    if (!/^[a-z][a-z\d+.-]*:/i.test(url)) throw new Error(`ext2userscript: tabs.create can't open extension pages (${url}) yet`);
    const started = Date.now();
    const control = await gm.openInTab(url, { active: properties.active ?? true });
    // The new page's id is its own choice, so wait for a tab with this URL to join; a page the userscript doesn't run on never will.
    const wanted = new URL(url, location.href).href;
    const joined = await new Promise<TabInfo | undefined>((resolve) => {
      let settled = false; // registry listeners can't be removed, so a settled check stays a no-op
      const timer = setTimeout(() => {
        settled = true;
        resolve(undefined);
      }, CREATE_WAIT_MS);
      registry.onAdded((info) => {
        if (settled || info.frame || info.since < started - 1_000 || info.url !== wanted) return;
        settled = true;
        clearTimeout(timer);
        resolve(info);
      });
    });
    if (!joined) return { ...toChromeTab({ id: -1, url, title: "", active: properties.active ?? true }, -1) };
    opened.set(joined.id, control);
    return find(joined.id);
  };

  const remove = async (tabIds: number | number[]) => {
    for (const id of typeof tabIds === "number" ? [tabIds] : tabIds) {
      const control = opened.get(id);
      if (control) control.close();
      else await messaging.control(id, "close", null);
    }
  };

  return {
    /** This page as sender.tab. A frame isn't a tab: it reports itself, so a reply or tabs.sendMessage still reaches it. */
    selfTab: (): ChromeTab => {
      const me = registry.self();
      return me.frame ? toChromeTab(me, -1) : find(me.id);
    },
    /** The control requests this page answers (see messaging.ts). */
    control: async (op: string, args: unknown): Promise<unknown> => {
      if (op === "close") window.close();
      else if (op === "reload") location.reload();
      else if (op === "navigate") location.href = String((args as { url: string }).url);
      else throw new Error(`unknown tab control ${op}`);
      return null;
    },
    updated,
    api: {
      TAB_ID_NONE: -1,
      query: method(log, async (query: Query = {}) =>
        all().filter((tab) => {
          if (query.active !== undefined && (tab.id === current()) !== query.active) return false;
          if (query.windowId !== undefined && query.windowId !== WINDOW_ID && query.windowId !== -2) return false;
          if (query.url !== undefined && !urlMatches(tab.url, typeof query.url === "string" ? [query.url] : query.url)) return false;
          if (query.title !== undefined && tab.title !== query.title) return false;
          if (query.index !== undefined && tab.index !== query.index) return false;
          if (query.status !== undefined && tab.status !== query.status) return false;
          return true;
        }),
      ),
      get: method(log, async (tabId: number) => find(tabId)),
      // The background isn't a tab.
      getCurrent: method(log, async () => undefined),
      sendMessage: messaging.tabs.sendMessage,
      connect: messaging.tabs.connect,
      create: method(log, create),
      update: method(log, async (...args: unknown[]) => {
        // update(properties), update(tabId, properties), or update(undefined, properties) for the current tab.
        const [tabId, properties] = typeof args[0] === "object" && args[0] !== null
          ? [current(), args[0] as { url?: string }]
          : [typeof args[0] === "number" ? args[0] : current(), args[1] as { url?: string }];
        if (tabId === undefined) throw new Error("No current tab");
        if (properties?.url) await messaging.control(tabId, "navigate", { url: properties.url });
        return find(tabId);
      }),
      reload: method(log, async (tabId?: number) => {
        const target = typeof tabId === "number" ? tabId : current();
        if (target !== undefined) await messaging.control(target, "reload", null);
      }),
      remove: method(log, remove),
      onCreated: onCreated.event,
      onRemoved: onRemoved.event,
      onUpdated: onUpdated.event,
      onActivated: onActivated.event,
    },
  };
}
