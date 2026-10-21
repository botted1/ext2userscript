// chrome.contextMenus and the toolbar button (spec §5.2): a userscript manager has no context menu and no toolbar, so
// both become the manager's menu commands, which every tab registers for itself.
// - createMenus (the background) keeps the items and the button's state in one GM value, and turns clicks into
//   contextMenus.onClicked and action.onClicked.
// - showMenus (every top frame) registers a command per item that a page can show, and tells the background about a click.
// Ceilings: the menu is flat (a child's caption names its parent); items only for links, images, media or editable
// fields aren't shown, as there is nothing to click them on; onClicked gets the page's URL and any selected text, but no
// link or media details; the button's badge shows in its caption, and its icon and colours don't show at all.
import { callWithLastError, createEvent, method, type Logger } from "./chrome.ts";
import type { PageKind, RuntimeConfig } from "./config.ts";
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";
import { urlMatches } from "./match.ts";

export type MenuItem = {
  id: string;
  title: string;
  type: "normal" | "checkbox" | "radio" | "separator";
  contexts: string[];
  checked: boolean;
  enabled: boolean;
  visible: boolean;
  parentId?: string;
  documentUrlPatterns?: string[];
  /** An item created without an id: it belongs to the page that created it, a persistent background page. */
  generated?: boolean;
};

/**
 * What the toolbar button shows; undefined fields fall back to the manifest. tabs holds what was set for one tab (by
 * tabId), which wins there. Ceiling: a tab keeps its settings across a same-origin navigation, which Chrome resets.
 */
export type ActionState = { title?: string; badge?: string; enabled: boolean; popup?: string; tabs?: Record<string, Partial<Omit<ActionState, "tabs">>> };

export type MenuState = { items: MenuItem[]; action: ActionState };

export type MenuClick = { menuItemId: string; pageUrl: string; selectionText?: string };

/** Contexts a page's menu command can stand for: the page itself, its selection, or the toolbar button. */
const SHOWN_CONTEXTS = new Set(["all", "page", "frame", "selection", "action", "browser_action", "page_action"]);

const ENUMS = {
  ContextType: { ALL: "all", PAGE: "page", FRAME: "frame", SELECTION: "selection", LINK: "link", EDITABLE: "editable", IMAGE: "image", VIDEO: "video", AUDIO: "audio", LAUNCHER: "launcher", BROWSER_ACTION: "browser_action", PAGE_ACTION: "page_action", ACTION: "action" },
  ItemType: { NORMAL: "normal", CHECKBOX: "checkbox", RADIO: "radio", SEPARATOR: "separator" },
  ACTION_MENU_TOP_LEVEL_LIMIT: 6,
};

type CreateProperties = Partial<Omit<MenuItem, "generated">> & { onclick?: (info: unknown, tab: unknown) => void };

export async function createMenus(deps: { gm: Gm; ns: string; log: Logger; config: RuntimeConfig; persistent: boolean }) {
  const { gm, log } = deps;
  const key = keys(deps.ns).menus;
  const onClicked = createEvent<(info: unknown, tab: unknown) => void>(log);
  const onActionClicked = createEvent<(tab: unknown) => void>(log);
  const onclick = new Map<string, (info: unknown, tab: unknown) => void>();
  const stored = await gm.getValue<MenuState>(key);
  // A page action shows only on the tabs it is shown on; a browser action or action shows everywhere until disabled.
  const state: MenuState = { items: Array.isArray(stored?.items) ? stored.items : [], action: stored?.action ?? { enabled: deps.config.action?.key !== "page_action" } };
  // A persistent background page creates its menu every time it starts, as Chrome starts it with an empty one.
  if (deps.persistent) state.items = [];
  // Items without an id lived with the page that made them.
  state.items = state.items.filter((item) => !item.generated);
  let counter = 0;
  const save = () => gm.setValue(key, state).catch((error: unknown) => log.error(error));
  void save();

  const find = (id: unknown) => state.items.find((item) => item.id === String(id));
  /** Runs a menu change; a failure goes to the callback as lastError, or rejects when there is none. */
  const change = (callback: unknown, run: () => void): Promise<void> | undefined => {
    try {
      run();
    } catch (error) {
      if (typeof callback === "function") {
        callWithLastError(log, error as Error, () => callback());
        return undefined;
      }
      return Promise.reject(error);
    }
    const saved = save();
    if (typeof callback === "function") void saved.then(() => callback());
    return typeof callback === "function" ? undefined : saved;
  };

  const create = (properties: CreateProperties = {}, callback?: () => void): string => {
    const id = properties.id === undefined ? String(++counter) : String(properties.id);
    // create returns the id, not a promise, so a failure without a callback is an unchecked lastError, as in Chrome.
    void change(callback ?? (() => {}), () => {
      if (find(id)) throw new Error(`Cannot create item with duplicate id ${id}`);
      if (properties.parentId !== undefined && !find(properties.parentId)) throw new Error(`Cannot find menu item with id ${properties.parentId}`);
      state.items.push({
        id,
        title: String(properties.title ?? ""),
        type: properties.type ?? "normal",
        contexts: properties.contexts ?? ["page"],
        checked: properties.checked === true,
        enabled: properties.enabled !== false,
        visible: properties.visible !== false,
        ...(properties.parentId === undefined ? {} : { parentId: String(properties.parentId) }),
        ...(properties.documentUrlPatterns ? { documentUrlPatterns: properties.documentUrlPatterns } : {}),
        ...(properties.id === undefined ? { generated: true } : {}),
      });
      if (properties.onclick) onclick.set(id, properties.onclick);
    });
    return id;
  };

  const update = (id: unknown, properties: CreateProperties = {}, callback?: () => void) =>
    change(callback, () => {
      const item = find(id);
      if (!item) throw new Error(`Cannot find menu item with id ${String(id)}`);
      const { onclick: handler, id: _id, ...rest } = properties;
      if (rest.parentId !== undefined) {
        const parent = find(rest.parentId);
        if (!parent) throw new Error(`Cannot find menu item with id ${String(rest.parentId)}`);
        // A cycle would make every tab's menu render walk up its parents forever.
        for (let at: MenuItem | undefined = parent; at; at = at.parentId === undefined ? undefined : find(at.parentId)) {
          if (at === item) throw new Error("Cannot set a menu item to be a child of itself or one of its descendants");
        }
        rest.parentId = parent.id;
      }
      Object.assign(item, rest);
      if (handler) onclick.set(item.id, handler);
    });

  const remove = (id: unknown, callback?: () => void) =>
    change(callback, () => {
      if (!find(id)) throw new Error(`Cannot find menu item with id ${String(id)}`);
      // An item's children go with it.
      const gone = new Set([String(id)]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const item of state.items) if (item.parentId !== undefined && gone.has(item.parentId) && !gone.has(item.id)) (gone.add(item.id), (grew = true));
      }
      state.items = state.items.filter((item) => !gone.has(item.id));
      for (const gid of gone) onclick.delete(gid);
    });

  const removeAll = (callback?: () => void) =>
    change(callback, () => {
      state.items = [];
      onclick.clear();
    });

  const contextMenus = {
    ...ENUMS,
    create,
    update,
    remove,
    removeAll,
    onClicked: onClicked.event,
  };

  /** Sets the button's state, for one tab when tabId is given. */
  const setAction = (patch: Partial<Omit<ActionState, "tabs">>, tabId?: unknown) => {
    if (typeof tabId === "number") {
      state.action.tabs ??= {};
      state.action.tabs[tabId] = { ...state.action.tabs[tabId], ...patch };
    } else {
      Object.assign(state.action, patch);
    }
    return save();
  };
  /** The button's state on one tab, or everywhere when tabId isn't a number. */
  const effective = (tabId?: unknown): ActionState => ({ ...state.action, ...(typeof tabId === "number" ? state.action.tabs?.[tabId] : {}) });
  const defaultTitle = deps.config.action?.title ?? deps.config.name;
  const badgeColors = { background: [0, 0, 0, 0] as unknown, text: [255, 255, 255, 255] as unknown };
  const action = {
    onClicked: onActionClicked.event,
    setTitle: method(log, (details: { title?: string; tabId?: number } = {}) => setAction({ title: details.title ?? undefined }, details.tabId)),
    getTitle: method(log, async (details: { tabId?: number } = {}) => effective(details.tabId).title ?? defaultTitle),
    setBadgeText: method(log, (details: { text?: string; tabId?: number } = {}) => setAction({ badge: details.text || undefined }, details.tabId)),
    getBadgeText: method(log, async (details: { tabId?: number } = {}) => effective(details.tabId).badge ?? ""),
    setBadgeBackgroundColor: method(log, async (details: { color?: unknown } = {}) => void (badgeColors.background = details.color)),
    getBadgeBackgroundColor: method(log, async () => badgeColors.background),
    setBadgeTextColor: method(log, async (details: { color?: unknown } = {}) => void (badgeColors.text = details.color)),
    getBadgeTextColor: method(log, async () => badgeColors.text),
    setIcon: method(log, async () => {}),
    setPopup: method(log, (details: { popup?: string } = {}) => setAction({ popup: details.popup || undefined })),
    getPopup: method(log, async () => state.action.popup ?? ""),
    enable: method(log, (tabId?: number) => setAction({ enabled: true }, tabId)),
    disable: method(log, (tabId?: number) => setAction({ enabled: false }, tabId)),
    isEnabled: method(log, async (tabId?: number) => effective(tabId).enabled),
    // pageAction's names for the same thing.
    show: method(log, (tabId?: number) => setAction({ enabled: true }, tabId)),
    hide: method(log, (tabId?: number) => setAction({ enabled: false }, tabId)),
  };

  return {
    contextMenus,
    action,
    /** A tab's menu command for an item was clicked: checkbox and radio items toggle, then onClicked fires. */
    click(info: MenuClick, tab: unknown) {
      const item = find(info.menuItemId);
      if (!item) return;
      const wasChecked = item.checked;
      if (item.type === "checkbox") item.checked = !item.checked;
      if (item.type === "radio") for (const other of state.items) if (other.type === "radio" && other.parentId === item.parentId) other.checked = other === item;
      if (item.type === "checkbox" || item.type === "radio") void save();
      const data = { ...info, editable: false, ...(item.parentId === undefined ? {} : { parentMenuItemId: item.parentId }), ...(item.type === "checkbox" || item.type === "radio" ? { wasChecked, checked: item.checked } : {}) };
      onclick.get(item.id)?.(data, tab);
      onClicked.dispatch(data, tab);
    },
    /** A tab's command for the toolbar button was clicked. */
    actionClick(tab: unknown) {
      onActionClicked.dispatch(tab);
    },
  };
}

/**
 * Keeps this page's menu commands in step with the background's menu state: one for the toolbar button when it is
 * enabled ("Open <title>" when it has a popup), one for the options page, and one per context-menu item this page can
 * show. emit tells the background about a click; open opens a page here. Top frames only: a manager shows one menu per
 * tab.
 */
export async function showMenus(deps: {
  gm: Gm;
  ns: string;
  log: Logger;
  config: RuntimeConfig;
  tabId(): number | undefined;
  emit(type: string, data: unknown): Promise<unknown>;
  /** Opens the popup or options page in this tab. */
  open(kind: PageKind): void;
}) {
  const { gm, log, config } = deps;
  const key = keys(deps.ns).menus;
  let registered: Array<number | string> = [];

  const render = async (state: MenuState | undefined) => {
    const commands: Array<[caption: string, onClick: () => void]> = [];
    // This tab's own settings for the button win over the ones for every tab.
    const shared = state?.action ?? { enabled: config.action?.key !== "page_action" };
    const tab = deps.tabId();
    const action: ActionState = { ...shared, ...(tab === undefined ? {} : shared.tabs?.[tab]) };
    if (config.action && action.enabled) {
      const title = action.title ?? config.action.title ?? config.name;
      const caption = action.badge ? `${title} (${action.badge})` : title;
      // A button with a popup opens it (spec §6); one without tells the background it was clicked.
      if (config.pages?.popup && (config.action.popup || action.popup)) commands.push([`Open ${caption}`, () => deps.open("popup")]);
      else if (!config.action.popup && !action.popup) commands.push([caption, () => void deps.emit("action-click", null).catch((error: unknown) => log.error(error))]);
    }
    if (config.pages?.options) commands.push([`${config.name} options`, () => deps.open("options")]);
    const items = state?.items ?? [];
    const byId = new Map(items.map((item) => [item.id, item]));
    const parents = new Set(items.flatMap((item) => (item.parentId === undefined ? [] : [item.parentId])));
    for (const item of items) {
      if (!item.visible || !item.enabled || item.type === "separator" || parents.has(item.id)) continue;
      if (!item.contexts.some((context) => SHOWN_CONTEXTS.has(context))) continue;
      if (item.documentUrlPatterns && !safeMatches(location.href, item.documentUrlPatterns)) continue;
      const path: string[] = [];
      for (let at: MenuItem | undefined = item; at; at = at.parentId === undefined ? undefined : byId.get(at.parentId)) path.unshift(at.title.replace(/%s/g, "…"));
      const mark = item.type === "checkbox" || item.type === "radio" ? (item.checked ? "☑ " : "☐ ") : "";
      commands.push([
        mark + path.join(" › "),
        () => {
          const selection = globalThis.getSelection?.()?.toString() ?? "";
          const info: MenuClick = { menuItemId: item.id, pageUrl: location.href, ...(selection ? { selectionText: selection } : {}) };
          void deps.emit("menu-click", info).catch((error: unknown) => log.error(error));
        },
      ]);
    }
    const previous = registered;
    registered = [];
    for (const id of previous) await gm.unregisterMenuCommand(id).catch(() => {});
    for (const [caption, onClick] of commands) registered.push(await gm.registerMenuCommand(caption, onClick));
  };

  // Renders run one after another, each with the latest state, so commands never pile up.
  let queue = Promise.resolve();
  const refresh = (state: MenuState | undefined) => {
    queue = queue.then(() => render(state)).catch((error: unknown) => log.error("couldn't show the extension's menu commands:", error));
    return queue;
  };
  await gm.addValueChangeListener(key, (_key, _old, value) => void refresh(value as MenuState | undefined));
  await refresh(await gm.getValue<MenuState>(key));
}

function safeMatches(url: string, patterns: readonly string[]): boolean {
  try {
    return urlMatches(url, patterns);
  } catch {
    return false;
  }
}
