import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGm } from "../../src/runtime/gm.ts";
import { startRegistry, type RegistryTiming } from "../../src/runtime/registry.ts";
import { createHub } from "../support/gm-hub.ts";
import { eventually } from "../support/time.ts";

const page = () => ({ url: "https://example.com/", title: "Example" });
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
    const crashed = await startRegistry(createGm(hub.tab()), "t", 2, page, SLOW); // beats once, then never again
    hub.tab().GM_setValue?.("x2u:t:out:2", { epoch: "e", msgs: [] });
    const removed: number[] = [];
    a.onRemoved((id) => removed.push(id));
    try {
      await eventually(() => removed.includes(2), 1_000);
      assert.equal(hub.store.has("x2u:t:tab:2"), false);
      assert.equal(hub.store.has("x2u:t:out:2"), false);
    } finally {
      await a.stop();
      await crashed.stop();
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
});
