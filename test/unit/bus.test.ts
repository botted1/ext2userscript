import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RING_SIZE, startBus, type Bus } from "../../src/runtime/bus.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { startRegistry, type Registry } from "../../src/runtime/registry.ts";
import { createHub, type Hub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

type Tab = { id: number; registry: Registry; bus: Bus; got: Array<{ payload: unknown; from: number }> };

async function openTab(hub: Hub, id: number): Promise<Tab> {
  const gm = createGm(hub.tab());
  const registry = await startRegistry(gm, "t", id, () => ({ url: "https://example.com/", title: "t" }), { heartbeatMs: 20, staleMs: 5_000 });
  const bus = await startBus(gm, "t", registry);
  const got: Tab["got"] = [];
  bus.onMessage((payload, from) => got.push({ payload, from }));
  return { id, registry, bus, got };
}

async function closeAll(...tabs: Tab[]) {
  for (const tab of tabs) {
    await tab.bus.stop();
    await tab.registry.stop();
  }
}

const connected = (a: Tab, b: Tab) =>
  eventually(() => a.registry.live().some((t) => t.id === b.id) && b.registry.live().some((t) => t.id === a.id), 500);

describe("cross-tab bus", () => {
  it("delivers to one tab, with the sender's id", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    const c = await openTab(hub, 3);
    try {
      await connected(a, b);
      await connected(a, c);
      await a.bus.send(2, { hi: 1 });
      await eventually(() => b.got.length === 1, 500);
      assert.deepEqual(b.got, [{ payload: { hi: 1 }, from: 1 }]);
      await sleep(50);
      assert.deepEqual(c.got, []);
      assert.deepEqual(a.got, []);
    } finally {
      await closeAll(a, b, c);
    }
  });

  it("broadcasts to every other tab", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    const c = await openTab(hub, 3);
    try {
      await connected(a, b);
      await connected(a, c);
      await a.bus.send("*", "all");
      await eventually(() => b.got.length === 1 && c.got.length === 1, 500);
      await sleep(50);
      assert.deepEqual(a.got, []);
      assert.deepEqual(b.got, [{ payload: "all", from: 1 }]);
    } finally {
      await closeAll(a, b, c);
    }
  });

  it("delivers locally when a tab sends to itself", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    try {
      await a.bus.send(1, "self");
      await eventually(() => a.got.length === 1, 200);
      assert.deepEqual(a.got, [{ payload: "self", from: 1 }]);
    } finally {
      await closeAll(a);
    }
  });

  it("delivers a new tab's first message to a tab that hasn't discovered it yet", async () => {
    // Coalesced: the roster and the outbox land in one batch, so only the catch-up read can deliver the message.
    const hub = createHub({ delayMs: 20, coalesce: true });
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    try {
      await b.bus.send(1, "early");
      await eventually(() => a.got.length === 1, 500);
      assert.deepEqual(a.got, [{ payload: "early", from: 2 }]);
    } finally {
      await closeAll(a, b);
    }
  });

  it("does not replay messages sent before a tab started", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    try {
      await a.bus.send("*", "old");
      await sleep(10);
      const b = await openTab(hub, 2);
      try {
        await connected(a, b);
        await a.bus.send("*", "new");
        await eventually(() => b.got.length >= 1, 500);
        await sleep(30);
        assert.deepEqual(b.got.map((m) => m.payload), ["new"]);
      } finally {
        await closeAll(b);
      }
    } finally {
      await closeAll(a);
    }
  });

  it("counts messages lost when a manager coalesces writes", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const hub = createHub({ delayMs: 30, coalesce: true });
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    try {
      await connected(a, b);
      await a.bus.send(2, 0);
      await eventually(() => b.got.length === 1, 500);
      for (let n = 1; n <= 100; n++) void a.bus.send(2, n); // all land within one coalescing window
      await eventually(() => b.got.length === 1 + RING_SIZE, 1_000);
      assert.equal(b.bus.dropped, 100 - RING_SIZE);
      assert.deepEqual(b.got.at(-1), { payload: 100, from: 1 });
      assert.equal(warn.mock.callCount(), 1); // the gap is logged, once
    } finally {
      warn.mock.restore();
      await closeAll(a, b);
    }
  });

  it("restarts the sequence when a tab navigates (new epoch, same id)", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    try {
      await connected(a, b);
      await a.bus.send(2, "before");
      await eventually(() => b.got.length === 1, 500);
      await a.bus.stop();
      const next = await startBus(createGm(hub.tab()), "t", a.registry); // same tab id, fresh page
      try {
        await next.send(2, "after");
        await eventually(() => b.got.length === 2, 500);
        assert.deepEqual(b.got.map((m) => m.payload), ["before", "after"]);
      } finally {
        await next.stop();
      }
    } finally {
      await closeAll(b);
      await a.registry.stop();
    }
  });

  it("ignores outbox values it cannot read", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    try {
      await connected(a, b);
      hub.tab().GM_setValue?.("x2u:t:out:1", { epoch: 5, msgs: "nope" });
      hub.tab().GM_setValue?.("x2u:t:out:1", { epoch: "e", msgs: [{ junk: true }] });
      await sleep(50);
      await a.bus.send(2, "still works");
      await eventually(() => b.got.length === 1, 500);
      assert.deepEqual(b.got, [{ payload: "still works", from: 1 }]);
    } finally {
      await closeAll(a, b);
    }
  });

  it("a stopped bus delivers nothing and refuses to send", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    await a.bus.stop(); // stop the bus, but keep its registry running
    const c = await openTab(hub, 3); // joins after a stopped
    try {
      await eventually(() => a.registry.live().some((t) => t.id === 3), 500);
      await c.bus.send(1, "direct");
      await c.bus.send("*", "broadcast");
      await sleep(50);
      assert.deepEqual(a.got, []);
      await assert.rejects(a.bus.send(3, "nope"), /stopped/);
    } finally {
      await closeAll(c);
      await a.registry.stop();
    }
  });

  it("counts messages lost across a navigation", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const hub = createHub({ delayMs: 30, coalesce: true });
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    try {
      await connected(a, b);
      await a.bus.send(2, "before");
      await eventually(() => b.got.length === 1, 500);
      await a.bus.stop();
      const next = await startBus(createGm(hub.tab()), "t", a.registry); // same tab id, fresh page: a new epoch
      try {
        for (let n = 1; n <= 100; n++) void next.send(2, n); // all land within one coalescing window
        await eventually(() => b.got.length === 1 + RING_SIZE, 1_000);
        assert.equal(b.bus.dropped, 100 - RING_SIZE);
        assert.deepEqual(b.got.at(-1), { payload: 100, from: 1 });
        assert.equal(warn.mock.callCount(), 1);
      } finally {
        await next.stop();
      }
    } finally {
      warn.mock.restore();
      await closeAll(b);
      await a.registry.stop();
    }
  });

  it("does not replay a returning epoch", async () => {
    const hub = createHub();
    const a = await openTab(hub, 1);
    const b = await openTab(hub, 2);
    try {
      await connected(a, b);
      await a.bus.send(2, "m1");
      await a.bus.send(2, "m2");
      await a.bus.send(2, "m3");
      await eventually(() => b.got.length === 3, 500);
      const next = await startBus(createGm(hub.tab()), "t", a.registry); // a second page takes the same tab id
      try {
        await next.send(2, "n1");
        await eventually(() => b.got.length === 4, 500);
        await a.bus.send(2, "m4"); // the first page returns from the back/forward cache and sends again
        await eventually(() => b.got.length >= 5, 500);
        await sleep(30);
        assert.deepEqual(b.got.map((m) => m.payload), ["m1", "m2", "m3", "n1", "m4"]);
      } finally {
        await next.stop();
      }
    } finally {
      await closeAll(a, b);
    }
  });
});
