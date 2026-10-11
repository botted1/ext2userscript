// The registry's tab state, ghost sweep and outbox cleanup, and the election with frames.
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { startBus } from "../../src/runtime/bus.ts";
import { leaderOf, startElection } from "../../src/runtime/elect.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { startRegistry, type TabInfo, type TabState } from "../../src/runtime/registry.ts";
import { createHub, type Hub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

const FAST = { heartbeatMs: 20, staleMs: 5_000 };
const tabState = (id: number, extra: Partial<TabState> = {}): TabState => ({ url: `https://site.test/${id}`, title: `page ${id}`, frame: false, active: false, activeAt: 0, ...extra });

async function member(t: TestContext, hub: Hub, id: number, state: () => TabState = () => tabState(id)) {
  const gm = createGm(hub.tab());
  const registry = await startRegistry(gm, "t", id, state, FAST);
  t.after(() => registry.stop());
  return { gm, registry };
}

describe("registry tab state", () => {
  it("reports other tabs' state, and their changes as soon as they touch", async (t) => {
    const hub = createHub();
    const a = await member(t, hub, 1);
    let title = "before";
    const b = await member(t, hub, 2, () => tabState(2, { title, active: true, activeAt: 5 }));
    await eventually(() => a.registry.live().length === 1, 1000);
    assert.deepEqual({ ...a.registry.live()[0], since: 0, ts: 0 }, { id: 2, url: "https://site.test/2", title: "before", frame: false, active: true, activeAt: 5, since: 0, ts: 0 });
    const updates: Array<[string, string]> = [];
    a.registry.onUpdated((tab: TabInfo, previous: TabInfo) => updates.push([previous.title, tab.title]));
    title = "after";
    await b.registry.touch();
    await eventually(() => updates.length === 1, 1000);
    assert.deepEqual(updates, [["before", "after"]]);
  });

  it("sweeps a ghost (a fresh key nobody beats for any more) within the response time, and keeps live tabs", async (t) => {
    const hub = createHub();
    const live = await member(t, hub, 2);
    // A tab that died without pagehide a moment ago: its key is fresh, but nothing answers rings for it.
    hub.store.set("x2u:t:tab:1", { ...tabState(1), since: Date.now() - 60_000, ts: Date.now() });
    const gm = createGm(hub.tab());
    const newcomer = await startRegistry(gm, "t", 3, () => tabState(3), { heartbeatMs: 10_000, staleMs: 90_000, responseMs: 100 });
    t.after(() => newcomer.stop());
    assert.deepEqual(newcomer.live().map((tab) => tab.id).sort(), [1, 2], "at first the ghost looks live");
    await eventually(() => newcomer.live().length === 1, 1000);
    assert.deepEqual(newcomer.live().map((tab) => tab.id), [2]);
    assert.equal(hub.store.has("x2u:t:tab:1"), false);
    assert.deepEqual(live.registry.live().map((tab) => tab.id), [3]);
  });

  it("deletes a departed tab's outbox along with its key", async (t) => {
    const hub = createHub();
    const a = await member(t, hub, 1);
    const b = await member(t, hub, 2);
    const bus = await startBus(b.gm, "t", b.registry);
    await bus.send(1, "hello");
    assert.ok(hub.store.has("x2u:t:out:2"));
    await eventually(() => a.registry.live().length === 1, 1000);
    await b.registry.leave();
    await eventually(() => !hub.store.has("x2u:t:out:2"), 1000);
  });
});

describe("election with frames", () => {
  it("never lets a frame lead, and leaderOf skips frames", async (t) => {
    const hub = createHub();
    const frame = await member(t, hub, 1, () => tabState(1, { frame: true }));
    await sleep(5);
    const tab = await member(t, hub, 2);
    await eventually(() => frame.registry.live().length === 1 && tab.registry.live().length === 1, 1000);
    assert.equal(leaderOf(frame.registry), 2);
    assert.equal(leaderOf(tab.registry), 2);
    let frameLeads = false;
    let tabLeads = false;
    const e1 = startElection(frame.registry, { acquire: () => (frameLeads = true), lose: () => {} }, { graceMs: 10 });
    const e2 = startElection(tab.registry, { acquire: () => (tabLeads = true), lose: () => {} }, { graceMs: 10 });
    t.after(() => {
      e1.stop();
      e2.stop();
    });
    await eventually(() => tabLeads, 1000);
    assert.equal(frameLeads, false);
  });
});
