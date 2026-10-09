import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import {
  CORE_METHODS,
  createGm,
  GmUnavailableError,
  grantsFor,
  GRANTS,
  readManagerApi,
  type GmApi,
  type GmCookie,
  type ValueListener,
} from "../../src/runtime/gm.ts";

describe("grant table", () => {
  it("always includes the core set", () => {
    assert.deepEqual(grantsFor([]), [
      "GM_addElement", "GM_addValueChangeListener", "GM_deleteValue", "GM_getValue",
      "GM_listValues", "GM_removeValueChangeListener", "GM_setValue",
    ]);
  });

  it("adds what a conversion needs, sorted and without duplicates", () => {
    assert.deepEqual(grantsFor(["cookie", "xmlHttpRequest", "getValue"]), [
      "GM_addElement", "GM_addValueChangeListener", "GM_cookie", "GM_deleteValue", "GM_getValue",
      "GM_listValues", "GM_removeValueChangeListener", "GM_setValue", "GM_xmlhttpRequest",
    ]);
  });

  it("names at least one GM function for every core method", () => {
    for (const method of CORE_METHODS) assert.ok(GRANTS[method].length > 0, method);
  });
});

describe("createGm", () => {
  it("detects capabilities from the functions the manager provides", () => {
    const full = createGm({
      GM_addValueChangeListener: () => 1,
      GM_registerMenuCommand: () => 1,
      GM_cookie: { list() {}, set() {}, delete() {} },
      GM_info: { scriptHandler: "Tampermonkey" },
    });
    assert.deepEqual(full.caps, { valueListeners: true, menus: true, cookies: true });
    assert.equal(full.handler, "Tampermonkey");
    const bare = createGm({});
    assert.deepEqual(bare.caps, { valueListeners: false, menus: false, cookies: false });
    assert.equal(bare.handler, "unknown");
  });

  it("makes the GM call before returning, so only the result is async", async () => {
    const calls: string[] = [];
    const gm = createGm({
      GM_setValue: (key) => { calls.push(`set ${key}`); },
      GM_addElement: () => { calls.push("addElement"); return {} as Element; },
    });
    const pending = [gm.setValue("a", 1), gm.addElement(null, "style", {})];
    assert.deepEqual(calls, ["set a", "addElement"]);
    await Promise.all(pending);
  });

  it("stores JSON: Dates become strings, functions vanish, undefined deletes", async () => {
    const stored: Record<string, unknown> = {};
    const deleted: string[] = [];
    const gm = createGm({
      GM_setValue: (key, value) => { stored[key] = value; },
      GM_deleteValue: (key) => { deleted.push(key); },
    });
    await gm.setValue("d", { at: new Date(0), skip: undefined, fn: () => 1 });
    assert.deepEqual(stored.d, { at: "1970-01-01T00:00:00.000Z" });
    await gm.setValue("gone", undefined);
    assert.deepEqual(deleted, ["gone"]);
  });

  it("rejects values that cannot be stored as JSON", async () => {
    const gm = createGm({ GM_setValue: () => {} });
    await assert.rejects(gm.setValue("big", 1n), TypeError);
  });

  it("rejects, rather than throws, when a GM function is missing", async () => {
    const gm = createGm({});
    const pending = gm.cookie.list({ url: "https://example.com/" });
    await assert.rejects(pending, (error: unknown) => error instanceof GmUnavailableError && /GM_cookie/.test((error as Error).message));
    await assert.rejects(gm.getValue("x"), GmUnavailableError);
  });

  it("passes values, listeners and menu commands through", async () => {
    const store = new Map<string, unknown>([["k", 1]]);
    let listener: ValueListener | undefined;
    const removed: unknown[] = [];
    const gm = createGm({
      GM_getValue: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      GM_listValues: () => [...store.keys()],
      GM_addValueChangeListener: (_key, fn) => { listener = fn; return "L1"; },
      GM_removeValueChangeListener: (id) => { removed.push(id); },
      GM_registerMenuCommand: () => 7,
      GM_unregisterMenuCommand: (id) => { removed.push(id); },
    });
    assert.equal(await gm.getValue("k"), 1);
    assert.equal(await gm.getValue("missing", "fallback"), "fallback");
    const keys = await gm.listValues();
    keys.push("mutated");
    assert.deepEqual(await gm.listValues(), ["k"]);
    assert.equal(await gm.addValueChangeListener("k", () => {}), "L1");
    assert.equal(typeof listener, "function");
    await gm.removeValueChangeListener("L1");
    assert.equal(await gm.registerMenuCommand("Open", () => {}), 7);
    await gm.unregisterMenuCommand(7);
    assert.deepEqual(removed, ["L1", 7]);
  });

  function fakeXhr(respond: (details: Parameters<NonNullable<GmApi["GM_xmlhttpRequest"]>>[0]) => void) {
    const aborted: string[] = [];
    const gm = createGm({
      GM_xmlhttpRequest: (details) => {
        respond(details);
        return { abort: () => { aborted.push(details.url); details.onabort({}); } };
      },
    });
    return { gm, aborted };
  }

  it("xmlHttpRequest resolves with the response on load", async () => {
    const { gm } = fakeXhr((d) => queueMicrotask(() => d.onload({ status: 201, statusText: "Created", finalUrl: d.url, responseHeaders: "a: b", response: { ok: true } })));
    const response = await gm.xmlHttpRequest({ url: "https://api.example/x", method: "POST", responseType: "json" });
    assert.deepEqual(response, { status: 201, statusText: "Created", finalUrl: "https://api.example/x", responseHeaders: "a: b", response: { ok: true } });
  });

  it("xmlHttpRequest passes method, headers, data and responseType through", async () => {
    let seen: unknown;
    const { gm } = fakeXhr((d) => {
      seen = { method: d.method, url: d.url, headers: d.headers, data: d.data, responseType: d.responseType };
      queueMicrotask(() => d.onload({ status: 200, statusText: "OK", finalUrl: d.url, responseHeaders: "", response: "" }));
    });
    await gm.xmlHttpRequest({ url: "https://x/", headers: { a: "1" }, data: "body" });
    assert.deepEqual(seen, { method: "GET", url: "https://x/", headers: { a: "1" }, data: "body", responseType: "text" });
  });

  it("xmlHttpRequest turns errors, timeouts and aborts into rejections", async () => {
    await assert.rejects(fakeXhr((d) => queueMicrotask(() => d.onerror({}))).gm.xmlHttpRequest({ url: "https://x/" }), TypeError);
    await assert.rejects(fakeXhr((d) => queueMicrotask(() => d.ontimeout({}))).gm.xmlHttpRequest({ url: "https://x/" }), { name: "TimeoutError" });
    const { gm, aborted } = fakeXhr(() => {});
    const controller = new AbortController();
    const pending = gm.xmlHttpRequest({ url: "https://x/slow", signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(aborted, ["https://x/slow"]);
  });

  it("removes its abort listener from a shared signal when a request settles", async () => {
    const signal = new AbortController().signal;
    const gm = createGm({
      GM_xmlhttpRequest: (d) => {
        queueMicrotask(() => (d.url.endsWith("/fail")
          ? d.onerror({})
          : d.onload({ status: 200, statusText: "OK", finalUrl: d.url, responseHeaders: "", response: "" })));
        return { abort() {} };
      },
    });
    await gm.xmlHttpRequest({ url: "https://x/ok", signal });
    assert.equal(getEventListeners(signal, "abort").length, 0);
    await assert.rejects(gm.xmlHttpRequest({ url: "https://x/fail", signal }), TypeError);
    assert.equal(getEventListeners(signal, "abort").length, 0);
  });

  it("rejects an aborted request even when the manager's abort() never calls onabort", async () => {
    const gm = createGm({ GM_xmlhttpRequest: () => ({ abort() {} }) });
    const controller = new AbortController();
    const pending = gm.xmlHttpRequest({ url: "https://x/hang", signal: controller.signal });
    controller.abort();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("still pending after 100 ms")), 100));
    await assert.rejects(Promise.race([pending, timeout]), { name: "AbortError" });
  });

  it("addElement passes the parent only when given one", async () => {
    const calls: unknown[][] = [];
    const gm = createGm({ GM_addElement: (...args: unknown[]) => { calls.push(args); return {} as Element; } });
    const parent = {} as Node;
    await gm.addElement(parent, "style", { textContent: "a{}" });
    await gm.addElement(null, "script", { textContent: "1" });
    assert.deepEqual(calls, [[parent, "style", { textContent: "a{}" }], ["script", { textContent: "1" }]]);
  });

  it("openInTab returns a control that closes the tab and reports the close", async () => {
    const handle = {
      closed: false,
      onclose: null as (() => void) | null,
      close() { handle.closed = true; handle.onclose?.(); },
    };
    let opened: unknown;
    const gm = createGm({ GM_openInTab: (url, options) => { opened = { url, options }; return handle; } });
    const tab = await gm.openInTab("https://example.com/", { active: false });
    assert.deepEqual(opened, { url: "https://example.com/", options: { active: false, insert: true } });
    let closeEvents = 0;
    tab.onClose(() => closeEvents++);
    tab.close();
    assert.equal(tab.closed, true);
    assert.equal(closeEvents, 1);
  });

  it("notification forwards the details", async () => {
    let shown: unknown;
    const gm = createGm({ GM_notification: (details) => { shown = details; } });
    const onclick = () => {};
    await gm.notification({ title: "T", text: "body", onclick });
    assert.deepEqual(shown, { text: "body", title: "T", image: undefined, onclick, ondone: undefined });
  });

  it("cookie methods turn callbacks into promises", async () => {
    const jar: GmCookie[] = [];
    const gm = createGm({
      GM_cookie: {
        list: (_details, callback) => callback([...jar]),
        set: (details, callback) => { jar.push({ name: details.name ?? "", value: details.value ?? "" }); callback(); },
        delete: (_details, callback) => callback("denied"),
      },
    });
    await gm.cookie.set({ url: "https://example.com/", name: "a", value: "1" });
    assert.deepEqual(await gm.cookie.list({ url: "https://example.com/" }), [{ name: "a", value: "1" }]);
    await assert.rejects(gm.cookie.delete({ url: "https://example.com/", name: "a" }), /denied/);
  });

  it("readManagerApi finds the GM functions in scope and ignores the rest", () => {
    const scope = globalThis as Record<string, unknown>;
    scope.GM_getValue = () => 1;
    scope.GM_info = { scriptHandler: "Violentmonkey" };
    try {
      const api = readManagerApi();
      assert.equal(typeof api.GM_getValue, "function");
      assert.equal(api.GM_setValue, undefined);
      assert.equal(createGm(api).handler, "Violentmonkey");
    } finally {
      delete scope.GM_getValue;
      delete scope.GM_info;
    }
  });

  it("caps.cookies is true when GM_cookie is callable with list, set and delete", () => {
    const gm = createGm({ GM_cookie: Object.assign(() => {}, { list() {}, set() {}, delete() {} }) });
    assert.equal(gm.caps.cookies, true);
  });

  it("readManagerApi keeps a callable GM_cookie", () => {
    const scope = globalThis as Record<string, unknown>;
    scope.GM_cookie = Object.assign(() => {}, { list() {}, set() {}, delete() {} });
    try {
      assert.equal(createGm(readManagerApi()).caps.cookies, true);
    } finally {
      delete scope.GM_cookie;
    }
  });
});
