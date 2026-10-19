// In-page half of the CI emulator (spec §10.2). It plays the userscript manager:
// - provides only the granted GM_* functions;
// - honours @match, @exclude-match and @run-at;
// - keeps a local copy of the shared values.
// index.ts bundles it to an IIFE (global __x2uEmuPage) and injects it with context.addInitScript.
import { urlMatches } from "../../src/runtime/match.ts";
import type { Meta } from "./meta.ts";
import { createValueStore } from "./values.ts";

type XhrResult =
  | { status: number; statusText: string; finalUrl: string; responseHeaders: string; contentType: string; bodyBase64: string }
  | { error: string };

/** Playwright bindings installed by index.ts. */
type Bridge = {
  __x2uEmuSet(key: string, value: unknown): Promise<void>;
  __x2uEmuXhr(details: { method: string; url: string; headers: Record<string, string>; data?: string; timeout?: number }): Promise<XhrResult>;
  __x2uEmuOpen(url: string, active: boolean): Promise<number>;
  __x2uEmuClose(id: number): Promise<void>;
  __x2uEmuCookie(op: "list" | "set" | "delete", details: Record<string, unknown>): Promise<unknown>;
};

/** Hooks the Node side calls with frame.evaluate. */
export type Hooks = {
  /** A change made elsewhere, with the hub's revision of it. Changes the snapshot already holds are ignored. */
  apply(key: string, value: unknown, rev: number): void;
  clickMenu(caption: string): boolean;
  menu(): string[];
  notifications: Array<{ text: string; title?: string }>;
  tabClosed(id: number): void;
};

type TabHandle = { closed: boolean; onclose: (() => void) | null; close(): void };

type XhrDetails = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
  responseType?: string;
  timeout?: number;
  onload?(response: unknown): void;
  onerror?(response: unknown): void;
  ontimeout?(response: unknown): void;
  onabort?(response: unknown): void;
};

export function boot(meta: Meta, run: (api: Record<string, unknown>) => void): void {
  if (!urlMatches(location.href, meta.match) || urlMatches(location.href, meta.excludeMatch)) return;
  const win = window as unknown as Bridge & { __x2uEmu?: Hooks };
  const snapshot = readSnapshot();
  const values = createValueStore(snapshot.values, (key, value) => {
    void win.__x2uEmuSet(key, value);
  });
  const menu = new Map<string, { caption: string; onClick: () => void }>();
  const tabs = new Map<number, TabHandle>();
  const notifications: Hooks["notifications"] = [];
  let nextMenuId = 1;

  win.__x2uEmu = {
    // A change sent while this frame was between documents arrives after the new document took its snapshot.
    apply: (key, value, rev) => {
      if (rev > snapshot.rev) values.applyRemote(key, value);
    },
    clickMenu: (caption) => {
      for (const command of menu.values()) {
        if (command.caption === caption) {
          command.onClick();
          return true;
        }
      }
      return false;
    },
    menu: () => [...menu.values()].map((command) => command.caption),
    notifications,
    tabClosed: (id) => {
      const tab = tabs.get(id);
      if (tab && !tab.closed) {
        tab.closed = true;
        tab.onclose?.();
      }
    },
  };

  const provided: Record<string, unknown> = {
    GM_getValue: values.GM_getValue,
    GM_setValue: values.GM_setValue,
    GM_deleteValue: values.GM_deleteValue,
    GM_listValues: values.GM_listValues,
    GM_addValueChangeListener: values.GM_addValueChangeListener,
    GM_removeValueChangeListener: values.GM_removeValueChangeListener,
    GM_registerMenuCommand: (caption: string, onClick: () => void) => {
      const id = String(nextMenuId++);
      menu.set(id, { caption, onClick });
      return id;
    },
    GM_unregisterMenuCommand: (id: number | string) => {
      menu.delete(String(id));
    },
    GM_xmlhttpRequest: (details: XhrDetails) => xhr(win, meta, details),
    GM_addElement: addElement,
    GM_openInTab: (url: string, options?: boolean | { active?: boolean }) => openInTab(win, tabs, url, options),
    GM_notification: (details: { text: string; title?: string }) => {
      notifications.push({ text: details.text, title: details.title });
      return { remove: async () => {} };
    },
    GM_cookie: cookieApi(win),
  };
  const api: Record<string, unknown> = { GM_info: { scriptHandler: "x2u-emulator", version: "1", script: { name: meta.name } } };
  for (const name of meta.grant) if (name in provided) api[name] = provided[name];

  const start = () => run(api);
  if (meta.runAt === "document-start") whenRootExists(start);
  else if (meta.runAt === "document-end") whenParsed(start);
  else whenParsed(() => setTimeout(start, 0));
}

/**
 * Init scripts can run before <html> exists. A manager's document-start runs once it does.
 * The MutationObserver callback is a microtask, and the parser runs a microtask checkpoint before each
 * script, so this still runs before the page's first script.
 */
function whenRootExists(fn: () => void): void {
  if (document.documentElement) return fn();
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    fn();
  });
  observer.observe(document, { childList: true });
}

function whenParsed(fn: () => void): void {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
  else fn();
}

/**
 * Synchronous, so GM_getValue sees stored values from the userscript's first line. index.ts routes this URL and
 * stamps the values with the revision of the latest write they include.
 */
function readSnapshot(): { rev: number; values: Record<string, unknown> } {
  const request = new XMLHttpRequest();
  request.open("GET", "/__x2u_emu__/snapshot", false);
  request.send();
  return request.status === 200 ? (JSON.parse(request.responseText) as { rev: number; values: Record<string, unknown> }) : { rev: 0, values: {} };
}

/** Strings go as they are and URLSearchParams as form text. Any other body would be lost silently, so it throws. */
function xhrBody(data: unknown): string | undefined {
  if (data === undefined || typeof data === "string") return data;
  if (data instanceof URLSearchParams) return data.toString();
  const type = data === null ? "null" : ((data as { constructor?: { name?: string } }).constructor?.name ?? typeof data);
  throw new TypeError(`emulator: GM_xmlhttpRequest data of type ${type} is not supported`);
}

function xhr(win: Bridge, meta: Meta, details: XhrDetails): { abort(): void } {
  const data = xhrBody(details.data);
  let settled = false;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };
  const url = new URL(details.url, location.href);
  const allowed = url.hostname === location.hostname || meta.connect.some((host) => host === "*" || url.hostname === host || url.hostname.endsWith(`.${host}`));
  if (!allowed) {
    queueMicrotask(() => settle(() => details.onerror?.({ status: 0, error: `@connect does not allow ${url.hostname}` })));
    return { abort() {} };
  }
  const request = { method: details.method ?? "GET", url: url.href, headers: details.headers ?? {}, data, timeout: details.timeout };
  void win.__x2uEmuXhr(request).then((result) => {
    if ("error" in result) {
      settle(() => (result.error === "timeout" ? details.ontimeout?.({}) : details.onerror?.({ status: 0, error: result.error })));
      return;
    }
    const bytes = Uint8Array.from(atob(result.bodyBase64), (char) => char.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    const type = details.responseType ?? "text";
    const response =
      type === "json" ? parseJson(text)
      : type === "arraybuffer" ? bytes.buffer
      : type === "blob" ? new Blob([bytes], { type: result.contentType })
      : text;
    settle(() =>
      details.onload?.({ status: result.status, statusText: result.statusText, finalUrl: result.finalUrl, responseHeaders: result.responseHeaders, response, responseText: text }),
    );
  });
  return { abort: () => settle(() => details.onabort?.({})) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

type ScriptPolicy = { createScript(text: string): string };
let policy: ScriptPolicy | null | undefined;
/**
 * The managers' GM_addElement isn't held to the page's Trusted Types (YouTube requires them for scripts); the
 * emulator, running in the page's world, is. A policy of its own stands in for that. Null when the page has none.
 */
function trusted(): ScriptPolicy | null {
  policy ??= (window as { trustedTypes?: { createPolicy(name: string, rules: object): ScriptPolicy } }).trustedTypes?.createPolicy("x2u-emulator", { createScript: (text: string) => text }) ?? null;
  return policy;
}

function addElement(...args: unknown[]): Element {
  const hasParent = typeof args[0] !== "string";
  const parent = hasParent ? (args[0] as Node | null) : null;
  const tag = (hasParent ? args[1] : args[0]) as string;
  const attributes = ((hasParent ? args[2] : args[1]) ?? {}) as Record<string, string>;
  const doc = parent === null ? document : parent.nodeType === Node.DOCUMENT_NODE ? (parent as Document) : (parent.ownerDocument ?? document);
  const element = doc.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "textContent") element.textContent = (tag === "script" ? trusted()?.createScript(value) : undefined) ?? value;
    else element.setAttribute(name, value);
  }
  const fallback = tag === "script" || tag === "style" || tag === "link" ? doc.head : doc.body;
  (parent ?? fallback ?? doc.documentElement).appendChild(element);
  return element;
}

function openInTab(win: Bridge, tabs: Map<number, TabHandle>, url: string, options?: boolean | { active?: boolean }): TabHandle {
  const active = typeof options === "boolean" ? !options : (options?.active ?? true);
  let id: number | undefined;
  let closeRequested = false;
  const handle: TabHandle = {
    closed: false,
    onclose: null,
    close: () => {
      closeRequested = true;
      if (id !== undefined) void win.__x2uEmuClose(id);
    },
  };
  void win.__x2uEmuOpen(new URL(url, location.href).href, active).then((tabId) => {
    id = tabId;
    tabs.set(tabId, handle);
    if (closeRequested) void win.__x2uEmuClose(tabId);
  });
  return handle;
}

function cookieApi(win: Bridge) {
  const call = (op: "list" | "set" | "delete") => (details: Record<string, unknown>, callback?: (...args: unknown[]) => void) => {
    win.__x2uEmuCookie(op, details).then(
      (result) => (op === "list" ? callback?.(result, undefined) : callback?.(undefined)),
      (error: unknown) => (op === "list" ? callback?.([], String(error)) : callback?.(String(error))),
    );
  };
  return { list: call("list"), set: call("set"), delete: call("delete") };
}
