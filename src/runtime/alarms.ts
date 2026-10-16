// chrome.alarms (spec §5.2): the schedule is a GM value, so it outlives the tab that leads; only the leader's background
// runs timers for it. A leader that steps down stops them, and one that leads again reloads the schedule.
// Ceilings: an alarm fires only while some page the userscript runs on is open, and a hidden tab's timers can run up
// to a minute late (Chrome throttles them).
import { createEvent, method, type Logger } from "./chrome.ts";
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";

export type Alarm = { name: string; scheduledTime: number; periodInMinutes?: number };
type AlarmInfo = { when?: number; delayInMinutes?: number; periodInMinutes?: number };

const MINUTE = 60_000;

export async function createAlarms(gm: Gm, ns: string, log: Logger) {
  const key = keys(ns).alarms;
  const onAlarm = createEvent<(alarm: Alarm) => void>(log);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let alarms: Record<string, Alarm> = {};
  let running = true;

  const load = async () => {
    const stored = await gm.getValue<Record<string, Alarm>>(key);
    alarms = stored && typeof stored === "object" ? stored : {};
  };
  const save = () => gm.setValue(key, alarms).catch((error: unknown) => log.error(error));
  const stop = (name: string) => {
    clearTimeout(timers.get(name));
    timers.delete(name);
  };
  // An alarm whose time passed while no page was open fires at once, as Chrome fires missed alarms on wake.
  const schedule = (alarm: Alarm) => {
    stop(alarm.name);
    if (running) timers.set(alarm.name, setTimeout(() => fire(alarm.name), Math.max(0, alarm.scheduledTime - Date.now())));
  };
  const fire = (name: string) => {
    const alarm = alarms[name];
    timers.delete(name);
    if (!alarm || !running) return;
    if (alarm.periodInMinutes) schedule((alarms[name] = { ...alarm, scheduledTime: Date.now() + alarm.periodInMinutes * MINUTE }));
    else delete alarms[name];
    void save();
    onAlarm.dispatch({ ...alarm });
  };

  await load();
  for (const alarm of Object.values(alarms)) schedule(alarm);

  /** create([name], info): Chrome's optional first argument. */
  const create = (...args: unknown[]) => {
    const [name, info] = typeof args[0] === "string" ? [args[0], (args[1] ?? {}) as AlarmInfo] : ["", (args[0] ?? {}) as AlarmInfo];
    if (info.when !== undefined && info.delayInMinutes !== undefined) throw new Error("Cannot set both when and delayInMinutes.");
    const delay = info.delayInMinutes ?? info.periodInMinutes;
    if (info.when === undefined && delay === undefined) throw new Error("One of when, delayInMinutes or periodInMinutes is required.");
    const alarm: Alarm = { name, scheduledTime: info.when ?? Date.now() + (delay as number) * MINUTE, ...(info.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}) };
    alarms[name] = alarm;
    schedule(alarm);
    return save();
  };
  const clear = async (name = "") => {
    const had = name in alarms;
    delete alarms[name];
    stop(name);
    await save();
    return had;
  };

  return {
    api: {
      create: method(log, create),
      get: method(log, async (name: string = "") => (alarms[name] ? { ...alarms[name] } : undefined)),
      getAll: method(log, async () => Object.values(alarms).map((alarm) => ({ ...alarm }))),
      clear: method(log, clear),
      clearAll: method(log, async () => {
        const had = Object.keys(alarms).length > 0;
        for (const name of Object.keys(alarms)) stop(name);
        alarms = {};
        await save();
        return had;
      }),
      onAlarm: onAlarm.event,
    },
    /** This page stopped leading: its timers stop, and it no longer writes the schedule. */
    pause() {
      running = false;
      for (const name of [...timers.keys()]) stop(name);
    },
    /** This page leads again: the schedule may have changed meanwhile, so it is read afresh. */
    async resume() {
      running = true;
      await load();
      for (const alarm of Object.values(alarms)) schedule(alarm);
    },
  };
}
