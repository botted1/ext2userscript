// The network shim: which requests go through gm.xmlHttpRequest, and the fetch and XMLHttpRequest they get back.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GmXhrResponse, XhrRequest } from "../../src/runtime/gm.ts";
import { createNetwork, type NetworkDeps } from "../../src/runtime/net.ts";

type Reply = Partial<GmXhrResponse> | Error;

/** The extension's files, as the asset table has them: path → [type, text]. */
const FILES: Record<string, [string, string]> = {
  "data/info file.json": ["application/json", '{"kind":"info"}'],
  "bg/config.json": ["application/json", '{"kind":"config"}'],
  "icon.png": ["image/png", "PNG"],
};

/** A network over a fake gm.xmlHttpRequest that answers with `reply`, and a page fetch that records what it got. */
function network(reply: Reply = {}, overrides: Partial<NetworkDeps> = {}) {
  const gmCalls: XhrRequest[] = [];
  const pageCalls: string[] = [];
  const net = createNetwork({
    gm: {
      xmlHttpRequest: async (request) => {
        gmCalls.push(request);
        if (reply instanceof Error) throw reply;
        return { status: 200, statusText: "OK", finalUrl: request.url, responseHeaders: "", response: new ArrayBuffer(0), ...reply };
      },
    },
    asset: (path) => (FILES[path] ? { type: FILES[path][0], bytes: new TextEncoder().encode(FILES[path][1]) } : undefined),
    assetPathOf: (url) => (url.startsWith("blob:https://page.test/x2u-") ? url.slice("blob:https://page.test/x2u-".length) : undefined),
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    base: () => "https://page.test/app/index.html",
    origin: "https://page.test",
    hosts: ["https://api.test/v1/*", "*://*.cdn.test/*", "not a pattern"],
    cookies: "unless-omitted",
    fetch: async (input) => {
      pageCalls.push(String(input instanceof Request ? input.url : input));
      return new Response("from the page");
    },
    ...overrides,
  });
  return { net, gmCalls, pageCalls };
}

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe("fetch", () => {
  it("sends a cross-origin request for a permitted host through gm.xmlHttpRequest, and answers with a Response", async () => {
    const { net, gmCalls } = network({ status: 201, statusText: "Created", finalUrl: "https://api.test/v2/done", responseHeaders: "Content-Type: application/json\r\nX-Id: 7\r\n", response: bytes('{"ok":true}') });
    const response = await net.fetch("https://api.test/v1/items", { method: "POST", headers: { "X-Key": "k" }, body: JSON.stringify({ a: 1 }) });
    assert.deepEqual([response.status, response.statusText, response.headers.get("x-id"), response.url, response.redirected], [201, "Created", "7", "https://api.test/v2/done", true]);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(gmCalls.length, 1);
    const call = gmCalls[0];
    assert.deepEqual([call.method, call.url, call.data, call.responseType, call.anonymous], ["POST", "https://api.test/v1/items", '{"a":1}', "arraybuffer", false]);
    assert.deepEqual(call.headers, { "content-type": "text/plain;charset=UTF-8", "x-key": "k" });
  });

  it("passes a binary body through byte for byte", async () => {
    const image = Uint8Array.from({ length: 256 }, (_value, i) => i);
    const { net } = network({ responseHeaders: "content-type: image/png\r\n", response: image.buffer });
    const response = await net.fetch("https://api.test/v1/image.png");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
    assert.equal((await (await net.fetch("https://api.test/v1/image.png")).blob()).type, "image/png");
  });

  it("ignores a host permission's path, matches subdomains, and leaves cookies out only when told to", async () => {
    const { net, gmCalls } = network();
    await net.fetch("https://api.test/other/path");
    await net.fetch(new Request("https://img.cdn.test/a.png", { credentials: "omit" }));
    assert.deepEqual(gmCalls.map((call) => [call.url, call.anonymous]), [["https://api.test/other/path", false], ["https://img.cdn.test/a.png", true]]);
  });

  it("leaves same-origin and unpermitted requests to the page", async () => {
    const { net, gmCalls, pageCalls } = network();
    await net.fetch("/same/origin");
    await net.fetch("https://elsewhere.test/x");
    assert.deepEqual(pageCalls, ["https://page.test/same/origin", "https://elsewhere.test/x"]);
    assert.equal(gmCalls.length, 0);
  });

  it("answers extension URLs, and the blob: URLs getURL gave out, from the asset table without a request the page's CSP could refuse", async () => {
    const { net, gmCalls, pageCalls } = network();
    const asset = await net.fetch("chrome-extension://abcdefghijklmnopabcdefghijklmnop/data/info%20file.json");
    assert.deepEqual([asset.url, asset.status, asset.headers.get("content-type"), await asset.json()], ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/data/info%20file.json", 200, "application/json", { kind: "info" }]);
    assert.equal(await (await net.fetch("blob:https://page.test/x2u-icon.png")).text(), "PNG");
    await assert.rejects(net.fetch("chrome-extension://abcdefghijklmnopabcdefghijklmnop/missing.json"), /Failed to fetch/);
    assert.deepEqual([pageCalls, gmCalls], [[], []]);
  });

  it("resolves a background's relative URLs against its own file, so they reach the extension's files", async () => {
    const { net } = network({}, { base: () => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/bg/sw.js" });
    assert.deepEqual(await (await net.fetch("config.json")).json(), { kind: "config" });
    assert.equal(await (await net.fetch(new URL("../icon.png", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/bg/sw.js"))).text(), "PNG");
  });

  it("recognises extension URLs when the id is a Firefox add-on's email-style id", async () => {
    const { net } = network({}, { extensionId: "addon@example.com", base: () => "chrome-extension://addon@example.com/bg/sw.js" });
    assert.deepEqual(await (await net.fetch("config.json")).json(), { kind: "config" });
  });

  it("sends cookies from a content script only when the request asks for them, as the page's own requests do", async () => {
    const { net, gmCalls } = network({}, { cookies: "when-included" });
    await net.fetch("https://api.test/v1/a");
    await net.fetch("https://api.test/v1/b", { credentials: "include" });
    const xhr = new net.XMLHttpRequest();
    const done = new Promise((resolve) => (xhr.onloadend = resolve));
    xhr.open("GET", "https://api.test/v1/c");
    xhr.send();
    await done;
    const withCookies = new net.XMLHttpRequest();
    const ended = new Promise((resolve) => (withCookies.onloadend = resolve));
    withCookies.open("GET", "https://api.test/v1/d");
    withCookies.withCredentials = true;
    withCookies.send();
    await ended;
    assert.deepEqual(gmCalls.map((call) => call.anonymous), [true, false, true, false]);
  });

  it("gives a body-less status no body, and fails like fetch: TypeError for a network error, AbortError when aborted", async () => {
    assert.equal((await network({ status: 204 }).net.fetch("https://api.test/v1/x")).body, null);
    await assert.rejects(network(new TypeError("ext2userscript: request failed")).net.fetch("https://api.test/v1/x"), TypeError);
    await assert.rejects(network({ status: 0 }).net.fetch("https://api.test/v1/x"), /Failed to fetch/);
    const controller = new AbortController();
    const { net, gmCalls } = network();
    const pending = net.fetch("https://api.test/v1/x", { signal: controller.signal });
    controller.abort();
    await pending.catch(() => {});
    assert.equal((gmCalls[0].signal as AbortSignal).aborted, true);
  });

  it("sends a form as its text with its content type, and binary as a Blob", async () => {
    const { net, gmCalls } = network();
    await net.fetch("https://api.test/v1/form", { method: "POST", body: new URLSearchParams({ q: "a b" }) });
    await net.fetch("https://api.test/v1/bin", { method: "PUT", body: new Uint8Array([1, 2, 3]) });
    assert.deepEqual([gmCalls[0].data, gmCalls[0].headers?.["content-type"]], ["q=a+b", "application/x-www-form-urlencoded;charset=UTF-8"]);
    assert.ok(gmCalls[1].data instanceof Blob);
    assert.equal((gmCalls[1].data as Blob).size, 3);
  });
});

describe("XMLHttpRequest", () => {
  it("plays a permitted cross-origin request out through gm.xmlHttpRequest, with the events in XHR order", async () => {
    const { net, gmCalls } = network({ status: 200, responseHeaders: "content-type: application/json\r\n", response: bytes('{"n":1}') });
    const xhr = new net.XMLHttpRequest();
    const seen: string[] = [];
    xhr.onreadystatechange = () => seen.push(`state ${xhr.readyState}`);
    for (const type of ["loadstart", "progress", "load", "loadend"]) xhr.addEventListener(type, () => seen.push(type));
    xhr.open("post", "https://api.test/v1/x");
    xhr.setRequestHeader("X-A", "1");
    xhr.setRequestHeader("x-a", "2");
    xhr.responseType = "json";
    const done = new Promise((resolve) => (xhr.onload = resolve));
    xhr.send("payload");
    await done;
    assert.deepEqual([xhr.status, xhr.response, xhr.getResponseHeader("Content-Type"), xhr.getAllResponseHeaders()], [200, { n: 1 }, "application/json", "content-type: application/json\r\n"]);
    assert.deepEqual(seen, ["state 1", "loadstart", "state 2", "state 3", "progress", "state 4", "load", "loadend"]);
    assert.deepEqual([gmCalls[0].method, gmCalls[0].data, gmCalls[0].headers], ["POST", "payload", { "X-A": "1, 2" }]);
  });

  it("reports a failed request with readyState 4, status 0 and error, and an aborted one with abort", async () => {
    const failed = new (network(new TypeError("down")).net.XMLHttpRequest)();
    const events: string[] = [];
    failed.addEventListener("error", () => events.push("error"));
    const ended = new Promise((resolve) => failed.addEventListener("loadend", resolve));
    failed.open("GET", "https://api.test/v1/x");
    failed.send();
    await ended;
    assert.deepEqual([events, failed.readyState, failed.status], [["error"], 4, 0]);

    const { net, gmCalls } = network();
    const aborted = new net.XMLHttpRequest();
    const order: string[] = [];
    for (const type of ["abort", "loadend", "load"]) aborted.addEventListener(type, () => order.push(type));
    aborted.open("GET", "https://api.test/v1/x");
    aborted.send();
    aborted.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual([order, aborted.readyState, (gmCalls[0].signal as AbortSignal).aborted], [["abort", "loadend"], 0, true]);
  });

  it("hands any other request to the page's own XMLHttpRequest, setting only what was changed, so a synchronous one works", () => {
    const opened: unknown[][] = [];
    /** Like a page's XMLHttpRequest: a synchronous request refuses a response type or a timeout, even the default ones. */
    class PageXhr extends EventTarget {
      upload = new EventTarget();
      readyState = 4;
      status = 200;
      responseText = "native";
      withCredentials = false;
      #sync = false;
      #type = "";
      get responseType() { return this.#type; }
      set responseType(value: string) {
        if (this.#sync) throw new DOMException("The response type cannot be changed for synchronous requests made from a document.", "InvalidAccessError");
        this.#type = value;
      }
      set timeout(_value: number) {
        if (this.#sync) throw new DOMException("Timeouts cannot be set for synchronous requests made from a document.", "InvalidAccessError");
      }
      open(...args: unknown[]) {
        opened.push(args);
        this.#sync = args[2] === false;
      }
      send() {}
    }
    const { net } = network({}, { XMLHttpRequest: PageXhr as unknown as typeof XMLHttpRequest });
    const xhr = new net.XMLHttpRequest();
    xhr.open("GET", "/settings.json", false);
    xhr.send();
    assert.deepEqual([opened[0].slice(0, 3), xhr.status, xhr.responseText], [["GET", "https://page.test/settings.json", false], 200, "native"]);
    const typed = new net.XMLHttpRequest();
    typed.responseType = "json";
    typed.open("GET", "/a.json");
    assert.equal(typed.responseType, "json");
    assert.throws(() => xhr.open("GET", "https://api.test/v1/x", false), /synchronous request can't go through GM_xmlhttpRequest/);
  });

  it("answers an extension file from the asset table, synchronously when asked", () => {
    const { net } = network();
    const xhr = new net.XMLHttpRequest();
    const seen: string[] = [];
    xhr.onload = () => seen.push("load");
    xhr.open("GET", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/data/info%20file.json", false);
    xhr.send();
    assert.deepEqual([xhr.readyState, xhr.status, xhr.responseText, xhr.getResponseHeader("content-type"), seen], [4, 200, '{"kind":"info"}', "application/json", ["load"]]);
    const missing = new net.XMLHttpRequest();
    missing.open("GET", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/missing.json", false);
    missing.send();
    assert.deepEqual([missing.readyState, missing.status], [4, 0]);
  });
});
