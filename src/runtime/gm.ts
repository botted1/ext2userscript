// The only file in src/ that touches GM_* (spec §5.1). Async-only, with one implementation for Tampermonkey
// and Violentmonkey. Each method calls its GM_* function before its first await, so only the result is async.

export type GmMethod =
  | "getValue" | "setValue" | "deleteValue" | "listValues"
  | "addValueChangeListener" | "removeValueChangeListener"
  | "registerMenuCommand" | "unregisterMenuCommand"
  | "xmlHttpRequest" | "addElement" | "openInTab" | "notification" | "cookie";

/** The GM_* functions each method calls. metadata.ts writes @grant lines from this table. */
export const GRANTS: Readonly<Record<GmMethod, readonly string[]>> = {
  getValue: ["GM_getValue"],
  setValue: ["GM_setValue"],
  deleteValue: ["GM_deleteValue"],
  listValues: ["GM_listValues"],
  addValueChangeListener: ["GM_addValueChangeListener"],
  removeValueChangeListener: ["GM_removeValueChangeListener"],
  registerMenuCommand: ["GM_registerMenuCommand"],
  unregisterMenuCommand: ["GM_unregisterMenuCommand"],
  xmlHttpRequest: ["GM_xmlhttpRequest"],
  addElement: ["GM_addElement"],
  openInTab: ["GM_openInTab"],
  notification: ["GM_notification"],
  cookie: ["GM_cookie"],
};

/** Methods every converted script uses (spec §5.1). */
export const CORE_METHODS: readonly GmMethod[] = [
  "getValue", "setValue", "deleteValue", "listValues",
  "addValueChangeListener", "removeValueChangeListener", "addElement",
];

/** @grant names for the core set plus the given methods, sorted and without duplicates. */
export function grantsFor(methods: Iterable<GmMethod>): string[] {
  const names = new Set<string>();
  for (const method of [...CORE_METHODS, ...methods]) for (const name of GRANTS[method]) names.add(name);
  return [...names].sort();
}

export type ValueListener = (key: string, oldValue: unknown, newValue: unknown, remote: boolean) => void;

export type GmXhrResponse = { status: number; statusText: string; finalUrl: string; responseHeaders: string; response: unknown };

export type GmXhrDetails = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
  responseType: "text" | "json" | "blob" | "arraybuffer";
  timeout?: number;
  anonymous?: boolean;
  onload(response: GmXhrResponse): void;
  onerror(response: unknown): void;
  ontimeout(response: unknown): void;
  onabort(response: unknown): void;
};

export type GmTabHandle = { close(): void; closed: boolean; onclose?: (() => void) | null };

export type GmCookie = { name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number };

export type CookieDetails = { url?: string; name?: string; value?: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number };

/** The raw functions a manager puts in scope. A manager defines only what the script was granted. */
export type GmApi = {
  GM_getValue?(key: string, fallback?: unknown): unknown;
  GM_setValue?(key: string, value: unknown): void;
  GM_deleteValue?(key: string): void;
  GM_listValues?(): string[];
  GM_addValueChangeListener?(key: string, fn: ValueListener): number | string;
  GM_removeValueChangeListener?(id: number | string): void;
  GM_registerMenuCommand?(caption: string, onClick: () => void): number | string;
  GM_unregisterMenuCommand?(id: number | string): void;
  GM_xmlhttpRequest?(details: GmXhrDetails): { abort(): void };
  GM_addElement?(...args: [parent: Node, tag: string, attributes: Record<string, string>] | [tag: string, attributes: Record<string, string>]): Element;
  GM_openInTab?(url: string, options: { active: boolean; insert: boolean }): GmTabHandle;
  GM_notification?(details: { text: string; title?: string; image?: string; onclick?: () => void; ondone?: () => void }): unknown;
  GM_cookie?: {
    list(details: CookieDetails, callback: (cookies: GmCookie[], error?: unknown) => void): void;
    set(details: CookieDetails, callback: (error?: unknown) => void): void;
    delete(details: CookieDetails, callback: (error?: unknown) => void): void;
  };
  GM_info?: { scriptHandler?: string };
};

// Managers put these in the userscript's scope, not on window. They may be undeclared at runtime.
declare const GM_getValue: GmApi["GM_getValue"];
declare const GM_setValue: GmApi["GM_setValue"];
declare const GM_deleteValue: GmApi["GM_deleteValue"];
declare const GM_listValues: GmApi["GM_listValues"];
declare const GM_addValueChangeListener: GmApi["GM_addValueChangeListener"];
declare const GM_removeValueChangeListener: GmApi["GM_removeValueChangeListener"];
declare const GM_registerMenuCommand: GmApi["GM_registerMenuCommand"];
declare const GM_unregisterMenuCommand: GmApi["GM_unregisterMenuCommand"];
declare const GM_xmlhttpRequest: GmApi["GM_xmlhttpRequest"];
declare const GM_addElement: GmApi["GM_addElement"];
declare const GM_openInTab: GmApi["GM_openInTab"];
declare const GM_notification: GmApi["GM_notification"];
declare const GM_cookie: GmApi["GM_cookie"];
declare const GM_info: GmApi["GM_info"];

/** Collects the GM functions in scope. typeof keeps names the manager didn't define from throwing. */
export function readManagerApi(): GmApi {
  return {
    GM_getValue: typeof GM_getValue === "function" ? GM_getValue : undefined,
    GM_setValue: typeof GM_setValue === "function" ? GM_setValue : undefined,
    GM_deleteValue: typeof GM_deleteValue === "function" ? GM_deleteValue : undefined,
    GM_listValues: typeof GM_listValues === "function" ? GM_listValues : undefined,
    GM_addValueChangeListener: typeof GM_addValueChangeListener === "function" ? GM_addValueChangeListener : undefined,
    GM_removeValueChangeListener: typeof GM_removeValueChangeListener === "function" ? GM_removeValueChangeListener : undefined,
    GM_registerMenuCommand: typeof GM_registerMenuCommand === "function" ? GM_registerMenuCommand : undefined,
    GM_unregisterMenuCommand: typeof GM_unregisterMenuCommand === "function" ? GM_unregisterMenuCommand : undefined,
    GM_xmlhttpRequest: typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : undefined,
    GM_addElement: typeof GM_addElement === "function" ? GM_addElement : undefined,
    GM_openInTab: typeof GM_openInTab === "function" ? GM_openInTab : undefined,
    GM_notification: typeof GM_notification === "function" ? GM_notification : undefined,
    GM_cookie: typeof GM_cookie === "object" && GM_cookie !== null ? GM_cookie : undefined,
    GM_info: typeof GM_info === "object" && GM_info !== null ? GM_info : undefined,
  };
}

export type Caps = { valueListeners: boolean; menus: boolean; cookies: boolean };

export type XhrRequest = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: string | Blob | ArrayBuffer | FormData | URLSearchParams;
  responseType?: "text" | "json" | "blob" | "arraybuffer";
  timeout?: number;
  anonymous?: boolean;
  signal?: AbortSignal;
};

export type TabControl = { close(): void; readonly closed: boolean; onClose(fn: () => void): void };

export type GmNotification = { text: string; title?: string; image?: string; onclick?: () => void; ondone?: () => void };

export type Gm = {
  readonly caps: Caps;
  /** GM_info.scriptHandler, e.g. "Tampermonkey". */
  readonly handler: string;
  getValue<T = unknown>(key: string, fallback?: T): Promise<T | undefined>;
  setValue(key: string, value: unknown): Promise<void>;
  deleteValue(key: string): Promise<void>;
  listValues(): Promise<string[]>;
  addValueChangeListener(key: string, fn: ValueListener): Promise<number | string>;
  removeValueChangeListener(id: number | string): Promise<void>;
  registerMenuCommand(caption: string, onClick: () => void): Promise<number | string>;
  unregisterMenuCommand(id: number | string): Promise<void>;
  xmlHttpRequest(request: XhrRequest): Promise<GmXhrResponse>;
  addElement(parent: Node | null, tag: string, attributes?: Record<string, string>): Promise<Element>;
  openInTab(url: string, options?: { active?: boolean }): Promise<TabControl>;
  notification(notification: GmNotification): Promise<void>;
  cookie: {
    list(details: CookieDetails): Promise<GmCookie[]>;
    set(details: CookieDetails): Promise<void>;
    delete(details: CookieDetails): Promise<void>;
  };
};

export class GmUnavailableError extends Error {
  constructor(name: string) {
    super(`ext2userscript: ${name} is not available (not granted, or not supported by this userscript manager)`);
    this.name = "GmUnavailableError";
  }
}

const abortError = () => new DOMException("The operation was aborted.", "AbortError");
const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/** chrome.storage-like JSON semantics on every manager: Dates become strings, functions and undefined vanish. */
const toJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

export function createGm(api: GmApi = readManagerApi()): Gm {
  const need = <K extends keyof GmApi>(name: K): NonNullable<GmApi[K]> => {
    const value = api[name];
    if (value === undefined) throw new GmUnavailableError(name);
    return value as NonNullable<GmApi[K]>;
  };
  /** Runs the GM call now; only the result is async. A throw becomes a rejection. */
  const now = <T>(run: () => T): Promise<T> => {
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const viaCallback = <T>(run: (done: (error: unknown, value?: T) => void) => void): Promise<T> =>
    new Promise((resolve, reject) => run((error, value) => (error ? reject(toError(error)) : resolve(value as T))));

  return {
    caps: {
      valueListeners: typeof api.GM_addValueChangeListener === "function",
      menus: typeof api.GM_registerMenuCommand === "function",
      cookies: typeof api.GM_cookie === "object" && api.GM_cookie !== null,
    },
    handler: api.GM_info?.scriptHandler ?? "unknown",
    getValue: <T>(key: string, fallback?: T) => now(() => need("GM_getValue")(key, fallback) as T | undefined),
    setValue: (key, value) =>
      now(() => {
        if (value === undefined) need("GM_deleteValue")(key);
        else need("GM_setValue")(key, toJson(value));
      }),
    deleteValue: (key) => now(() => need("GM_deleteValue")(key)),
    listValues: () => now(() => [...need("GM_listValues")()]),
    addValueChangeListener: (key, fn) => now(() => need("GM_addValueChangeListener")(key, fn)),
    removeValueChangeListener: (id) => now(() => need("GM_removeValueChangeListener")(id)),
    registerMenuCommand: (caption, onClick) => now(() => need("GM_registerMenuCommand")(caption, onClick)),
    unregisterMenuCommand: (id) => now(() => need("GM_unregisterMenuCommand")(id)),
    xmlHttpRequest: (request) =>
      new Promise<GmXhrResponse>((resolve, reject) => {
        const send = need("GM_xmlhttpRequest"); // the executor runs synchronously, so the GM call happens before return
        if (request.signal?.aborted) return reject(abortError());
        const control = send({
          method: request.method ?? "GET",
          url: request.url,
          headers: request.headers,
          data: request.data,
          responseType: request.responseType ?? "text",
          timeout: request.timeout,
          anonymous: request.anonymous,
          onload: (r) => resolve({ status: r.status, statusText: r.statusText, finalUrl: r.finalUrl, responseHeaders: r.responseHeaders, response: r.response }),
          onerror: () => reject(new TypeError(`ext2userscript: request to ${request.url} failed`)),
          ontimeout: () => reject(new DOMException(`ext2userscript: request to ${request.url} timed out`, "TimeoutError")),
          onabort: () => reject(abortError()),
        });
        request.signal?.addEventListener("abort", () => control.abort(), { once: true });
      }),
    addElement: (parent, tag, attributes = {}) =>
      now(() => (parent ? need("GM_addElement")(parent, tag, attributes) : need("GM_addElement")(tag, attributes))),
    openInTab: (url, options = {}) => now(() => wrapTab(need("GM_openInTab")(url, { active: options.active ?? true, insert: true }))),
    notification: (n) =>
      now(() => {
        need("GM_notification")({ text: n.text, title: n.title, image: n.image, onclick: n.onclick, ondone: n.ondone });
      }),
    cookie: {
      list: (details) => viaCallback<GmCookie[]>((done) => need("GM_cookie").list(details, (cookies, error) => done(error, cookies))),
      set: (details) => viaCallback<void>((done) => need("GM_cookie").set(details, (error) => done(error))),
      delete: (details) => viaCallback<void>((done) => need("GM_cookie").delete(details, (error) => done(error))),
    },
  };
}

function wrapTab(handle: GmTabHandle): TabControl {
  const listeners: Array<() => void> = [];
  handle.onclose = () => {
    for (const fn of listeners) fn();
  };
  return {
    close: () => handle.close(),
    get closed() {
      return handle.closed;
    },
    onClose: (fn) => {
      listeners.push(fn);
    },
  };
}
