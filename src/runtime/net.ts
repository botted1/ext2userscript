// The network shim (spec §5.2, "Network"): fetch and XMLHttpRequest for the background and content scripts.
// - A request from this page to another origin that the manifest's host permissions cover goes through
//   gm.xmlHttpRequest, so CORS doesn't stop it, as it doesn't stop an extension's.
// - An extension URL (chrome-extension://<id>/path, which a background's relative URLs resolve to), or a blob: URL
//   runtime.getURL handed out, is answered from the asset table in this page, so the page's CSP can't refuse it.
// - Anything else goes to the page's own fetch and XMLHttpRequest.
// A background's request carries cookies unless it says credentials: "omit", as an extension's request to a host it has
// permission for does; a content script's follows the page's rules (cookies only with credentials: "include" or
// withCredentials), so a page can't use it to read the user's signed-in pages elsewhere.
// Ceilings: a body through gm.xmlHttpRequest is buffered (no streaming, no progress until it has all arrived), its
// upload sends no progress events, and it can't be synchronous.
import type { Gm, GmXhrResponse } from "./gm.ts";
import { matchPatternToRegExp } from "./match.ts";

export type NetworkDeps = {
  gm: Pick<Gm, "xmlHttpRequest">;
  /** An extension file from the asset table, or undefined if the userscript doesn't have it. */
  asset(path: string): { type: string; bytes: Uint8Array } | undefined;
  /** The asset path behind a blob: URL runtime.getURL handed out. */
  assetPathOf(url: string): string | undefined;
  extensionId: string;
  /** What relative URLs resolve against: the page's URL for content scripts, chrome-extension://<id>/<entry> for the background. */
  base(): string;
  /** This page's origin: a request to it isn't cross-origin, so it stays native. */
  origin: string;
  /** Host match patterns, required and optional. Chrome ignores their paths, and so does this. */
  hosts: readonly string[];
  /** "unless-omitted" for the background, "when-included" for content scripts (see above). */
  cookies: "unless-omitted" | "when-included";
  /** The page's own fetch and XMLHttpRequest. */
  fetch: typeof globalThis.fetch;
  XMLHttpRequest?: typeof globalThis.XMLHttpRequest;
};

export type Network = { fetch: typeof globalThis.fetch; XMLHttpRequest: typeof globalThis.XMLHttpRequest };

/** Where a request goes: the page, gm.xmlHttpRequest, or the asset table (with the file's path). */
type Target = { kind: "native" | "gm" | "asset"; url: string; path?: string };

/** Statuses whose responses have no body; the Response constructor refuses one. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const XHR_EVENTS = ["readystatechange", "loadstart", "progress", "load", "error", "abort", "timeout", "loadend"] as const;

export function createNetwork(deps: NetworkDeps): Network {
  const hosts = deps.hosts.flatMap((pattern) => {
    try {
      return [matchPatternToRegExp(pattern === "<all_urls>" ? pattern : pattern.replace(/^([^:]+:\/\/[^/]*)(?:\/.*)?$/, "$1/*"))];
    } catch {
      return [];
    }
  });

  // Parsed the way a request URL is, so an id such as addon@example.com (user "addon", host "example.com") still matches.
  const extensionPrefix = new URL(`chrome-extension://${deps.extensionId}/`).href;

  const route = (url: string): Target => {
    const target = new URL(url, deps.base());
    if (target.href.startsWith(extensionPrefix)) return { kind: "asset", url: target.href, path: decodeURI(target.href.slice(extensionPrefix.length).split(/[?#]/)[0]) };
    const asset = target.protocol === "blob:" ? deps.assetPathOf(target.href) : undefined;
    if (asset !== undefined) return { kind: "asset", url: target.href, path: asset };
    const http = target.protocol === "http:" || target.protocol === "https:";
    const gm = http && target.origin !== deps.origin && hosts.some((host) => host.test(target.href));
    return { kind: gm ? "gm" : "native", url: target.href };
  };
  /** Whether a request through gm.xmlHttpRequest goes without cookies. */
  const anonymous = (asked: boolean, omitted = false) => (deps.cookies === "when-included" ? !asked : omitted);

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const target = route(isRequest ? input.url : String(input));
    if (target.kind === "asset") {
      const file = deps.asset(target.path as string);
      if (!file) throw new TypeError("Failed to fetch");
      return withUrl(new Response(file.bytes.slice(), { status: 200, headers: { "content-type": file.type } }), target.url);
    }
    if (target.kind === "native") return deps.fetch(isRequest && target.url === input.url ? input : target.url, init);
    // A Request built the way fetch builds one: its method, its headers (with the body's Content-Type), its signal.
    const request = isRequest ? new Request(input, init) : new Request(target.url, init);
    const body = init?.body ?? undefined;
    const data =
      request.method === "GET" || request.method === "HEAD" ? undefined
      : typeof body === "string" ? body
      : body instanceof URLSearchParams ? body.toString()
      : typeof FormData !== "undefined" && body instanceof FormData ? body
      : await request.blob();
    const reply = await deps.gm.xmlHttpRequest({
      method: request.method,
      url: target.url,
      headers: Object.fromEntries(request.headers),
      ...(data === undefined || (data instanceof Blob && data.size === 0) ? {} : { data }),
      responseType: "arraybuffer",
      anonymous: anonymous(request.credentials === "include", request.credentials === "omit"),
      signal: request.signal,
    });
    return toResponse(reply, target.url);
  };

  return { fetch: fetch as typeof globalThis.fetch, XMLHttpRequest: xhrClass(deps, route, anonymous) };
}

function toResponse(reply: GmXhrResponse, url: string): Response {
  if (reply.status < 200 || reply.status > 599) throw new TypeError("Failed to fetch");
  const body = NULL_BODY.has(reply.status) ? null : (reply.response as ArrayBuffer | null);
  return withUrl(new Response(body, { status: reply.status, statusText: reply.statusText, headers: parseHeaders(reply.responseHeaders) }), reply.finalUrl || url, url);
}

/** Response.url can't be set through the constructor, so it is defined on the instance. */
function withUrl(response: Response, url: string, requested = url): Response {
  return Object.defineProperties(response, { url: { value: url }, redirected: { value: url !== requested } });
}

function parseHeaders(text: string): Headers {
  const headers = new Headers();
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    try {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    } catch {
      // A header the Headers class refuses is left out.
    }
  }
  return headers;
}

/**
 * XMLHttpRequest. open() decides the route: a request for the page's own XMLHttpRequest goes to a real one, whose state
 * and events this object mirrors; one through gm.xmlHttpRequest, or for an extension file, is played out here, with the
 * same events in the same order once the whole response has arrived (at once, for a synchronous one).
 */
function xhrClass(deps: NetworkDeps, route: (url: string) => Target, anonymous: (asked: boolean) => boolean): typeof globalThis.XMLHttpRequest {
  type State = { readyState: number; status: number; statusText: string; responseURL: string; headers: string; body?: ArrayBuffer; type: string };
  const fresh = (): State => ({ readyState: 0, status: 0, statusText: "", responseURL: "", headers: "", type: "" });

  class ShimXMLHttpRequest extends EventTarget {
    static readonly UNSENT = 0;
    static readonly OPENED = 1;
    static readonly HEADERS_RECEIVED = 2;
    static readonly LOADING = 3;
    static readonly DONE = 4;
    readonly UNSENT = 0;
    readonly OPENED = 1;
    readonly HEADERS_RECEIVED = 2;
    readonly LOADING = 3;
    readonly DONE = 4;
    readonly upload = new EventTarget();
    onreadystatechange: ((event: Event) => void) | null = null;
    onloadstart: ((event: Event) => void) | null = null;
    onprogress: ((event: Event) => void) | null = null;
    onload: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onabort: ((event: Event) => void) | null = null;
    ontimeout: ((event: Event) => void) | null = null;
    onloadend: ((event: Event) => void) | null = null;
    #real?: XMLHttpRequest;
    #state = fresh();
    #method = "GET";
    #url = "";
    #asset?: string;
    #async = true;
    #headers: Record<string, string> = {};
    #controller?: AbortController;
    #responseType: XMLHttpRequestResponseType = "";
    #timeout = 0;
    #withCredentials = false;

    get readyState() { return this.#real ? this.#real.readyState : this.#state.readyState; }
    get status() { return this.#real ? this.#real.status : this.#state.status; }
    get statusText() { return this.#real ? this.#real.statusText : this.#state.statusText; }
    get responseURL() { return this.#real ? this.#real.responseURL : this.#state.responseURL; }
    get responseType() { return this.#responseType; }
    set responseType(value: XMLHttpRequestResponseType) {
      this.#responseType = value;
      if (this.#real) this.#real.responseType = value;
    }
    get timeout() { return this.#timeout; }
    set timeout(value: number) {
      this.#timeout = value;
      if (this.#real) this.#real.timeout = value;
    }
    get withCredentials() { return this.#withCredentials; }
    set withCredentials(value: boolean) {
      this.#withCredentials = value;
      if (this.#real) this.#real.withCredentials = value;
    }
    get response(): unknown {
      if (this.#real) return this.#real.response;
      const { body, readyState, type } = this.#state;
      if (readyState !== 4 || !body) return this.#responseType === "" || this.#responseType === "text" ? "" : null;
      switch (this.#responseType) {
        case "arraybuffer": return body;
        case "blob": return new Blob([body], { type });
        case "json":
          try {
            return JSON.parse(this.responseText);
          } catch {
            return null;
          }
        case "document": return new DOMParser().parseFromString(this.responseText, /xml/.test(type) ? "application/xml" : "text/html");
        default: return this.responseText;
      }
    }
    get responseText(): string {
      if (this.#real) return this.#real.responseText;
      return this.#state.body ? new TextDecoder().decode(this.#state.body) : "";
    }
    get responseXML(): Document | null {
      if (this.#real) return this.#real.responseXML;
      return this.#state.readyState === 4 && /xml|html/.test(this.#state.type) ? new DOMParser().parseFromString(this.responseText, /html/.test(this.#state.type) ? "text/html" : "application/xml") : null;
    }

    open(method: string, url: string | URL, async = true, user?: string | null, password?: string | null) {
      const target = route(String(url));
      this.#real = undefined;
      this.#state = fresh();
      this.#method = method.toUpperCase();
      this.#url = target.url;
      this.#asset = target.path;
      this.#async = async;
      this.#headers = {};
      if (target.kind === "native") {
        if (!deps.XMLHttpRequest) throw new Error("ext2userscript: XMLHttpRequest isn't available here");
        const real = new deps.XMLHttpRequest();
        this.#real = real;
        for (const type of XHR_EVENTS) real.addEventListener(type, (event) => this.#fire(type, event as ProgressEvent));
        for (const type of XHR_EVENTS) real.upload.addEventListener(type, (event) => this.upload.dispatchEvent(progress(type, event as ProgressEvent)));
        real.open(method, target.url, async, user, password);
        // Only what was changed: a page refuses even the default response type or timeout on a synchronous request.
        if (this.#responseType) real.responseType = this.#responseType;
        if (this.#timeout) real.timeout = this.#timeout;
        if (this.#withCredentials) real.withCredentials = true;
        return;
      }
      if (!async && target.kind === "gm") throw new DOMException("ext2userscript: a synchronous request can't go through GM_xmlhttpRequest", "InvalidAccessError");
      this.#state.readyState = 1;
      this.#fire("readystatechange");
    }

    setRequestHeader(name: string, value: string) {
      if (this.#real) return this.#real.setRequestHeader(name, value);
      if (this.#state.readyState !== 1) throw new DOMException("The object's state must be OPENED.", "InvalidStateError");
      const key = Object.keys(this.#headers).find((existing) => existing.toLowerCase() === name.toLowerCase()) ?? name;
      this.#headers[key] = key in this.#headers ? `${this.#headers[key]}, ${value}` : String(value);
    }

    getResponseHeader(name: string): string | null {
      if (this.#real) return this.#real.getResponseHeader(name);
      return this.#state.readyState < 2 ? null : parseHeaders(this.#state.headers).get(name);
    }

    getAllResponseHeaders(): string {
      if (this.#real) return this.#real.getAllResponseHeaders();
      if (this.#state.readyState < 2) return "";
      return [...parseHeaders(this.#state.headers)].map(([name, value]) => `${name}: ${value}\r\n`).join("");
    }

    overrideMimeType(mime: string) {
      this.#real?.overrideMimeType(mime);
    }

    send(body?: Document | XMLHttpRequestBodyInit | null) {
      if (this.#real) return this.#real.send(body);
      if (this.#state.readyState !== 1 || this.#controller) throw new DOMException("The object's state must be OPENED.", "InvalidStateError");
      const controller = new AbortController();
      this.#controller = controller;
      const method = this.#method;
      const data =
        method === "GET" || method === "HEAD" || body === null || body === undefined ? undefined
        : typeof Document !== "undefined" && body instanceof Document ? new XMLSerializer().serializeToString(body)
        : body;
      this.#fire("loadstart");
      if (this.#asset !== undefined) {
        const file = deps.asset(this.#asset);
        const answer = () => {
          if (controller.signal.aborted) return;
          if (!file) return this.#fail(new TypeError("Failed to load"));
          this.#finish({ status: 200, statusText: "OK", finalUrl: this.#url, responseHeaders: `content-type: ${file.type}\r\n`, response: file.bytes.slice().buffer });
        };
        if (this.#async) queueMicrotask(answer);
        else answer();
        return;
      }
      deps.gm
        .xmlHttpRequest({
          method,
          url: this.#url,
          headers: this.#headers,
          ...(data === undefined ? {} : { data: typeof data === "string" || data instanceof Blob || data instanceof URLSearchParams || data instanceof FormData ? data : new Blob([data as BlobPart]) }),
          responseType: "arraybuffer",
          ...(this.#timeout > 0 ? { timeout: this.#timeout } : {}),
          anonymous: anonymous(this.#withCredentials),
          signal: controller.signal,
        })
        .then(
          (reply) => {
            if (!controller.signal.aborted) this.#finish(reply);
          },
          (error: unknown) => {
            if (!controller.signal.aborted) this.#fail(error);
          },
        );
    }

    /** The whole response is here: headers, then body, then done. */
    #finish(reply: GmXhrResponse) {
      const headers = parseHeaders(reply.responseHeaders);
      this.#state = { ...this.#state, readyState: 2, status: reply.status, statusText: reply.statusText, responseURL: reply.finalUrl || this.#url, headers: reply.responseHeaders, type: headers.get("content-type") ?? "" };
      this.#fire("readystatechange");
      const size = (reply.response as ArrayBuffer | null)?.byteLength ?? 0;
      this.#state.readyState = 3;
      this.#fire("readystatechange");
      this.#fire("progress", { loaded: size, total: size, lengthComputable: true });
      this.#state.body = (reply.response as ArrayBuffer | null) ?? undefined;
      this.#state.readyState = 4;
      this.#controller = undefined;
      this.#fire("readystatechange");
      this.#fire("load", { loaded: size, total: size, lengthComputable: true });
      this.#fire("loadend", { loaded: size, total: size, lengthComputable: true });
    }

    #fail(error: unknown) {
      this.#controller = undefined;
      this.#state = { ...fresh(), readyState: 4 };
      this.#fire("readystatechange");
      this.#fire(error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "error");
      this.#fire("loadend");
    }

    abort() {
      if (this.#real) return this.#real.abort();
      const controller = this.#controller;
      if (!controller) return;
      this.#controller = undefined;
      controller.abort();
      this.#state = { ...fresh(), readyState: 4 };
      this.#fire("readystatechange");
      this.#fire("abort");
      this.#fire("loadend");
      this.#state.readyState = 0;
    }

    /** Fires an event: the on<type> property first, then the listeners, as for a handler set before them. */
    #fire(type: (typeof XHR_EVENTS)[number], from?: { loaded: number; total: number; lengthComputable: boolean }) {
      const event = progress(type, from);
      this[`on${type}`]?.call(this, event);
      this.dispatchEvent(event);
    }
  }
  return ShimXMLHttpRequest as unknown as typeof globalThis.XMLHttpRequest;
}

/** A ProgressEvent where there is one (pages), or an Event carrying the same fields. */
function progress(type: string, from?: { loaded: number; total: number; lengthComputable: boolean }): Event {
  const init = { loaded: from?.loaded ?? 0, total: from?.total ?? 0, lengthComputable: from?.lengthComputable ?? false };
  return typeof ProgressEvent === "function" ? new ProgressEvent(type, init) : Object.assign(new Event(type), init);
}
