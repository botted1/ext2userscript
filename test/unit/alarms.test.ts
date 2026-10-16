// chrome.alarms: a schedule stored as a GM value, fired by whichever page's background leads.
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAlarms, type Alarm } from "../../src/runtime/alarms.ts";
import { createLogger } from "../../src/runtime/chrome.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { createHub, type Hub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

const MS = 1 / 60_000; // one millisecond, in minutes

async function alarmsOn(t: TestContext, hub: Hub) {
  const alarms = await createAlarms(createGm(hub.tab()), "t", createLogger("test"));
  t.after(() => alarms.pause());
  const fired: Alarm[] = [];
  alarms.api.onAlarm.addListener((alarm: Alarm) => fired.push(alarm));
  return { alarms, api: alarms.api as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>, fired };
}

describe("alarms", () => {
  it("fires a one-shot alarm after its delay, then forgets it, keeping the schedule in a GM value", async (t) => {
    const hub = createHub();
    const { api, fired } = await alarmsOn(t, hub);
    await api.create("once", { delayInMinutes: 40 * MS });
    assert.deepEqual(Object.keys(hub.store.get("x2u:t:alarms") as object), ["once"]);
    await eventually(() => fired.length === 1, 1000);
    assert.equal(fired[0].name, "once");
    assert.deepEqual(await api.getAll(), []);
    assert.deepEqual(hub.store.get("x2u:t:alarms"), {});
  });

  it("repeats a periodic alarm, and a second create with the same name replaces the first", async (t) => {
    const { api, fired } = await alarmsOn(t, createHub());
    await api.create("tick", { delayInMinutes: 10_000 });
    await api.create("tick", { periodInMinutes: 20 * MS });
    await eventually(() => fired.length >= 3, 1000);
    const [alarm] = (await api.getAll()) as Alarm[];
    assert.deepEqual([alarm.name, alarm.periodInMinutes], ["tick", 20 * MS]);
    assert.equal(await api.clear("tick"), true);
    assert.equal(await api.clear("tick"), false);
  });

  it("waits for an alarm more than 24.8 days away, the longest a timer can wait, instead of firing it at once", async (t) => {
    const hub = createHub();
    const { api, fired } = await alarmsOn(t, hub);
    await api.create("monthly", { periodInMinutes: 30 * 24 * 60 });
    await api.create("later", { when: Date.now() + 60 * 24 * 60 * 60_000 });
    await sleep(100);
    assert.deepEqual(fired, []);
    assert.deepEqual(((await api.getAll()) as Alarm[]).map((alarm) => alarm.name).sort(), ["later", "monthly"]);
  });

  it("follows Chrome's argument rules: an optional name, and when or delayInMinutes but not both", async (t) => {
    const { api } = await alarmsOn(t, createHub());
    await api.create({ when: Date.now() + 60_000 });
    assert.equal(((await api.get()) as Alarm).name, "");
    await assert.rejects(api.create("x", { when: 1, delayInMinutes: 1 }), /Cannot set both when and delayInMinutes/);
    await assert.rejects(api.create("x", {}), /One of when, delayInMinutes or periodInMinutes is required/);
    assert.equal(await api.clearAll(), true);
    assert.equal(await api.get("missing"), undefined);
  });

  it("fires at once an alarm whose time passed while no page was open, for the next background that starts", async (t) => {
    const hub = createHub();
    hub.store.set("x2u:t:alarms", { late: { name: "late", scheduledTime: Date.now() - 5_000 } });
    const { fired } = await alarmsOn(t, hub);
    await eventually(() => fired.length === 1, 1000);
    assert.equal(fired[0].name, "late");
  });

  it("stops firing while its page doesn't lead, and reads the schedule afresh when it leads again", async (t) => {
    const hub = createHub();
    const { alarms, api, fired } = await alarmsOn(t, hub);
    await api.create("soon", { delayInMinutes: 30 * MS });
    alarms.pause();
    await sleep(80);
    assert.equal(fired.length, 0);
    // Meanwhile another leader rescheduled it.
    hub.store.set("x2u:t:alarms", { soon: { name: "soon", scheduledTime: Date.now() + 20 } });
    await alarms.resume();
    await eventually(() => fired.length === 1, 1000);
  });
});
