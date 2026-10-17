import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGm } from "../../src/runtime/gm.ts";
import { startRegistry, type Registry, type RegistryTiming } from "../../src/runtime/registry.ts";
import { createHub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

const page = () => ({ url: "https://example.com/", title: "Example", frame: false, active: false, activeAt: 0 });
/** Heartbeats far apart: only the roster doorbell can explain fast discovery. */
const SLOW: RegistryTiming = { heartbeatMs: 10_000, staleMs: 60_000 };
const FAST: RegistryTiming = { heartbeatMs: 20, staleMs: 150 };

describe("tab registry", () => {
  it("finds a new tab through the roster, before the next heartbeat", async () => {
    const hub = createHub();
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, SLOW);
    const added: number[] = [];
    a.onAdded((tab) => added.push(tab.id));
    const b = await startRegistry(createGm(hub.tab()), "t", 2, page, SLOW);
    try {
      await eventually(() => added.includes(2), 300);
      assert.deepEqual(b.live().map((tab) => tab.id), [1]);
      assert.equal(b.live()[0].url, "https://example.com/");
      assert.equal(b.live()[0].since, a.self().since);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("tells the other tabs which extension page a tab has open", async () => {
    const hub = createHub();
    let open: "popup" | undefined;
    const a = await startRegistry(createGm(hub.tab()), "t", 1, () => ({ ...page(), ...(open ? { page: open } : {}) }), SLOW);
    const b = await startRegistry(createGm(hub.tab()), "t", 2, page, SLOW);
    try {
      await eventually(() => b.live().length === 1, 300);
      assert.equal(b.live()[0].page, undefined);
      open = "popup";
      await a.touch();
      await eventually(() => b.live()[0]?.page === "popup", 300);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("sees a tab leave at once, and come back on rejoin with a new since", async () => {
    const hub = createHub();
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, SLOW);
    const b = await startRegistry(createGm(hub.tab()), "t", 2, page, SLOW);
    try {
      await eventually(() => a.live().length === 1, 300);
      const events: string[] = [];
      let changes = 0;
      a.onAdded((tab) => events.push(`+${tab.id}`));
      a.onRemoved((id) => events.push(`-${id}`));
      a.onChange(() => changes++);
      const firstSince = b.self().since;
      await b.leave();
      assert.equal(b.self().present, false);
      await eventually(() => events.join() === "-2", 300);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await b.rejoin();
      await eventually(() => events.join() === "-2,+2", 300);
      assert.ok(b.self().since > firstSince);
      assert.ok(changes >= 2);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("drops a tab whose heartbeat goes stale and deletes its keys", async () => {
    const hub = createHub();
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, FAST);
    // A crashed tab: its last heartbeat and outbox stay behind, and nothing runs in it to beat or come back.
    hub.tab().GM_setValue?.("x2u:t:tab:2", { ...page(), since: Date.now(), ts: Date.now() });
    hub.tab().GM_setValue?.("x2u:t:out:2", { epoch: "e", msgs: [] });
    const removed: number[] = [];
    a.onRemoved((id) => removed.push(id));
    try {
      await eventually(() => removed.includes(2), 1_000);
      assert.equal(hub.store.has("x2u:t:tab:2"), false);
      assert.equal(hub.store.has("x2u:t:out:2"), false);
    } finally {
      await a.stop();
    }
  });

  it("cleans up values it cannot read instead of throwing", async () => {
    const hub = createHub();
    hub.tab().GM_setValue?.("x2u:t:tab:99", "not a heartbeat");
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, FAST);
    try {
      assert.deepEqual(a.live(), []);
      assert.equal(hub.store.has("x2u:t:tab:99"), false);
    } finally {
      await a.stop();
    }
  });

  it("stop removes this tab's key", async () => {
    const hub = createHub();
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, FAST);
    assert.equal(hub.store.has("x2u:t:tab:1"), true);
    await a.stop();
    assert.equal(hub.store.has("x2u:t:tab:1"), false);
  });

  it("keeps live peers when the machine sleeps for longer than staleMs", async () => {
    const hub = createHub();
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, FAST);
    const b = await startRegistry(createGm(hub.tab()), "t", 2, page, FAST);
    const removed: number[] = [];
    a.onRemoved((id) => removed.push(id));
    b.onRemoved((id) => removed.push(id));
    const realNow = Date.now;
    try {
      await eventually(() => a.live().length === 1 && b.live().length === 1, 300);
      // A sleep, as both tabs see it: the clock jumps an hour, so each peer's last heartbeat is an hour old.
      Date.now = () => realNow() + 3_600_000;
      await sleep(3 * FAST.staleMs);
      assert.deepEqual(removed, []);
      assert.deepEqual(a.live().map((tab) => tab.id), [2]);
      assert.deepEqual(b.live().map((tab) => tab.id), [1]);
      assert.equal(hub.store.has("x2u:t:tab:1"), true);
      assert.equal(hub.store.has("x2u:t:tab:2"), true);
    } finally {
      Date.now = realNow;
      await a.stop();
      await b.stop();
    }
  });

  it("keeps peers connected while their heartbeats stay fresh", async () => {
    const hub = createHub();
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, FAST);
    const b = await startRegistry(createGm(hub.tab()), "t", 2, page, FAST);
    const removed: number[] = [];
    a.onRemoved((id) => removed.push(id));
    b.onRemoved((id) => removed.push(id));
    try {
      await eventually(() => a.live().length === 1 && b.live().length === 1, 300);
      await sleep(500);
      assert.deepEqual(removed, []);
      assert.deepEqual(a.live().map((tab) => tab.id), [2]);
      assert.deepEqual(b.live().map((tab) => tab.id), [1]);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("sees two joins at once when the hub coalesces deliveries", async () => {
    const hub = createHub({ coalesce: true, delayMs: 20 });
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, SLOW);
    const b = await startRegistry(createGm(hub.tab()), "t", 2, page, SLOW);
    const c = await startRegistry(createGm(hub.tab()), "t", 3, page, SLOW);
    try {
      await eventually(() => a.live().map((tab) => tab.id).sort().join() === "2,3", 300);
    } finally {
      await a.stop();
      await b.stop();
      await c.stop();
    }
  });

  it("finishes its first scan before startRegistry resolves", async () => {
    const hub = createHub();
    const writer = createGm(hub.tab());
    const peers: Registry[] = [];
    for (let id = 2; id <= 6; id++) peers.push(await startRegistry(createGm(hub.tab()), "t", id, page, SLOW));
    for (let id = 90; id <= 94; id++) await writer.setValue(`x2u:t:tab:${id}`, "junk");
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, SLOW);
    try {
      assert.deepEqual(a.live().map((tab) => tab.id).sort(), [2, 3, 4, 5, 6]);
      for (let id = 90; id <= 94; id++) assert.equal(hub.store.has(`x2u:t:tab:${id}`), false);
    } finally {
      await a.stop();
      for (const peer of peers) await peer.stop();
    }
  });

  it("keeps the other subscribers going when one throws", async () => {
    const hub = createHub();
    const errors: unknown[] = [];
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, SLOW, (error) => errors.push(error));
    const added: number[] = [];
    let changes = 0;
    a.onAdded(() => {
      throw new Error("bad subscriber");
    });
    a.onAdded((tab) => added.push(tab.id));
    a.onChange(() => changes++);
    const b = await startRegistry(createGm(hub.tab()), "t", 2, page, SLOW);
    try {
      await eventually(() => added.includes(2) && changes >= 1, 300);
      assert.deepEqual(errors.map((error) => (error as Error).message), ["bad subscriber"]);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("still deletes a leaving tab's key when an onChange subscriber throws", async () => {
    const hub = createHub();
    const errors: unknown[] = [];
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, SLOW);
    const b = await startRegistry(createGm(hub.tab()), "t", 2, page, SLOW, (error) => errors.push(error));
    b.onChange(() => {
      throw new Error("bad subscriber");
    });
    try {
      await eventually(() => a.live().length === 1, 300);
      await b.leave();
      assert.equal(hub.store.has("x2u:t:tab:2"), false);
      assert.deepEqual(errors.map((error) => (error as Error).message), ["bad subscriber"]);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("ignores tab keys with a non-canonical id, so they cannot clean up a live tab", async () => {
    const hub = createHub();
    const writer = createGm(hub.tab());
    const a = await startRegistry(createGm(hub.tab()), "t", 1, page, SLOW);
    const b = await startRegistry(createGm(hub.tab()), "t", 2, page, SLOW);
    try {
      await eventually(() => a.live().length === 1, 300);
      await writer.setValue("x2u:t:out:2", { epoch: "e", msgs: [] });
      await writer.setValue("x2u:t:tab:02", "junk"); // Number("02") is 2, but this is not tab 2's key
      await writer.setValue("x2u:t:roster", { from: 9, t: Date.now() }); // ring the doorbell, so a scans now
      await sleep(20);
      assert.equal(hub.store.has("x2u:t:out:2"), true);
      assert.deepEqual(a.live().map((tab) => tab.id), [2]);
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
