// The network shim: which requests go through gm.xmlHttpRequest, and the fetch and XMLHttpRequest they get back.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GmXhrResponse, XhrRequest } from "../../src/runtime/gm.ts";
import { createNetwork, type NetworkDeps } from "../../src/runtime/net.ts";

type Reply = Partial<GmXhrResponse> | Error;

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
    assetUrl: (path) => `blob:https://page.test/${path}`,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    base: () => "https://page.test/app/index.html",
    origin: "https://page.test",
    hosts: ["https://api.test/v1/*", "*://*.cdn.test/*", "not a pattern"],
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

  it("leaves same-origin and unpermitted requests to the page, and serves extension URLs from the asset table", async () => {
    const { net, gmCalls, pageCalls } = network();
    await net.fetch("/same/origin");
    await net.fetch("https://elsewhere.test/x");
    const asset = await net.fetch("chrome-extension://abcdefghijklmnopabcdefghijklmnop/data/info%20file.json");
    assert.equal(asset.url, "chrome-extension://abcdefghijklmnopabcdefghijklmnop/data/info%20file.json");
    assert.deepEqual(pageCalls, ["https://page.test/same/origin", "https://elsewhere.test/x", "blob:https://page.test/data/info file.json"]);
    assert.equal(gmCalls.length, 0);
  });

  it("resolves a background's relative URLs against its own file, so they reach the extension's files", async () => {
    const { net, pageCalls } = network({}, { base: () => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/bg/sw.js" });
    await net.fetch("config.json");
    await net.fetch(new URL("../icon.png", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/bg/sw.js"));
    assert.deepEqual(pageCalls, ["blob:https://page.test/bg/config.json", "blob:https://page.test/icon.png"]);
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

  it("hands any other request to the page's own XMLHttpRequest, with extension URLs pointing at the asset table", () => {
    const opened: unknown[][] = [];
    class PageXhr extends EventTarget {
      upload = new EventTarget();
      readyState = 4;
      status = 200;
      responseText = "native";
      responseType = "";
      timeout = 0;
      withCredentials = false;
      open(...args: unknown[]) {
        opened.push(args);
      }
      send() {}
    }
    const { net } = network({}, { XMLHttpRequest: PageXhr as unknown as typeof XMLHttpRequest });
    const xhr = new net.XMLHttpRequest();
    xhr.open("GET", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/data.json", false);
    xhr.send();
    assert.deepEqual([opened[0].slice(0, 3), xhr.status, xhr.responseText], [["GET", "blob:https://page.test/data.json", false], 200, "native"]);
    assert.throws(() => xhr.open("GET", "https://api.test/v1/x", false), /synchronous request can't go through GM_xmlhttpRequest/);
  });
});
