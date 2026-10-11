// The background's building blocks: tab identity, lifecycle checks, localStorage and the global object.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/runtime/chrome.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { createBackgroundGlobal } from "../../src/runtime/global.ts";
import { tabIdentity } from "../../src/runtime/identity.ts";
import { checkLifecycle } from "../../src/runtime/lifecycle.ts";
import { createLocalStorage } from "../../src/runtime/local-storage.ts";
import { createHub } from "../support/gm-hub.ts";
import { sleep } from "../support/time.ts";

describe("tabIdentity", () => {
  const memory = () => {
    const items = new Map<string, string>();
    return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
  };

  it("keeps a tab's id in sessionStorage", async () => {
    const gm = createGm(createHub().tab());
    const store = memory();
    const first = await tabIdentity(gm, "t", false, store);
    assert.ok(Number.isInteger(first) && first > 0 && first < 2 ** 31);
    assert.equal(await tabIdentity(gm, "t", false, store), first);
  });

  it("gives up an id another live page is beating with, as a duplicated tab's copied sessionStorage would", async () => {
    const hub = createHub();
    const gm = createGm(hub.tab());
    const store = memory();
    const first = await tabIdentity(gm, "t", false, store);
    await gm.setValue(`x2u:t:tab:${first}`, { url: "x", title: "x", since: Date.now(), ts: Date.now() });
    const second = await tabIdentity(gm, "t", false, store);
    assert.notEqual(second, first);
    assert.equal(store.getItem("x2u:t:tab-id"), String(second));
  });

  it("gives a frame a fresh id, and survives a sessionStorage that throws", async () => {
    const gm = createGm(createHub().tab());
    const store = memory();
    assert.notEqual(await tabIdentity(gm, "t", true, store), await tabIdentity(gm, "t", true, store));
    assert.equal(store.getItem("x2u:t:tab-id"), null);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => {} };
    assert.ok((await tabIdentity(gm, "t", false, broken)) > 0);
  });
});

describe("checkLifecycle", () => {
  it("reports install, then nothing, then an update, and onStartup only for a new session after install", async () => {
    const hub = createHub();
    const gm = createGm(hub.tab());
    assert.deepEqual(await checkLifecycle(gm, "t", "1.0", 50), { installed: { reason: "install" }, startup: false });
    assert.deepEqual(await checkLifecycle(gm, "t", "1.0", 50), { installed: undefined, startup: false });
    assert.deepEqual(await checkLifecycle(gm, "t", "1.1", 50), { installed: { reason: "update", previousVersion: "1.0" }, startup: false });
    await sleep(80); // the session stamp goes stale: the browser "restarted"
    assert.deepEqual(await checkLifecycle(gm, "t", "1.1", 50), { installed: undefined, startup: true });
  });

  it("clears storage.session in a new session, and only then", async () => {
    const hub = createHub();
    const gm = createGm(hub.tab());
    await checkLifecycle(gm, "t", "1", 50);
    await gm.setValue("x2u:t:s:session:k", 1);
    await gm.setValue("x2u:t:s:local:k", 2);
    await checkLifecycle(gm, "t", "1", 50);
    assert.equal(hub.store.get("x2u:t:s:session:k"), 1);
    await sleep(80);
    await checkLifecycle(gm, "t", "1", 50);
    assert.equal(hub.store.has("x2u:t:s:session:k"), false);
    assert.equal(hub.store.get("x2u:t:s:local:k"), 2);
  });
});

describe("createLocalStorage", () => {
  it("loads saved values, works synchronously, and saves writes", async () => {
    const hub = createHub();
    const gm = createGm(hub.tab());
    await gm.setValue("x2u:t:ls:saved", "yes");
    const storage = await createLocalStorage(gm, "t", createLogger("test"));
    assert.equal(storage.getItem("saved"), "yes");
    storage.setItem("n", 5 as unknown as string);
    assert.equal(storage.getItem("n"), "5");
    (storage as unknown as Record<string, string>).theme = "dark";
    assert.equal(storage.getItem("theme"), "dark");
    assert.equal((storage as unknown as Record<string, string>).saved, "yes");
    assert.equal(storage.length, 3);
    assert.deepEqual(Object.keys(storage).sort(), ["n", "saved", "theme"]);
    storage.removeItem("saved");
    assert.equal(storage.getItem("missing"), null);
    await sleep(5);
    assert.deepEqual([...hub.store.entries()].filter(([key]) => key.startsWith("x2u:t:ls:")).sort(), [["x2u:t:ls:n", "5"], ["x2u:t:ls:theme", "dark"]]);
    storage.clear();
    assert.equal(storage.length, 0);
  });
});

describe("createBackgroundGlobal", () => {
  it("adds the background's members and makes self and globalThis point to itself", () => {
    const { global } = createBackgroundGlobal({ chrome: "the chrome object" });
    const g = global as unknown as Record<string, unknown>;
    assert.equal(g.chrome, "the chrome object");
    assert.equal(g.self, global);
    assert.equal(g.globalThis, global);
    assert.equal("chrome" in global, true);
  });

  it("binds native methods to the real global, keeps constructors as they are, and writes through", () => {
    const { global } = createBackgroundGlobal({});
    const g = global as unknown as Record<string, unknown>;
    assert.equal(typeof g.setTimeout, "function");
    assert.equal(g.setTimeout, g.setTimeout, "the same bound function each time");
    assert.equal(g.Promise, Promise);
    g.x2uWritten = 1;
    assert.equal((globalThis as unknown as Record<string, unknown>).x2uWritten, 1);
    delete g.x2uWritten;
    assert.equal("x2uWritten" in globalThis, false);
  });

  it("fires install and activate at listeners added with self.addEventListener", () => {
    const { global, fire } = createBackgroundGlobal({});
    const seen: string[] = [];
    const add = (global as unknown as { addEventListener(type: string, fn: (event: { type: string; waitUntil(): void }) => void): void }).addEventListener;
    add("install", (event) => {
      event.waitUntil();
      seen.push(event.type);
    });
    add("activate", (event) => seen.push(event.type));
    fire("install");
    fire("activate");
    assert.deepEqual(seen, ["install", "activate"]);
  });

  it("leaves a function the background put on the global as it is, static members included", () => {
    const { global } = createBackgroundGlobal({});
    const g = global as unknown as Record<string, unknown>;
    const lib = Object.assign(function x2uLib() {}, { utc: 1 });
    try {
      g.x2uLib = lib;
      assert.equal(g.x2uLib, lib);
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).x2uLib;
    }
  });

  it("keeps a worker's on<event> handlers on the background, where the page can't reach them, and fires oninstall", () => {
    const { global, fire } = createBackgroundGlobal({});
    const g = global as unknown as Record<string, unknown>;
    const real = globalThis as unknown as Record<string, unknown>;
    const seen: string[] = [];
    const onmessage = () => seen.push("message");
    try {
      g.onmessage = onmessage;
      g.oninstall = (event: { type: string }) => seen.push(event.type);
      assert.equal(g.onmessage, onmessage);
      assert.equal(real.onmessage, undefined);
      fire("install");
      assert.deepEqual(seen, ["install"]);
    } finally {
      delete real.onmessage;
      delete real.oninstall;
    }
  });
});
