import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { startElection, type Election } from "../../src/runtime/elect.ts";
import { createGm, type Gm } from "../../src/runtime/gm.ts";
import { startRegistry, type Registry, type RegistryTiming } from "../../src/runtime/registry.ts";
import { createHub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

const FAST: RegistryTiming = { heartbeatMs: 20, staleMs: 150 };
/** Staleness is far off, so a handover within a test's wait can only come from leave()'s delete and roster ring. */
const HANDOVER: RegistryTiming = { heartbeatMs: 20, staleMs: 10_000 };
type Member = { id: number; registry: Registry; election: Election; events: string[] };

/**
 * Joins through a GM cache the caller made. Cleanup is registered before anything else can run, so a failing
 * assertion or a timed-out eventually() still stops this member's timers and the run exits.
 */
async function member(t: TestContext, gm: Gm, id: number, timing: RegistryTiming = FAST, graceMs = 30): Promise<Member> {
  const registry = await startRegistry(gm, "t", id, () => ({ url: "https://example.com/", title: "t" }), timing);
  const events: string[] = [];
  const election = startElection(registry, { acquire: () => events.push("acquire"), lose: () => events.push("lose") }, { graceMs });
  t.after(async () => {
    election.stop();
    await registry.stop();
  });
  return { id, registry, election, events };
}

const leaders = (members: Member[]) => members.filter((m) => m.election.isLeader()).map((m) => m.id);

describe("leader election", () => {
  it("a lone tab leads once the grace period has passed", async (t) => {
    const hub = createHub();
    const a = await member(t, createGm(hub.tab()), 1);
    assert.equal(a.election.isLeader(), false);
    await eventually(() => a.election.isLeader(), 500);
    assert.deepEqual(a.events, ["acquire"]);
  });

  it("the tab that joined first leads, and later tabs don't displace it", async (t) => {
    const hub = createHub();
    const a = await member(t, createGm(hub.tab()), 1);
    await eventually(() => a.election.isLeader(), 500);
    const b = await member(t, createGm(hub.tab()), 2);
    const c = await member(t, createGm(hub.tab()), 3);
    await sleep(200);
    assert.deepEqual(leaders([a, b, c]), [1]);
    assert.deepEqual(b.events, []);
    assert.deepEqual(c.events, []);
  });

  it("tabs that start together settle on exactly one leader", async (t) => {
    // Every cache is made before any tab writes, so no tab starts out knowing about another.
    const hub = createHub({ delayMs: 10 });
    const gms = [1, 2, 3, 4, 5].map(() => createGm(hub.tab()));
    const members = await Promise.all(gms.map((gm, i) => member(t, gm, i + 1, FAST, 30)));
    await sleep(300);
    const events = members.flatMap((m) => m.events);
    assert.equal(events.filter((e) => e === "acquire").length, 1);
    assert.equal(events.includes("lose"), false);
    const oldest = [...members].sort((x, y) => x.registry.self().since - y.registry.self().since || x.id - y.id)[0];
    assert.deepEqual(leaders(members), [oldest.id]);
  });

  it("hands over at once when the leader leaves, and a returning tab doesn't take it back", async (t) => {
    const hub = createHub();
    const a = await member(t, createGm(hub.tab()), 1, HANDOVER);
    await eventually(() => a.election.isLeader(), 500);
    const b = await member(t, createGm(hub.tab()), 2, HANDOVER);
    const c = await member(t, createGm(hub.tab()), 3, HANDOVER);
    await a.registry.leave();
    assert.equal(a.election.isLeader(), false);
    await eventually(() => b.election.isLeader(), 300);
    assert.deepEqual(a.events, ["acquire", "lose"]);
    await a.registry.rejoin();
    await sleep(200);
    assert.deepEqual(leaders([a, b, c]), [2]);
  });

  it("replaces a leader whose heartbeat goes stale", async (t) => {
    const hub = createHub();
    const crashed = await member(t, createGm(hub.tab()), 1, { heartbeatMs: 10_000, staleMs: 150 });
    await eventually(() => crashed.election.isLeader(), 500);
    const b = await member(t, createGm(hub.tab()), 2);
    await sleep(50);
    assert.equal(b.election.isLeader(), false);
    await eventually(() => b.election.isLeader(), 1_000);
  });

  it("keeps a slowly heartbeating (throttled, hidden) leader", async (t) => {
    const hub = createHub();
    const slow = await member(t, createGm(hub.tab()), 1, { heartbeatMs: 100, staleMs: 300 });
    await eventually(() => slow.election.isLeader(), 500);
    const b = await member(t, createGm(hub.tab()), 2, { heartbeatMs: 20, staleMs: 300 });
    await sleep(1_000);
    assert.equal(slow.election.isLeader(), true);
    assert.deepEqual(b.events, []);
  });

  it("a leader steps down when an older live tab reappears", async (t) => {
    const hub = createHub();
    const crashed = await member(t, createGm(hub.tab()), 1, { heartbeatMs: 10_000, staleMs: 150 });
    await eventually(() => crashed.election.isLeader(), 500);
    const b = await member(t, createGm(hub.tab()), 2);
    await eventually(() => b.election.isLeader(), 1_000);
    // Tab 1 returns with its original since, as a frozen-then-thawed tab would. It keeps beating, so it stays live.
    const writer = createGm(hub.tab());
    const beat = () => writer.setValue("x2u:t:tab:1", { url: "https://example.com/", title: "t", since: crashed.registry.self().since, ts: Date.now() });
    await beat();
    const keepAlive = setInterval(() => void beat(), 20);
    t.after(() => clearInterval(keepAlive));
    await eventually(() => b.events.length === 2, 1_000);
    assert.deepEqual(b.events, ["acquire", "lose"]);
    assert.equal(b.election.isLeader(), false);
  });

  it("a leader whose registry stops steps down, even though its election is still running", async (t) => {
    const hub = createHub();
    const a = await member(t, createGm(hub.tab()), 1);
    await eventually(() => a.election.isLeader(), 500);
    const b = await member(t, createGm(hub.tab()), 2);
    await a.registry.stop();
    assert.equal(a.election.isLeader(), false);
    assert.deepEqual(a.events, ["acquire", "lose"]);
    await eventually(() => b.election.isLeader(), 300);
  });
});
