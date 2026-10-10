import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/runtime/chrome.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { createStorage, type StorageChange } from "../../src/runtime/storage.ts";
import { createHub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

type Changes = Record<string, StorageChange>;
type StorageArea = {
  get(query?: unknown, callback?: (items: Record<string, unknown>) => void): Promise<Record<string, unknown>> | undefined;
  set(items: Record<string, unknown>, callback?: () => void): Promise<void> | undefined;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
  onChanged: { addListener(fn: (changes: Changes) => void): void };
};
type Storage = { local: StorageArea; sync: StorageArea; session: StorageArea; onChanged: { addListener(fn: (changes: Changes, area: string) => void): void } };

const tab = (hub: ReturnType<typeof createHub>) => createStorage(createGm(hub.tab()), "t", createLogger("test")) as unknown as Storage;

describe("chrome.storage", () => {
  it("stores one GM value per key under the namespace and area", async () => {
    const hub = createHub();
    const storage = tab(hub);
    await storage.local.set({ a: 1, b: { c: [1, 2] } });
    await storage.sync.set({ a: "sync" });
    assert.deepEqual(Object.fromEntries(hub.store), {
      "x2u:t:s:local:a": 1,
      "x2u:t:s:local:b": { c: [1, 2] },
      "x2u:t:s:sync:a": "sync",
      "x2u:t:storage-keys": hub.store.get("x2u:t:storage-keys"),
    });
  });

  it("gets everything, one key, a list of keys, or keys with defaults", async () => {
    const storage = tab(createHub());
    await storage.local.set({ a: 1, b: 2, "x:y": 3 });
    assert.deepEqual(await storage.local.get(null), { a: 1, b: 2, "x:y": 3 });
    assert.deepEqual(await storage.local.get(), { a: 1, b: 2, "x:y": 3 });
    assert.deepEqual(await storage.local.get("a"), { a: 1 });
    assert.deepEqual(await storage.local.get(["a", "missing"]), { a: 1 });
    assert.deepEqual(await storage.local.get({ a: 0, missing: "default" }), { a: 1, missing: "default" });
  });

  it("supports callbacks", async () => {
    const storage = tab(createHub());
    await new Promise<void>((resolve) => storage.local.set({ a: 1 }, resolve));
    const items = await new Promise((resolve) => storage.local.get("a", resolve));
    assert.deepEqual(items, { a: 1 });
  });

  it("removes and clears only its own area", async () => {
    const storage = tab(createHub());
    await storage.local.set({ a: 1, b: 2, c: 3 });
    await storage.sync.set({ a: "kept" });
    await storage.local.remove("a");
    assert.deepEqual(await storage.local.get(null), { b: 2, c: 3 });
    await storage.local.remove(["b"]);
    await storage.local.clear();
    assert.deepEqual(await storage.local.get(null), {});
    assert.deepEqual(await storage.sync.get(null), { a: "kept" });
  });

  it("follows Chrome's value rules: undefined is skipped, a function becomes {}, a Date becomes a string", async () => {
    const storage = tab(createHub());
    await storage.local.set({ u: undefined, f: () => 1, d: new Date(0) });
    assert.deepEqual(await storage.local.get(null), { f: {}, d: "1970-01-01T00:00:00.000Z" });
  });

  it("fires onChanged in the writing tab with one event per set() call", async () => {
    const storage = tab(createHub());
    await storage.local.set({ a: 1 });
    const events: Array<[Changes, string]> = [];
    storage.onChanged.addListener((changes, area) => events.push([changes, area]));
    await sleep(20);
    await storage.local.set({ a: 2, b: 3 });
    await eventually(() => events.length > 0, 1000);
    await sleep(20);
    assert.deepEqual(events, [[{ a: { oldValue: 1, newValue: 2 }, b: { newValue: 3 } }, "local"]]);
  });

  it("tells other tabs about changes to existing keys, new keys and removals, per area", async () => {
    const hub = createHub();
    const writer = tab(hub);
    const reader = tab(hub);
    await writer.local.set({ existing: 1 });
    await sleep(20); // the reader has the key before it starts listening, so its creation isn't news
    const events: Array<[Changes, string]> = [];
    const localOnly: Changes[] = [];
    reader.onChanged.addListener((changes, area) => events.push([changes, area]));
    reader.local.onChanged.addListener((changes) => localOnly.push(changes));
    await sleep(20);

    await writer.local.set({ existing: 2 });
    await eventually(() => events.length === 1, 1000);
    assert.deepEqual(events[0], [{ existing: { oldValue: 1, newValue: 2 } }, "local"]);

    await writer.sync.set({ created: "new" });
    await eventually(() => events.length === 2, 1000);
    assert.deepEqual(events[1], [{ created: { newValue: "new" } }, "sync"]);

    await writer.local.remove("existing");
    await eventually(() => events.length === 3, 1000);
    assert.deepEqual(events[2], [{ existing: { oldValue: 2 } }, "local"]);
    assert.equal(localOnly.length, 2);
  });

  it("keeps working when a tab adds a listener after keys already exist in another area", async () => {
    const hub = createHub();
    const writer = tab(hub);
    await writer.session.set({ s: 1 });
    const reader = tab(hub);
    const events: string[] = [];
    reader.onChanged.addListener((changes, area) => events.push(`${area}:${Object.keys(changes).join(",")}`));
    await sleep(20);
    await writer.session.set({ s: 2 });
    await eventually(() => events.length === 1, 1000);
    assert.deepEqual(events, ["session:s"]);
  });

  it("rejects the members Chrome has but this version doesn't, with a named error, and has no others", async () => {
    const storage = tab(createHub()) as unknown as { managed: { get(): Promise<unknown> }; local: Record<string, unknown> };
    await assert.rejects(storage.managed.get(), /chrome\.storage\.managed\.get is not available/);
    await assert.rejects((storage.local.getBytesInUse as () => Promise<unknown>)(), /chrome\.storage\.local\.getBytesInUse is not available/);
    assert.equal(storage.local.notAMember, undefined);
  });
});
