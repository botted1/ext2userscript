// Tab registry (spec §5.3).
// - Each tab heartbeats its own key.
// - A roster "doorbell" key makes joins and leaves visible at once.
// - A tab whose heartbeat is older than the staleness limit counts as gone, and its keys are cleaned up.
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";

export type TabInfo = { id: number; url: string; title: string; since: number; ts: number };
export type RegistryTiming = { heartbeatMs: number; staleMs: number };

/** Staleness outlives Chrome's one-wake-up-per-minute throttling of long-hidden tabs. */
export const REGISTRY_TIMING: RegistryTiming = { heartbeatMs: 2_000, staleMs: 90_000 };

export type Registry = {
  readonly me: number;
  /** This tab: when it joined (or rejoined), and whether it is registered right now. */
  self(): { id: number; since: number; present: boolean };
  /** Other live tabs, as last seen. */
  live(): TabInfo[];
  onAdded(fn: (tab: TabInfo) => void): void;
  onRemoved(fn: (id: number) => void): void;
  /** Membership changed (a tab came, went or rejoined), or this tab left or rejoined. */
  onChange(fn: () => void): void;
  /** pagehide: stop heartbeating, delete this tab's key and ring the roster. */
  leave(): Promise<void>;
  /** pageshow from the back/forward cache: join again with a new `since`. */
  rejoin(): Promise<void>;
  stop(): Promise<void>;
};

type Beat = { url: string; title: string; since: number; ts: number };

const isBeat = (value: unknown): value is Beat =>
  typeof value === "object" && value !== null &&
  typeof (value as Beat).url === "string" && typeof (value as Beat).since === "number" && typeof (value as Beat).ts === "number";

export async function startRegistry(
  gm: Gm,
  ns: string,
  me: number,
  describe: () => { url: string; title: string },
  timing: RegistryTiming = REGISTRY_TIMING,
): Promise<Registry> {
  const k = keys(ns);
  const known = new Map<number, TabInfo>();
  const added: Array<(tab: TabInfo) => void> = [];
  const removed: Array<(id: number) => void> = [];
  const changes: Array<() => void> = [];
  let since = Date.now();
  let present = true;

  const changed = () => {
    for (const fn of changes) fn();
  };
  const beat = () => gm.setValue(k.tab(me), { ...describe(), since, ts: Date.now() });
  const ring = () => gm.setValue(k.roster, { from: me, t: Date.now() });

  const scanOnce = async () => {
    const now = Date.now();
    const seen = new Set<number>();
    let dirty = false;
    for (const key of await gm.listValues()) {
      if (!key.startsWith(k.tabPrefix)) continue;
      const id = Number(key.slice(k.tabPrefix.length));
      if (!Number.isInteger(id) || id === me) continue;
      const value = await gm.getValue(key);
      if (!isBeat(value) || now - value.ts > timing.staleMs) {
        // Gone, or not a value this runtime wrote: clean up after it.
        await gm.deleteValue(key);
        await gm.deleteValue(k.out(id));
        continue;
      }
      seen.add(id);
      const info: TabInfo = { id, url: value.url, title: String(value.title), since: value.since, ts: value.ts };
      const previous = known.get(id);
      known.set(id, info);
      if (!previous) {
        dirty = true;
        for (const fn of added) fn(info);
      } else if (previous.since !== info.since) {
        dirty = true;
      }
    }
    for (const id of [...known.keys()]) {
      if (seen.has(id)) continue;
      known.delete(id);
      dirty = true;
      for (const fn of removed) fn(id);
    }
    if (dirty) changed();
  };

  // One scan at a time; a request that arrives mid-scan runs one more pass afterwards.
  let scanning = false;
  let again = false;
  const scan = async () => {
    if (scanning) {
      again = true;
      return;
    }
    scanning = true;
    try {
      do {
        again = false;
        await scanOnce();
      } while (again);
    } finally {
      scanning = false;
    }
  };

  await beat();
  const rosterListener = await gm.addValueChangeListener(k.roster, () => {
    void scan();
  });
  await ring();
  await scan();
  const timer = setInterval(() => {
    if (present) void beat().then(scan);
  }, timing.heartbeatMs);

  return {
    me,
    self: () => ({ id: me, since, present }),
    live: () => [...known.values()],
    onAdded: (fn) => {
      added.push(fn);
    },
    onRemoved: (fn) => {
      removed.push(fn);
    },
    onChange: (fn) => {
      changes.push(fn);
    },
    leave: async () => {
      present = false;
      changed();
      await gm.deleteValue(k.tab(me));
      await ring();
    },
    rejoin: async () => {
      present = true;
      since = Date.now();
      changed();
      await beat();
      await ring();
      await scan();
    },
    stop: async () => {
      clearInterval(timer);
      present = false;
      await gm.removeValueChangeListener(rosterListener);
      await gm.deleteValue(k.tab(me));
    },
  };
}
