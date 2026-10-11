// Tab registry (spec §5.3).
// - Each tab heartbeats its own key with its state (URL, title, whether it is a frame, whether it is visible).
// - A roster "doorbell" key makes joins, leaves and state changes visible at once.
// - A tab whose heartbeat is older than the staleness limit counts as gone, and its keys are cleaned up.
// - Every live tab beats as soon as it hears another tab ring. A tab that rang checks, responseMs later, that each
//   tab has beaten since: one that hasn't is a ghost (a tab that died without pagehide, in a crash or when the browser
//   quit) and goes at once, instead of after the staleness limit. Value-change events reach even a throttled
//   background tab promptly; only timers are throttled.
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";

/** What a tab says about itself in each heartbeat. */
export type TabState = {
  url: string;
  title: string;
  /** A content script's userscript running in an iframe: it can message, but isn't a tab and never leads. */
  frame: boolean;
  /** The page is visible (document.visibilityState). */
  active: boolean;
  /** When the page last became visible or focused; the most recent visible tab is the "current" one. */
  activeAt: number;
  /** Whether the page has finished loading (its load event), as chrome.tabs reports it. A tab without one counts as complete. */
  status?: "loading" | "complete";
};
export type TabInfo = TabState & { id: number; since: number; ts: number };
export type RegistryTiming = { heartbeatMs: number; staleMs: number; responseMs?: number };

/** Staleness outlives Chrome's one-wake-up-per-minute throttling of long-hidden tabs. */
export const REGISTRY_TIMING: RegistryTiming = { heartbeatMs: 2_000, staleMs: 90_000, responseMs: 1_500 };
/**
 * A tab answers a ring only if it rang at least this long after the last ring it answered, so a burst of rings costs one
 * heartbeat. The ghost check allows for the rings a live tab skipped this way.
 */
const RESPONSE_INTERVAL_MS = 250;

export type Registry = {
  readonly me: number;
  /** This tab: when it joined (or rejoined), whether it is registered right now, and its current state. */
  self(): TabState & { id: number; since: number; present: boolean };
  /** Other live tabs and frames, as last seen. */
  live(): TabInfo[];
  onAdded(fn: (tab: TabInfo) => void): void;
  onRemoved(fn: (id: number) => void): void;
  /** Another tab's state (URL, title, visibility) changed. */
  onUpdated(fn: (tab: TabInfo, previous: TabInfo) => void): void;
  /** Membership changed (a tab came, went or rejoined), or this tab left or rejoined. */
  onChange(fn: () => void): void;
  /** This tab's state changed: heartbeat and ring now, so other tabs see it without waiting for the next beat. */
  touch(): Promise<void>;
  /** pagehide: stop heartbeating, delete this tab's key and ring the roster. */
  leave(): Promise<void>;
  /** pageshow from the back/forward cache: join again with a new `since`. */
  rejoin(): Promise<void>;
  stop(): Promise<void>;
};

/** heard: the latest ring this tab has heard, so a tab that rang can tell a live tab from a ghost even within a millisecond. */
type Beat = TabState & { since: number; ts: number; heard?: number };

const isBeat = (value: unknown): value is Beat =>
  typeof value === "object" && value !== null &&
  typeof (value as Beat).url === "string" && typeof (value as Beat).since === "number" && typeof (value as Beat).ts === "number";

const sameState = (a: TabInfo, b: TabInfo) =>
  a.url === b.url && a.title === b.title && a.active === b.active && a.activeAt === b.activeAt && a.status === b.status;

export async function startRegistry(
  gm: Gm,
  ns: string,
  me: number,
  describe: () => TabState,
  timing: RegistryTiming = REGISTRY_TIMING,
  reportError: (error: unknown) => void = (error) => queueMicrotask(() => {
    throw error;
  }),
): Promise<Registry> {
  const k = keys(ns);
  const known = new Map<number, TabInfo>();
  const added: Array<(tab: TabInfo) => void> = [];
  const removed: Array<(id: number) => void> = [];
  const updated: Array<(tab: TabInfo, previous: TabInfo) => void> = [];
  const changes: Array<() => void> = [];
  let since = Date.now();
  let present = true;
  let lastScan = Date.now();
  let awakeSince = -Infinity;
  let verifyBefore = 0;
  let lastAnswered = -Infinity;
  let heard = 0;
  const responseMs = timing.responseMs ?? REGISTRY_TIMING.responseMs ?? 1_500;
  const verifiers = new Set<ReturnType<typeof setTimeout>>();

  // A subscriber's error goes to reportError, so it neither stops the others nor aborts the pass.
  const notify = <A extends unknown[]>(subscribers: Array<(...args: A) => void>, ...args: A) => {
    for (const fn of subscribers) {
      try {
        fn(...args);
      } catch (error) {
        reportError(error);
      }
    }
  };
  const changed = () => notify(changes);
  const beat = () => gm.setValue(k.tab(me), { ...describe(), since, ts: Date.now(), heard });
  const ring = (t = Date.now()) => gm.setValue(k.roster, { from: me, t });
  /** Rings, then checks responseMs later that every tab has beaten since. */
  const ringAndVerify = async () => {
    const at = Date.now();
    await ring(at);
    const timer = setTimeout(() => {
      verifiers.delete(timer);
      verifyBefore = Math.max(verifyBefore, at);
      void scan();
    }, responseMs);
    verifiers.add(timer);
  };
  /** Answers the ring made at t. Skipping one keeps `heard` within RESPONSE_INTERVAL_MS of it, which the ghost check allows. */
  const respond = (t: number) => {
    if (!present || t - lastAnswered < RESPONSE_INTERVAL_MS) return;
    lastAnswered = t;
    void beat();
  };

  const scanOnce = async () => {
    const now = Date.now();
    // After a gap longer than staleMs (a sleep, a frozen tab), peers could not beat. Each gets staleMs from this wake-up,
    // and this tab rings the roster, so tabs that took over while it was frozen hear at once that it is back.
    const woke = now - lastScan > timing.staleMs;
    if (woke) awakeSince = now;
    lastScan = now;
    if (woke && present) await ring();
    // A verification pass: a tab that beat before this tab's ring and heard no ring near it is a ghost.
    const mustHaveBeaten = verifyBefore;
    verifyBefore = 0;
    const seen = new Set<number>();
    let dirty = false;
    for (const key of await gm.listValues()) {
      if (!key.startsWith(k.tabPrefix)) continue;
      const suffix = key.slice(k.tabPrefix.length);
      const id = Number(suffix);
      // Only canonical ids count, so an alias such as "tab:02" cannot clean up tab 2's outbox.
      if (!Number.isInteger(id) || String(id) !== suffix || id === me) continue;
      const value = await gm.getValue(key);
      const heardAt = isBeat(value) && typeof value.heard === "number" ? value.heard : 0;
      const ghost = mustHaveBeaten > 0 && isBeat(value) && value.ts <= mustHaveBeaten && heardAt < mustHaveBeaten - RESPONSE_INTERVAL_MS;
      if (!isBeat(value) || now - Math.max(value.ts, awakeSince) > timing.staleMs || ghost) {
        // Gone, or not a value this runtime wrote: clean up after it.
        await gm.deleteValue(key);
        await gm.deleteValue(k.out(id));
        continue;
      }
      seen.add(id);
      const info: TabInfo = {
        id,
        url: value.url,
        title: String(value.title),
        frame: value.frame === true,
        active: value.active === true,
        activeAt: typeof value.activeAt === "number" ? value.activeAt : 0,
        status: value.status === "loading" ? "loading" : "complete",
        since: value.since,
        ts: value.ts,
      };
      const previous = known.get(id);
      known.set(id, info);
      if (!previous) {
        dirty = true;
        notify(added, info);
      } else {
        if (previous.since !== info.since) dirty = true;
        if (!sameState(previous, info)) notify(updated, info, previous);
      }
    }
    // Every gone tab leaves `known` before any is reported, so a listener (a message resent to the new leader) sees only live tabs.
    const gone = [...known.keys()].filter((id) => !seen.has(id));
    for (const id of gone) known.delete(id);
    for (const id of gone) {
      dirty = true;
      // A tab that left deleted its own key; its outbox goes too, as nothing will read it again.
      await gm.deleteValue(k.out(id));
      notify(removed, id);
    }
    if (dirty) changed();
  };

  // A call that arrives mid-pass shares its promise and gets one more full pass after it.
  let running: Promise<void> | undefined;
  let again = false;
  const scan = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await scanOnce();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  await beat();
  // Scan in a microtask: the hub may still be applying a batch key by key, and the scan must see all of it.
  const rosterListener = await gm.addValueChangeListener(k.roster, (_key, _old, value) => {
    const rang = value as { from?: unknown; t?: unknown } | undefined;
    if (typeof rang?.t === "number") {
      heard = Math.max(heard, rang.t);
      if (rang.from !== me) respond(rang.t);
    }
    queueMicrotask(() => void scan());
  });
  // Another tab can sweep this one by mistake (its main thread was busy past the response time): come straight back.
  const selfListener = await gm.addValueChangeListener(k.tab(me), (_key, _old, value) => {
    if (value === undefined && present) void beat().then(() => ring());
  });
  await ringAndVerify();
  await scan();
  const timer = setInterval(() => {
    if (present) void beat().then(scan);
  }, timing.heartbeatMs);

  return {
    me,
    self: () => ({ ...describe(), id: me, since, present }),
    live: () => [...known.values()],
    onAdded: (fn) => {
      added.push(fn);
    },
    onRemoved: (fn) => {
      removed.push(fn);
    },
    onUpdated: (fn) => {
      updated.push(fn);
    },
    onChange: (fn) => {
      changes.push(fn);
    },
    touch: async () => {
      if (!present) return;
      await beat();
      await ringAndVerify();
    },
    leave: async () => {
      present = false;
      try {
        await gm.deleteValue(k.tab(me));
        await ring();
      } finally {
        changed();
      }
    },
    rejoin: async () => {
      present = true;
      since = Date.now();
      changed();
      await beat();
      await ringAndVerify();
      await scan();
    },
    stop: async () => {
      clearInterval(timer);
      for (const verifier of verifiers) clearTimeout(verifier);
      present = false;
      try {
        await gm.removeValueChangeListener(rosterListener);
        await gm.removeValueChangeListener(selfListener);
        await gm.deleteValue(k.tab(me));
      } finally {
        changed();
      }
    },
  };
}
