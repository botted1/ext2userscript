import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startElection, type Election } from "../../src/runtime/elect.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { startRegistry, type Registry, type RegistryTiming } from "../../src/runtime/registry.ts";
import { createHub, type Hub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

const FAST: RegistryTiming = { heartbeatMs: 20, staleMs: 150 };
type Member = { id: number; registry: Registry; election: Election; events: string[] };

async function member(hub: Hub, id: number, timing: RegistryTiming = FAST): Promise<Member> {
  const registry = await startRegistry(createGm(hub.tab()), "t", id, () => ({ url: "https://example.com/", title: "t" }), timing);
  const events: string[] = [];
  const election = startElection(registry, { acquire: () => events.push("acquire"), lose: () => events.push("lose") }, { graceMs: 30 });
  return { id, registry, election, events };
}

const leaders = (members: Member[]) => members.filter((m) => m.election.isLeader()).map((m) => m.id);

async function stopAll(...members: Member[]) {
  for (const m of members) {
    m.election.stop();
    await m.registry.stop();
  }
}

describe("leader election", () => {
  it("a lone tab leads once the grace period has passed", async () => {
    const hub = createHub();
    const a = await member(hub, 1);
    try {
      assert.equal(a.election.isLeader(), false);
      await eventually(() => a.election.isLeader(), 500);
      assert.deepEqual(a.events, ["acquire"]);
    } finally {
      await stopAll(a);
    }
  });

  it("the tab that joined first leads, and later tabs don't displace it", async () => {
    const hub = createHub();
    const a = await member(hub, 1);
    await eventually(() => a.election.isLeader(), 500);
    const b = await member(hub, 2);
    const c = await member(hub, 3);
    try {
      await sleep(200);
      assert.deepEqual(leaders([a, b, c]), [1]);
      assert.deepEqual(b.events, []);
      assert.deepEqual(c.events, []);
    } finally {
      await stopAll(a, b, c);
    }
  });

  it("tabs that start together settle on exactly one leader", async () => {
    const hub = createHub();
    const members = await Promise.all([1, 2, 3, 4, 5].map((id) => member(hub, id)));
    try {
      await sleep(300);
      assert.equal(leaders(members).length, 1);
      const first = leaders(members)[0];
      await sleep(300);
      assert.deepEqual(leaders(members), [first]);
    } finally {
      await stopAll(...members);
    }
  });

  it("hands over at once when the leader leaves, and a returning tab doesn't take it back", async () => {
    const hub = createHub();
    const a = await member(hub, 1);
    await eventually(() => a.election.isLeader(), 500);
    const b = await member(hub, 2);
    const c = await member(hub, 3);
    try {
      await a.registry.leave();
      assert.equal(a.election.isLeader(), false);
      await eventually(() => b.election.isLeader(), 300);
      assert.deepEqual(a.events, ["acquire", "lose"]);
      await a.registry.rejoin();
      await sleep(200);
      assert.deepEqual(leaders([a, b, c]), [2]);
    } finally {
      await stopAll(a, b, c);
    }
  });

  it("replaces a leader whose heartbeat goes stale", async () => {
    const hub = createHub();
    const crashed = await member(hub, 1, { heartbeatMs: 10_000, staleMs: 150 });
    await eventually(() => crashed.election.isLeader(), 500);
    const b = await member(hub, 2);
    try {
      await sleep(50);
      assert.equal(b.election.isLeader(), false);
      await eventually(() => b.election.isLeader(), 1_000);
    } finally {
      await stopAll(crashed, b);
    }
  });

  it("keeps a slowly heartbeating (throttled, hidden) leader", async () => {
    const hub = createHub();
    const slow = await member(hub, 1, { heartbeatMs: 100, staleMs: 300 });
    await eventually(() => slow.election.isLeader(), 500);
    const b = await member(hub, 2, { heartbeatMs: 20, staleMs: 300 });
    try {
      await sleep(1_000);
      assert.equal(slow.election.isLeader(), true);
      assert.deepEqual(b.events, []);
    } finally {
      await stopAll(slow, b);
    }
  });
});
