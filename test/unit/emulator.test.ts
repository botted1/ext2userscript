import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMeta } from "../../bench/emulator/meta.ts";
import { createValueStore } from "../../bench/emulator/values.ts";
import { renderMeta } from "../support/userscript.ts";

describe("createValueStore", () => {
  it("returns copies, fires listeners with remote set correctly, and publishes local writes", () => {
    const published: Array<[string, unknown]> = [];
    const store = createValueStore({ a: { n: 1 } }, (key, value) => published.push([key, value]));
    (store.GM_getValue("a") as { n: number }).n = 99;
    assert.deepEqual(store.GM_getValue("a"), { n: 1 });

    const events: unknown[] = [];
    store.GM_addValueChangeListener("a", (key, oldValue, newValue, remote) => events.push({ key, oldValue, newValue, remote }));
    store.GM_setValue("a", { n: 2 });
    store.applyRemote("a", { n: 3 });
    store.GM_deleteValue("a");
    assert.deepEqual(events, [
      { key: "a", oldValue: { n: 1 }, newValue: { n: 2 }, remote: false },
      { key: "a", oldValue: { n: 2 }, newValue: { n: 3 }, remote: true },
      { key: "a", oldValue: { n: 3 }, newValue: undefined, remote: false },
    ]);
    assert.deepEqual(published, [["a", { n: 2 }], ["a", undefined]]);
    assert.deepEqual(store.GM_listValues(), []);
    assert.equal(store.GM_getValue("a", "fallback"), "fallback");
  });

  it("stops calling a removed listener", () => {
    const store = createValueStore({}, () => {});
    let calls = 0;
    const id = store.GM_addValueChangeListener("k", () => calls++);
    store.GM_setValue("k", 1);
    store.GM_removeValueChangeListener(id);
    store.GM_setValue("k", 2);
    assert.equal(calls, 1);
  });

  it("publishes a write made by a listener after the write that triggered it", () => {
    const published: Array<[string, unknown]> = [];
    const store = createValueStore({}, (key, value) => published.push([key, value]));
    store.GM_addValueChangeListener("k", (key, oldValue, newValue) => {
      if (newValue === 1) store.GM_setValue("k", 2);
    });
    store.GM_setValue("k", 1);
    assert.deepEqual(published, [["k", 1], ["k", 2]]);
    assert.equal(store.GM_getValue("k"), 2);
  });

  it("publishes a write made by a listener after the delete that triggered it", () => {
    const published: Array<[string, unknown]> = [];
    const store = createValueStore({ k: 0 }, (key, value) => published.push([key, value]));
    store.GM_addValueChangeListener("k", (key, oldValue, newValue) => {
      if (newValue === undefined) store.GM_setValue("k", 9);
    });
    store.GM_deleteValue("k");
    assert.deepEqual(published, [["k", undefined], ["k", 9]]);
    assert.equal(store.GM_getValue("k"), 9);
  });

  it("keeps writing, publishing and notifying when a listener throws", () => {
    const published: Array<[string, unknown]> = [];
    const errors: unknown[] = [];
    const store = createValueStore({}, (key, value) => published.push([key, value]), (error) => errors.push(error));
    const boom = new Error("boom");
    const seen: unknown[] = [];
    store.GM_addValueChangeListener("k", () => {
      throw boom;
    });
    store.GM_addValueChangeListener("k", (key, oldValue, newValue) => seen.push(newValue));

    assert.doesNotThrow(() => store.GM_setValue("k", 1));
    assert.deepEqual(published, [["k", 1]]);
    assert.deepEqual(seen, [1]);
    assert.deepEqual(errors, [boom]);
    assert.equal(store.GM_getValue("k"), 1);

    assert.doesNotThrow(() => store.applyRemote("k", 2), "a remote change is isolated the same way");
    assert.deepEqual(seen, [1, 2]);
    assert.deepEqual(errors, [boom, boom]);
  });
});

describe("parseMeta", () => {
  it("reads back what renderMeta writes", () => {
    const text = `${renderMeta({
      name: "t",
      match: ["https://a.example/*"],
      excludeMatch: ["https://a.example/x*"],
      grant: ["GM_getValue"],
      connect: ["api.example"],
      runAt: "document-start",
      isolated: true,
    })}\ncode();`;
    assert.deepEqual(parseMeta(text), {
      name: "t",
      match: ["https://a.example/*"],
      excludeMatch: ["https://a.example/x*"],
      grant: ["GM_getValue"],
      connect: ["api.example"],
      runAt: "document-start",
    });
  });

  it("treats @grant none as no grants", () => {
    assert.deepEqual(parseMeta(renderMeta({ name: "t", match: [], grant: [] })).grant, []);
  });

  it("rejects a script without a metadata block", () => {
    assert.throws(() => parseMeta("code();"), /no ==UserScript== block/);
  });
});
