// chrome.tabs for the background, from the registry.
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { startBus } from "../../src/runtime/bus.ts";
import { createLogger } from "../../src/runtime/chrome.ts";
import { leaderOf } from "../../src/runtime/elect.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { createMessaging } from "../../src/runtime/messaging.ts";
import { startRegistry, type TabState } from "../../src/runtime/registry.ts";
import { createTabs } from "../../src/runtime/tabs.ts";
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

describe("tabs API", () => {
  async function background(t: TestContext, hub: Hub, id: number, state: () => TabState = () => tabState(id)) {
    const { gm, registry } = await member(t, hub, id, state);
    const messaging = createMessaging({
      extensionId: "ext",
      log: createLogger("test"),
      leader: () => leaderOf(registry),
      exists: (other) => other === id || registry.live().some((tab) => tab.id === other),
      sender: () => ({ id: "ext" }),
      control: async () => null,
    });
    const bus = await startBus(gm, "t", registry, messaging.handle);
    messaging.attach((to, wire) => bus.send(to, wire));
    t.after(() => bus.stop());
    return createTabs({ gm, registry, messaging, log: createLogger("test"), dispatching: () => true, rejoinMs: 300 });
  }

  it("queries every tab, this one included, oldest first, and finds the active one", async (t) => {
    const hub = createHub();
    const tabs = await background(t, hub, 1);
    await sleep(5);
    await member(t, hub, 2, () => tabState(2, { active: true, activeAt: 10 }));
    await member(t, hub, 3, () => tabState(3, { active: true, activeAt: 20 }));
    await sleep(60);
    const all = (await tabs.api.query({})) as Array<{ id: number; index: number; windowId: number }>;
    assert.deepEqual(all.map((tab) => [tab.id, tab.index, tab.windowId]), [[1, 0, 1], [2, 1, 1], [3, 2, 1]]);
    const active = (await tabs.api.query({ active: true, currentWindow: true })) as Array<{ id: number }>;
    assert.deepEqual(active.map((tab) => tab.id), [3]);
    const matched = (await tabs.api.query({ url: "https://site.test/2" })) as Array<{ id: number }>;
    assert.deepEqual(matched.map((tab) => tab.id), [2]);
    assert.equal(((await tabs.api.get(2)) as { title: string }).title, "page 2");
    await assert.rejects(tabs.api.get(99) as Promise<unknown>, /No tab with id: 99\./);
  });

  it("fires onCreated, onUpdated, onActivated and onRemoved from registry changes", async (t) => {
    const hub = createHub();
    const tabs = await background(t, hub, 1);
    const events: string[] = [];
    tabs.api.onCreated.addListener((tab: { id: number }) => events.push(`created ${tab.id}`));
    tabs.api.onUpdated.addListener((id: number, change: Record<string, unknown>) => events.push(`updated ${id} ${JSON.stringify(change)}`));
    tabs.api.onActivated.addListener((info: { tabId: number }) => events.push(`activated ${info.tabId}`));
    tabs.api.onRemoved.addListener((id: number) => events.push(`removed ${id}`));
    let state = tabState(2);
    const other = await member(t, hub, 2, () => state);
    await eventually(() => events.length === 1, 1000);
    state = { ...state, title: "renamed", active: true, activeAt: 99 };
    await other.registry.touch();
    await eventually(() => events.length === 3, 1000);
    await other.registry.leave();
    await eventually(() => events.length === 4, 1000);
    assert.deepEqual(events, ["created 2", 'updated 2 {"status":"complete","title":"renamed"}', "activated 2", "removed 2"]);
  });

  it("reports a same-origin navigation as updates, not a close and an open, and a finished load as status complete", async (t) => {
    const hub = createHub();
    const tabs = await background(t, hub, 1);
    const events: string[] = [];
    tabs.api.onCreated.addListener((tab: { id: number; status: string }) => events.push(`created ${tab.id} ${tab.status}`));
    tabs.api.onUpdated.addListener((id: number, change: Record<string, unknown>) => events.push(`updated ${id} ${JSON.stringify(change)}`));
    tabs.api.onRemoved.addListener((id: number) => events.push(`removed ${id}`));
    const first = await member(t, hub, 42, () => tabState(42, { url: "https://site.test/one", status: "loading" }));
    await eventually(() => events.length === 1, 1000);
    // pagehide; then the next page in the same tab joins with the same id, which sessionStorage kept.
    await first.registry.leave();
    let state = tabState(42, { url: "https://site.test/two", status: "loading" });
    const second = await member(t, hub, 42, () => state);
    await eventually(() => events.length === 2, 1000);
    state = { ...state, status: "complete" };
    await second.registry.touch();
    await eventually(() => events.length === 3, 1000);
    await sleep(400); // past rejoinMs: the tab was never removed
    assert.deepEqual(events, [
      "created 42 loading",
      'updated 42 {"status":"loading","url":"https://site.test/two"}',
      'updated 42 {"status":"complete"}',
    ]);
  });
});
