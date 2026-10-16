// chrome.windows (spec §5.2): one synthetic window, id 1, holding every tab (chrome.tabs does the same).
// Ceilings: a window can't be moved, resized or closed; create opens its URLs as tabs; the events never fire.
import { createEvent, method, type Logger } from "./chrome.ts";
import { WINDOW_ID } from "./tabs.ts";

type QueryOptions = { populate?: boolean };
type TabsApi = { query(query: object): Promise<unknown>; create(properties: { url?: string; active?: boolean }): Promise<unknown> };

export function createWindows(tabs: TabsApi, log: Logger) {
  const window = async (options: QueryOptions = {}) => ({
    id: WINDOW_ID,
    focused: typeof document !== "undefined" && document.hasFocus(),
    top: globalThis.screenY ?? 0,
    left: globalThis.screenX ?? 0,
    width: globalThis.outerWidth ?? 0,
    height: globalThis.outerHeight ?? 0,
    incognito: false,
    type: "normal",
    state: "normal",
    alwaysOnTop: false,
    ...(options.populate ? { tabs: await tabs.query({}) } : {}),
  });
  const get = async (id: number, options?: QueryOptions) => {
    if (id !== WINDOW_ID && id !== -2) throw new Error(`No window with id: ${id}.`);
    return window(options);
  };
  const event = () => createEvent<(...args: unknown[]) => void>(log).event;

  return {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    CreateType: { NORMAL: "normal", POPUP: "popup", PANEL: "panel" },
    WindowType: { NORMAL: "normal", POPUP: "popup", PANEL: "panel", APP: "app", DEVTOOLS: "devtools" },
    WindowState: { NORMAL: "normal", MINIMIZED: "minimized", MAXIMIZED: "maximized", FULLSCREEN: "fullscreen", LOCKED_FULLSCREEN: "locked-fullscreen" },
    get: method(log, get),
    getCurrent: method(log, (options?: QueryOptions) => window(options)),
    getLastFocused: method(log, (options?: QueryOptions) => window(options)),
    getAll: method(log, async (options?: QueryOptions) => [await window(options)]),
    create: method(log, async (data: { url?: string | string[]; focused?: boolean } = {}) => {
      for (const url of typeof data.url === "string" ? [data.url] : (data.url ?? [])) await tabs.create({ url, active: data.focused ?? true });
      return window({ populate: true });
    }),
    update: method(log, (id: number) => get(id)),
    remove: method(log, async () => {
      throw new Error("ext2userscript: a userscript can't close the browser window");
    }),
    onCreated: event(),
    onRemoved: event(),
    onFocusChanged: event(),
    onBoundsChanged: event(),
  };
}
