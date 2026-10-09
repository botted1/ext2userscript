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
