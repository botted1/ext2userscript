# ext2userscript Plan 3: Background and Messaging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run an extension's background in the userscript, on the leader tab, and connect it to content scripts the way Chrome does: messages, ports, `chrome.tabs`, storage and lifecycle events.

**Architecture:**
- **Converter:**
  - `bundle.ts` turns the background into one script:
    - a classic service worker, with `importScripts` string literals inlined;
    - MV2 background scripts or a background page's scripts, concatenated;
    - an ES-module worker, bundled by esbuild into an IIFE with `import.meta` defined.
  - `emit.ts` wraps the background in a factory whose parameters shadow the globals a background reaches.
  - The analyzer reports background APIs: Chrome gives the background every API, so anything not implemented yet is reported.
- **Runtime:** every page joins the registry (frames included, flagged) and the bus. A router (`messaging.ts`) carries:
  - `runtime.sendMessage`/`onMessage`;
  - `connect`/Port;
  - `tabs.sendMessage`;
  - control requests between pages.

  The oldest tab is elected leader. It runs the background once, with a background global object, `localStorage`, `chrome.tabs`, and lifecycle checks (`onInstalled`, `onStartup`, `storage.session`).

  Content scripts still start at once. Messages they send before the page has joined the other tabs wait in the router.

**Tech Stack:**
- TypeScript, run directly by Node 22.16 with `--experimental-strip-types`.
- `node:test`.
- Playwright 1.64, using the emulator and the release-tier harness.
- esbuild 0.28.2 and fflate 0.8.3.
- No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`

**Scope:** Plan 3 of 6. The original Plan 3 ("cross-tab runtime APIs and background boot") is split in two.

This plan is the core that most extensions need:
- background bundling and boot;
- messaging and ports;
- `chrome.tabs`;
- lifecycle;
- the background's `localStorage`;
- Plan 1's cross-tab carry-forwards.

**Plan 3b** gets the rest of spec §5.2:
- the fetch/XHR network shim, with `@connect` and `GM_xmlhttpRequest`;
- `alarms`, `contextMenus`/`action` menu commands, `commands`, `notifications`;
- `scripting`/`tabs.executeScript`, `permissions`, `cookies`, `windows`, `getBackgroundPage`.

Until 3b lands, the report marks those APIs unsupported ("isn't converted yet"). The runtime fails their calls with a named error, so a background that uses one still starts.

**Prototype:** every code block below was run before the plan was written, on 2026-10-11:
- **Unit tests:** 279 of 279 pass, and `tsc` is clean.
- **Emulator browser suite:** passes. S4 passes, and the only failure is the known Firefox S3 one on macOS 27.
- **New end-to-end test:** 9 of 9 on the emulator in three runs, and 18 of 18 on Tampermonkey 5.5.1 and Violentmonkey 2.49.0 in three runs.
- **S4 on both real managers:** 1,050 of 1,050 messages and one leader at every check.

The prototype found and fixed four bugs:
1. **Ghost tabs.** A tab that died without `pagehide` stayed "live" for 90 s and, as the oldest, took every background message. This was seen on Violentmonkey, whose profile keeps values between runs. The same thing happens to a user after a crash or a quick browser restart. The registry now sweeps ghosts in about 1.5 s, and the router resends.
2. **Port messages lost.** A port's first `postMessage` was lost while the leader's background was still starting.
3. **Violentmonkey's global proxy.** Its sandbox global reports `delete` as refused (while deleting), so restoring `globalThis.chrome` threw.
4. **Missing tabs.** `tabs.sendMessage` to a missing tab waited 30 s instead of failing at once.

**Spec corrections (Task 1 applies them; they need the human's OK along with this plan):**
1. **§3.3 background globals:**
   - The background wrapper also shadows `window` and `document`. In a service worker they are `undefined`, as in Chrome; in an MV2 background page, `window` is the shim and `document` is the tab's document.
   - ES modules bundle to an IIFE, so no exports are left to strip. `import.meta` becomes an object whose `url` is `chrome-extension://<id>/<entry>`, and every module sees the entry's URL.
2. **§5.3 discovery:**
   - Every live tab beats when it hears a ring. About 1.5 s after a tab rings, any tab that neither heard that ring nor beat since is a ghost, and goes at once.
   - Iframes join as frames: they message, but they aren't tabs and never lead.
   - Tab keys also carry `frame`, `active`, `activeAt` (for `tabs.query({active})` and `onActivated`) and `heard`, the newest ring the tab has heard.
3. **§5.3 responses:**
   - A background message is sent again (twice at most) if its page leaves unanswered.
   - A port is opened again if its page leaves before its `onConnect` ran. Once connected, the page leaving disconnects it.
   - A duplicated tab gives up a tab id another live page still uses.
4. **§5.4:**
   - Messages for the background go to the expected leader during its grace period. It holds them for up to 5 s, until its background has started.
   - A leader that dies without `pagehide` is replaced once the ghost check finds it, after the next ring, instead of only when its heartbeat goes stale.

**Carried from Plan 1's ledger:**
- the `out:<id>` cleanup (Task 1);
- taking the bus handler before the catch-up read (Task 1);
- the frozen-leader thaw, by ringing on wake (Task 1);
- unique tab ids (Task 2);
- `pageshow` rejoining only when `persisted` (Task 8);
- messages across a leadership change (the handover end-to-end test, Task 8).

## Global Constraints

- **Node:** Node ≥ 22.16. TypeScript runs directly with `--experimental-strip-types --disable-warning=ExperimentalWarning`. No tsx, no build step.
- **Running things:**
  - One test file: `npm run test:file -- <path>`.
  - One script: `npm run script -- <path>`.
- **TypeScript:**
  - Erasable syntax only (no `enum`, `namespace` or parameter properties).
  - Relative imports end in `.ts`.
  - Type-only imports use `import type` or inline `type`.
  - The `lib` is `es2022` plus DOM.
- **Exact versions:**
  - `esbuild` and `esbuild-wasm` 0.28.2.
  - `fflate` 0.8.3.
  - Dev: `playwright` 1.64.0, `typescript` 7.0.2, `@types/node` 22.20.5.
  - No other dependencies.
- **Tests:** `node:test` with `node:assert/strict`. Browser tests use the `playwright` library.
- **Isomorphic core:**
  - `src/convert/*` and `src/runtime/*` import no `node:` module and use no Node-only global.
  - Exceptions: `src/convert/esbuild-node.ts` and `src/convert/runtime-node.ts`.
  - `src/source.ts` and `src/cli.ts` are Node-only.
- **The GM layer:** every GM call goes through `src/runtime/gm.ts`. `@grant` lines come from its `GRANTS` table.
- **GM value keys:**
  - `x2u:<ns>:tab:<id>`, `x2u:<ns>:out:<id>`, `x2u:<ns>:roster`;
  - `x2u:<ns>:s:<area>:<key>`, `x2u:<ns>:storage-keys`;
  - new in this plan: `x2u:<ns>:ls:<key>` (background `localStorage`), `x2u:<ns>:installed`, `x2u:<ns>:session`.
- **Production timings:**
  - heartbeat every 2 s; stale after 90 s;
  - ghost check 1.5 s after a ring;
  - election grace 300 ms;
  - a background message held up to 5 s while the leader starts;
  - a reply times out after 30 s;
  - outbox ring of 64 messages, none older than 10 s.
- **Errors (spec §9):**
  - Hard errors only for an unreadable archive, an invalid `manifest.json`, or an esbuild failure. An ES-module background without the esbuild option counts as an esbuild failure.
  - Everything else becomes a report entry or warning.
  - An unavailable API fails with `ext2userscript: chrome.<api> is not available in userscripts`, logged once.
  - A message nobody receives fails with Chrome's `Could not establish connection. Receiving end does not exist.`
- **Extension code stays in sloppy mode.** The runtime's own `"use strict"` stays inside its IIFE.
- **Real managers:** one browser at a time on `bench/.cache/profile`; leave no Chrome for Testing process running.
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, passed as a second `-m`.

## Review Focus

1. **Ghost tabs after a crash or a quick browser restart.** Keys still look fresh, but nothing answers rings for them. Messages to the background must be answered within a couple of seconds, not after 90.
   - Pinned in Task 1 (`registry-state.test.ts`, "sweeps a ghost").
   - Task 3 (`messaging.test.ts`, "sends a background message again" and "opens a port again at the new leader").
   - Task 8: the end-to-end test on real managers, whose profiles keep earlier runs' keys.
2. **Port messages posted before the leader's background has started** must arrive in order once it starts. Pinned in Task 3 (`messaging.test.ts`, "keeps a port's first messages while its background is starting").
3. **Service-worker code that checks `typeof window` or `typeof document`** must see `undefined`, as in Chrome. Pinned in Task 7 (`emit-background.test.ts`, "passes the background as a factory").
4. **A background that calls an API this version doesn't implement, at top level** (`chrome.alarms.create(...)`), must keep running. Pinned in Task 3 (`runtime-core.test.ts`, "fakes every member when told 'all'") and Task 8: the fixture's first line calls `chrome.alarms.create`.
5. **The leader tab closing.** The next tab must take over, and later tabs must get answers. Pinned in Task 8 (`content-runtime.test.ts`, "moves the background to another tab when the leader closes").

---

### Task 1: Tab state, ghost sweep and spec corrections in the cross-tab layer

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-ext2userscript-design.md` (status line, §3.3, §5.3, §5.4)
- Modify:
  - `src/runtime/registry.ts`, `src/runtime/keys.ts` (whole files below);
  - `src/runtime/elect.ts`, `src/runtime/bus.ts` (edits below).
- Modify (call sites of `startRegistry`, whose `describe()` now returns the whole tab state):
  - `test/unit/registry.test.ts`, `test/unit/elect.test.ts`, `test/unit/bus.test.ts`;
  - `test/browser/probes/s4.ts`.
- Test: `test/unit/registry-state.test.ts`

**Interfaces:**
- Produces:
  - **`registry.ts`:**
    - `type TabState = { url; title; frame: boolean; active: boolean; activeAt: number }` and `type TabInfo = TabState & { id; since; ts }`;
    - `RegistryTiming` gains `responseMs?` (1,500 ms in production);
    - `startRegistry(gm, ns, me, describe: () => TabState, timing?, reportError?)`;
    - `Registry` gains `onUpdated(fn(tab, previous))` and `touch()`, and `self()` returns the tab state too.
  - **`keys(ns)`** gains `localStorage(key)`, `localStoragePrefix`, `installed` and `session`.
  - **`elect.ts`:** `leaderOf(registry): number | undefined`. Frames never lead.
  - **`bus.ts`:** `startBus(gm, ns, registry, handler?)`. The handler is attached before the first outbox read.

- [ ] **Step 1: Write the failing test** `test/unit/registry-state.test.ts`

```ts
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/registry-state.test.ts`
Expected: FAIL. `elect.ts` doesn't export `leaderOf` yet, so the file can't load.

- [ ] **Step 3: Replace `src/runtime/keys.ts` and `src/runtime/registry.ts`**

```ts
// GM value keys the runtime uses (spec §5.1–5.4). ns is the converted extension's namespace.
export function keys(ns: string) {
  return {
    tab: (id: number) => `x2u:${ns}:tab:${id}`,
    tabPrefix: `x2u:${ns}:tab:`,
    out: (id: number) => `x2u:${ns}:out:${id}`,
    roster: `x2u:${ns}:roster`,
    /** chrome.storage: one value per key. */
    storage: (area: string, key: string) => `x2u:${ns}:s:${area}:${key}`,
    storagePrefix: `x2u:${ns}:s:`,
    /** Rung when a storage key is created, so tabs watching storage.onChanged start listening to it. */
    storageDoorbell: `x2u:${ns}:storage-keys`,
    /** The background's localStorage: one value per key. */
    localStorage: (key: string) => `x2u:${ns}:ls:${key}`,
    localStoragePrefix: `x2u:${ns}:ls:`,
    /** The extension version runtime.onInstalled last fired for. */
    installed: `x2u:${ns}:installed`,
    /** Written by the leader on every beat; missing or stale means the browser restarted (spec §5.4). */
    session: `x2u:${ns}:session`,
  };
}
```

```ts
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
};
export type TabInfo = TabState & { id: number; since: number; ts: number };
export type RegistryTiming = { heartbeatMs: number; staleMs: number; responseMs?: number };

/** Staleness outlives Chrome's one-wake-up-per-minute throttling of long-hidden tabs. */
export const REGISTRY_TIMING: RegistryTiming = { heartbeatMs: 2_000, staleMs: 90_000, responseMs: 1_500 };
/** A tab answers rings at most this often, so a burst of rings costs one heartbeat. */
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

const sameState = (a: TabInfo, b: TabInfo) => a.url === b.url && a.title === b.title && a.active === b.active && a.activeAt === b.activeAt;

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
  let lastResponse = 0;
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
  const respond = () => {
    if (!present || Date.now() - lastResponse < RESPONSE_INTERVAL_MS) return;
    lastResponse = Date.now();
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
    // A verification pass: a tab that neither heard this tab's ring nor beat after it is a ghost.
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
      const ghost = mustHaveBeaten > 0 && isBeat(value) && value.ts <= mustHaveBeaten && (typeof value.heard === "number" ? value.heard : 0) < mustHaveBeaten;
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
    for (const id of [...known.keys()]) {
      if (seen.has(id)) continue;
      known.delete(id);
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
    if (typeof rang?.t === "number") heard = Math.max(heard, rang.t);
    if (rang?.from !== me) respond();
    queueMicrotask(() => void scan());
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
        await gm.deleteValue(k.tab(me));
      } finally {
        changed();
      }
    },
  };
}
```

- [ ] **Step 4: Replace `src/runtime/elect.ts`; let `startBus` take its handler**

```ts
// Background leader election (spec §5.4): the live tab that joined first leads. Every tab computes this from
// the registry, whose keys each have a single writer, so all tabs converge on the same answer.
import type { Registry } from "./registry.ts";

export type ElectionTiming = { graceMs: number };

/** A tab must be the oldest for this long before it leads, so tabs that start together can't both lead. */
export const ELECTION_TIMING: ElectionTiming = { graceMs: 300 };

export type Election = { isLeader(): boolean; stop(): void };

/** Frames run content scripts but aren't tabs, so they never lead. */
const tabs = (registry: Registry) => registry.live().filter((tab) => !tab.frame);
const older = (a: { since: number; id: number }, b: { since: number; id: number }) => a.since < b.since || (a.since === b.since && a.id < b.id);

/**
 * The tab every tab expects to lead: the oldest live tab, this one included. Messages for the background go here even
 * while its grace period runs; the receiving runtime holds them until its background starts.
 */
export function leaderOf(registry: Registry): number | undefined {
  const me = registry.self();
  let best = me.present && !me.frame ? { id: me.id, since: me.since } : undefined;
  for (const tab of tabs(registry)) if (!best || older(tab, best)) best = tab;
  return best?.id;
}

export function startElection(registry: Registry, on: { acquire(): void; lose(): void }, timing: ElectionTiming = ELECTION_TIMING): Election {
  let leader = false;
  let stopped = false;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const isOldest = (): boolean => {
    const me = registry.self();
    return me.present && !me.frame && tabs(registry).every((tab) => older(me, tab));
  };
  const cancel = () => {
    if (pending !== undefined) clearTimeout(pending);
    pending = undefined;
  };
  const update = () => {
    if (stopped) return;
    if (!isOldest()) {
      cancel();
      if (leader) {
        leader = false;
        on.lose();
      }
      return;
    }
    if (leader || pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      if (!stopped && !leader && isOldest()) {
        leader = true;
        on.acquire();
      }
    }, timing.graceMs);
  };

  registry.onChange(update);
  update();
  return {
    isLeader: () => leader,
    stop: () => {
      stopped = true;
      cancel();
      if (leader) {
        leader = false;
        on.lose();
      }
    },
  };
}
```

In `src/runtime/bus.ts`, replace:

```ts
export async function startBus(gm: Gm, ns: string, registry: Registry): Promise<Bus> {
  const k = keys(ns);
  const me = registry.me;
  const startedAt = Date.now();
  const epoch = Math.random().toString(36).slice(2);
  const handlers: Array<(payload: unknown, from: number) => void> = [];
```

with:

```ts
/** handler, when given, is attached before the bus reads any outbox, so the catch-up read reaches it too. */
export async function startBus(gm: Gm, ns: string, registry: Registry, handler?: (payload: unknown, from: number) => void): Promise<Bus> {
  const k = keys(ns);
  const me = registry.me;
  const startedAt = Date.now();
  const epoch = Math.random().toString(36).slice(2);
  const handlers: Array<(payload: unknown, from: number) => void> = handler ? [handler] : [];
```

- [ ] **Step 5: Update the `describe()` call sites.** Each still returns only `{ url, title }`. Make these exact replacements:
  - **`test/unit/registry.test.ts`:**
    - Replace `const page = () => ({ url: "https://example.com/", title: "Example" });`
    - with `const page = () => ({ url: "https://example.com/", title: "Example", frame: false, active: false, activeAt: 0 });`.
  - **`test/unit/elect.test.ts` and `test/unit/bus.test.ts`:**
    - Replace `() => ({ url: "https://example.com/", title: "t" })`
    - with `() => ({ url: "https://example.com/", title: "t", frame: false, active: false, activeAt: 0 })`.
  - **`test/browser/probes/s4.ts`:**
    - Replace `() => ({ url: location.href, title: document.title })`
    - with `() => ({ url: location.href, title: document.title, frame: false, active: document.visibilityState === "visible", activeAt: 0 })`.

- [ ] **Step 6: Run the cross-tab tests**

Run: `npm run test:file -- test/unit/registry-state.test.ts`, then the same for `test/unit/registry.test.ts`, `test/unit/elect.test.ts` and `test/unit/bus.test.ts`.
Expected: all PASS.

- [ ] **Step 7: Apply the spec corrections** in `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`. Each replacement is exact:
  1. **Status line.** Replace `Plan 2 corrections (§3.5, §3.6, §4) applied 2026-10-10` with:
     `Plan 2 corrections (§3.5, §3.6, §4) applied 2026-10-10; Plan 3 corrections (§3.3, §5.3, §5.4) applied 2026-10-11`
  2. **§3.3, background bullet.** Replace ``- Background: `self`, `globalThis` and `importScripts`, bound to a background global shim.`` with:
     ``- Background: `self`, `globalThis`, `window`, `document` and `importScripts`. `self` and `globalThis` are a background global shim. In a service worker, `window` and `document` are `undefined`, as in Chrome; in an MV2 background page, `window` is the shim and `document` is the tab's document.``
  3. **§3.3, ES modules.** Replace ``  - The ESM output has no imports left, so its `export` statements are stripped and it is placed inside the wrapper. The wrapper's parameters shadow the globals here too, so no esbuild `inject` is needed.`` with:
     ``  - esbuild bundles to an IIFE, so no `export` statements are left, and the bundle is placed inside the wrapper, whose parameters shadow the globals here too. `import.meta` becomes an object the wrapper passes in, whose `url` is `chrome-extension://<id>/<entry>`; every bundled module sees the entry's URL.``
  4. **§5.3 Discovery.** In the first Discovery bullet, replace ``with `{url, title, since, ts}` every 2s`` with:
     ``with `{url, title, frame, active, activeAt, since, ts, heard}` every 2s (`active` and `activeAt` drive `tabs.query({active})` and `onActivated`; `heard` is the newest roster ring the tab has heard)``

     Then, after the bullet that starts ``  - A tab whose `ts` is older than 90s counts as gone``, add:
     ``  - Every live tab beats as soon as it hears another tab ring. About 1.5 s after a tab rings, a tab that has neither heard that ring nor beaten since is a ghost (it died without `pagehide`, in a crash or when the browser quit) and goes at once, instead of after 90 s. Value-change events reach throttled background tabs promptly; only their timers are throttled.``
     ``  - A content script in an iframe joins as a frame: it sends and receives messages, but it isn't a tab (`tabs.query` skips it) and never leads.``
  5. **§5.3 Responses.** After the bullet that starts ``- **Responses:**``, add:
     ``- **Resending:** a message for the background whose page leaves before answering is sent again to the new leader, twice at most. A port is opened again there if the first page leaves before its `onConnect` runs; once connected, the page leaving disconnects the port, as in Chrome.``
  6. **§5.3 Tab id.** In the bullet ``- **Tab id:** a random 31-bit integer per tab, kept across same-origin navigations through `sessionStorage`. The ceiling: ...``, insert after its first sentence (before ` The ceiling:`):
     `` A duplicated tab copies `sessionStorage`, so an id another live page is still beating with is replaced.``
  7. **§5.4 Handover.** Replace ``A leader that disappears without `pagehide` (crash, tab discard) is replaced when its heartbeat goes stale.`` with:
     ``A leader that disappears without `pagehide` (crash, tab discard) is replaced once the ghost check (§5.3) finds it, about 1.5 s after the next ring (a tab starting, or one becoming visible or navigating), or when its heartbeat goes stale.``
  8. **§5.4 Election.** After the bullet ``  - A tab starts leading only after it has been the oldest live tab for 300ms, so tabs that start together can't both lead before they've seen each other.``, add:
     ``  - Messages for the background go to the expected leader (the oldest live tab) even during its grace period. It holds them for up to 5 s, until its background has started.``

- [ ] **Step 8: Type-check and commit**

Run: `npm run typecheck` (expected: exit 0), then:

```bash
git add src/runtime/registry.ts src/runtime/keys.ts src/runtime/elect.ts src/runtime/bus.ts test/unit/registry-state.test.ts test/unit/registry.test.ts test/unit/elect.test.ts test/unit/bus.test.ts test/browser/probes/s4.ts docs/superpowers/specs/2026-10-09-ext2userscript-design.md
git commit -m "Track tab state, sweep ghost tabs, and keep frames out of the election" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Tab identity, lifecycle, localStorage and the background global

**Files:**
- Create: `src/runtime/identity.ts`, `src/runtime/lifecycle.ts`, `src/runtime/local-storage.ts`, `src/runtime/global.ts`
- Test: `test/unit/background-pieces.test.ts`

**Interfaces:**
- Consumes: `keys` and `REGISTRY_TIMING` (Task 1); `type Logger` (Plan 2).
- Produces:
  - `tabIdentity(gm, ns, frame, storage?, random?): Promise<number>`;
  - `type Installed` and `checkLifecycle(gm, ns, version, staleMs?): Promise<{ installed?: Installed; startup: boolean }>`;
  - `createLocalStorage(gm, ns, log): Promise<Storage>`;
  - `createBackgroundGlobal(own): { global; fire(type: "install" | "activate") }`.

- [ ] **Step 1: Write the failing test** `test/unit/background-pieces.test.ts`

```ts
// The background's building blocks: tab identity, lifecycle checks, localStorage and the global object.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/runtime/chrome.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { createBackgroundGlobal } from "../../src/runtime/global.ts";
import { tabIdentity } from "../../src/runtime/identity.ts";
import { checkLifecycle } from "../../src/runtime/lifecycle.ts";
import { createLocalStorage } from "../../src/runtime/local-storage.ts";
import { createHub } from "../support/gm-hub.ts";
import { sleep } from "../support/time.ts";

describe("tabIdentity", () => {
  const memory = () => {
    const items = new Map<string, string>();
    return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
  };

  it("keeps a tab's id in sessionStorage", async () => {
    const gm = createGm(createHub().tab());
    const store = memory();
    const first = await tabIdentity(gm, "t", false, store);
    assert.ok(Number.isInteger(first) && first > 0 && first < 2 ** 31);
    assert.equal(await tabIdentity(gm, "t", false, store), first);
  });

  it("gives up an id another live page is beating with, as a duplicated tab's copied sessionStorage would", async () => {
    const hub = createHub();
    const gm = createGm(hub.tab());
    const store = memory();
    const first = await tabIdentity(gm, "t", false, store);
    await gm.setValue(`x2u:t:tab:${first}`, { url: "x", title: "x", since: Date.now(), ts: Date.now() });
    const second = await tabIdentity(gm, "t", false, store);
    assert.notEqual(second, first);
    assert.equal(store.getItem("x2u:t:tab-id"), String(second));
  });

  it("gives a frame a fresh id, and survives a sessionStorage that throws", async () => {
    const gm = createGm(createHub().tab());
    const store = memory();
    assert.notEqual(await tabIdentity(gm, "t", true, store), await tabIdentity(gm, "t", true, store));
    assert.equal(store.getItem("x2u:t:tab-id"), null);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => {} };
    assert.ok((await tabIdentity(gm, "t", false, broken)) > 0);
  });
});

describe("checkLifecycle", () => {
  it("reports install, then nothing, then an update, and onStartup only for a new session after install", async () => {
    const hub = createHub();
    const gm = createGm(hub.tab());
    assert.deepEqual(await checkLifecycle(gm, "t", "1.0", 50), { installed: { reason: "install" }, startup: false });
    assert.deepEqual(await checkLifecycle(gm, "t", "1.0", 50), { installed: undefined, startup: false });
    assert.deepEqual(await checkLifecycle(gm, "t", "1.1", 50), { installed: { reason: "update", previousVersion: "1.0" }, startup: false });
    await sleep(80); // the session stamp goes stale: the browser "restarted"
    assert.deepEqual(await checkLifecycle(gm, "t", "1.1", 50), { installed: undefined, startup: true });
  });

  it("clears storage.session in a new session, and only then", async () => {
    const hub = createHub();
    const gm = createGm(hub.tab());
    await checkLifecycle(gm, "t", "1", 50);
    await gm.setValue("x2u:t:s:session:k", 1);
    await gm.setValue("x2u:t:s:local:k", 2);
    await checkLifecycle(gm, "t", "1", 50);
    assert.equal(hub.store.get("x2u:t:s:session:k"), 1);
    await sleep(80);
    await checkLifecycle(gm, "t", "1", 50);
    assert.equal(hub.store.has("x2u:t:s:session:k"), false);
    assert.equal(hub.store.get("x2u:t:s:local:k"), 2);
  });
});

describe("createLocalStorage", () => {
  it("loads saved values, works synchronously, and saves writes", async () => {
    const hub = createHub();
    const gm = createGm(hub.tab());
    await gm.setValue("x2u:t:ls:saved", "yes");
    const storage = await createLocalStorage(gm, "t", createLogger("test"));
    assert.equal(storage.getItem("saved"), "yes");
    storage.setItem("n", 5 as unknown as string);
    assert.equal(storage.getItem("n"), "5");
    (storage as unknown as Record<string, string>).theme = "dark";
    assert.equal(storage.getItem("theme"), "dark");
    assert.equal((storage as unknown as Record<string, string>).saved, "yes");
    assert.equal(storage.length, 3);
    assert.deepEqual(Object.keys(storage).sort(), ["n", "saved", "theme"]);
    storage.removeItem("saved");
    assert.equal(storage.getItem("missing"), null);
    await sleep(5);
    assert.deepEqual([...hub.store.entries()].filter(([key]) => key.startsWith("x2u:t:ls:")).sort(), [["x2u:t:ls:n", "5"], ["x2u:t:ls:theme", "dark"]]);
    storage.clear();
    assert.equal(storage.length, 0);
  });
});

describe("createBackgroundGlobal", () => {
  it("adds the background's members and makes self and globalThis point to itself", () => {
    const { global } = createBackgroundGlobal({ chrome: "the chrome object" });
    const g = global as unknown as Record<string, unknown>;
    assert.equal(g.chrome, "the chrome object");
    assert.equal(g.self, global);
    assert.equal(g.globalThis, global);
    assert.equal("chrome" in global, true);
  });

  it("binds native methods to the real global, keeps constructors as they are, and writes through", () => {
    const { global } = createBackgroundGlobal({});
    const g = global as unknown as Record<string, unknown>;
    assert.equal(typeof g.setTimeout, "function");
    assert.equal(g.setTimeout, g.setTimeout, "the same bound function each time");
    assert.equal(g.Promise, Promise);
    g.x2uWritten = 1;
    assert.equal((globalThis as unknown as Record<string, unknown>).x2uWritten, 1);
    delete g.x2uWritten;
    assert.equal("x2uWritten" in globalThis, false);
  });

  it("fires install and activate at listeners added with self.addEventListener", () => {
    const { global, fire } = createBackgroundGlobal({});
    const seen: string[] = [];
    const add = (global as unknown as { addEventListener(type: string, fn: (event: { type: string; waitUntil(): void }) => void): void }).addEventListener;
    add("install", (event) => {
      event.waitUntil();
      seen.push(event.type);
    });
    add("activate", (event) => seen.push(event.type));
    fire("install");
    fire("activate");
    assert.deepEqual(seen, ["install", "activate"]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/background-pieces.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write `src/runtime/identity.ts`**

```ts
// A page's id in the registry (spec §5.3): a random 31-bit integer, kept in sessionStorage, so a tab keeps its id across
// same-origin navigations. A duplicated tab copies sessionStorage, so an id whose key another page is still beating
// with is given up for a new one.
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";
import { REGISTRY_TIMING } from "./registry.ts";

const randomId = (random: () => number) => 1 + Math.floor(random() * (2 ** 31 - 1));

export async function tabIdentity(
  gm: Gm,
  ns: string,
  frame: boolean,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.sessionStorage,
  random: () => number = Math.random,
): Promise<number> {
  // A frame shares its tab's sessionStorage only when same-origin, and isn't a tab anyway: it gets an id per page.
  if (frame || !storage) return randomId(random);
  const slot = `x2u:${ns}:tab-id`;
  try {
    const saved = Number(storage.getItem(slot));
    if (Number.isInteger(saved) && saved > 0) {
      const beat = (await gm.getValue(keys(ns).tab(saved))) as { ts?: number } | undefined;
      if (typeof beat?.ts !== "number" || Date.now() - beat.ts > REGISTRY_TIMING.staleMs) return saved;
    }
    const id = randomId(random);
    storage.setItem(slot, String(id));
    return id;
  } catch {
    return randomId(random); // sessionStorage can be blocked (sandboxed frames, storage settings)
  }
}
```

- [ ] **Step 4: Write `src/runtime/lifecycle.ts`**

```ts
// What a new leader learns before it runs the background (spec §5.4):
// - install or update: runtime.onInstalled fires once per installed version;
// - a new browser session: the session stamp the leader refreshes on every beat is missing or older than the staleness
//   limit, so runtime.onStartup fires and storage.session is cleared.
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";
import { REGISTRY_TIMING } from "./registry.ts";

export type Installed = { reason: "install" } | { reason: "update"; previousVersion: string };

export async function checkLifecycle(gm: Gm, ns: string, version: string, staleMs = REGISTRY_TIMING.staleMs): Promise<{ installed?: Installed; startup: boolean }> {
  const k = keys(ns);
  const previous = await gm.getValue<string>(k.installed);
  const stamp = await gm.getValue<{ t: number }>(k.session);
  const newSession = typeof stamp?.t !== "number" || Date.now() - stamp.t > staleMs;
  if (newSession) {
    for (const key of await gm.listValues()) if (key.startsWith(k.storage("session", ""))) await gm.deleteValue(key);
  }
  await gm.setValue(k.session, { t: Date.now() });
  if (previous !== version) await gm.setValue(k.installed, version);
  return {
    installed: previous === undefined ? { reason: "install" } : previous !== version ? { reason: "update", previousVersion: previous } : undefined,
    // Chrome doesn't fire onStartup in the session the extension was installed in.
    startup: newSession && previous !== undefined,
  };
}
```

- [ ] **Step 5: Write `src/runtime/local-storage.ts`**

```ts
// The background's localStorage (spec §5.1): synchronous, like the real one, over GM values under x2u:<ns>:ls:*.
// Every value is read into a cache before the background's code starts; writes update the cache at once and are saved
// with gm.setValue. Only the leader's background uses it, so other tabs' copies need no listeners (yet).
import type { Logger } from "./chrome.ts";
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";

export async function createLocalStorage(gm: Gm, ns: string, log: Logger): Promise<Storage> {
  const k = keys(ns);
  const cache = new Map<string, string>();
  for (const key of await gm.listValues()) {
    if (!key.startsWith(k.localStoragePrefix)) continue;
    const value = await gm.getValue(key);
    if (typeof value === "string") cache.set(key.slice(k.localStoragePrefix.length), value);
  }
  const save = (promise: Promise<void>) => void promise.catch((error: unknown) => log.error("localStorage couldn't be saved:", error));
  const storage = {
    get length() {
      return cache.size;
    },
    key: (index: number) => [...cache.keys()][index] ?? null,
    getItem: (key: string) => cache.get(String(key)) ?? null,
    setItem: (key: string, value: unknown) => {
      cache.set(String(key), String(value));
      save(gm.setValue(k.localStorage(String(key)), String(value)));
    },
    removeItem: (key: string) => {
      cache.delete(String(key));
      save(gm.deleteValue(k.localStorage(String(key))));
    },
    clear: () => {
      for (const key of cache.keys()) save(gm.deleteValue(k.localStorage(key)));
      cache.clear();
    },
  };
  // Property access (localStorage.theme = "dark") works as on the real Storage object.
  return new Proxy(storage, {
    get: (target, property) => (typeof property === "symbol" || property in target ? Reflect.get(target, property) : target.getItem(property) ?? undefined),
    set: (target, property, value) => {
      if (typeof property === "symbol" || property in target) return false;
      target.setItem(property, value);
      return true;
    },
    deleteProperty: (target, property) => {
      if (typeof property !== "symbol") target.removeItem(property);
      return true;
    },
    has: (target, property) => (typeof property === "symbol" || property in target ? property in target : cache.has(property)),
    ownKeys: () => [...cache.keys()],
    getOwnPropertyDescriptor: (_target, property) =>
      typeof property === "string" && cache.has(property) ? { value: cache.get(property), writable: true, enumerable: true, configurable: true } : undefined,
  }) as unknown as Storage;
}
```

- [ ] **Step 6: Write `src/runtime/global.ts`**

```ts
// The background's global object (spec §3.3): what `self` and `globalThis` (and `window`, for an MV2 background page)
// mean in background code. It is the userscript's real global, with what a background expects on top: chrome and
// browser, importScripts, localStorage, and a service worker's install/activate events, skipWaiting and clients.
// The real global is never the proxy's target, so the proxy may answer differently for properties Window fixes in place.

/** Service-worker events: install and activate fire once the background has run; the rest never fire here. */
const WORKER_EVENTS = new Set(["install", "activate", "message", "fetch", "push", "sync", "periodicsync", "notificationclick", "notificationclose"]);

type Listener = ((event: unknown) => void) | { handleEvent(event: unknown): void };

export function createBackgroundGlobal(own: Record<string, unknown>) {
  const real = globalThis as unknown as Record<PropertyKey, unknown>;
  const listeners = new Map<string, Set<Listener>>();
  const bound = new Map<Function, Function>();
  const members: Record<string, unknown> = {
    ...own,
    addEventListener: (type: string, listener: Listener, options?: unknown) => {
      if (!WORKER_EVENTS.has(type)) return window.addEventListener(type, listener as EventListener, options as AddEventListenerOptions);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: Listener, options?: unknown) => {
      if (!WORKER_EVENTS.has(type)) return window.removeEventListener(type, listener as EventListener, options as EventListenerOptions);
      listeners.get(type)?.delete(listener);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [], get: async () => undefined, openWindow: async () => null },
  };
  const global: typeof globalThis = new Proxy(Object.create(null) as object, {
    get(_target, property) {
      if (property === "self" || property === "globalThis") return global;
      if (typeof property === "string" && property in members) return members[property];
      const value = real[property];
      // A native method needs the real global as `this`: self.setTimeout(...) would otherwise throw "Illegal invocation".
      // Lower-case names only, so constructors (self.Promise, self.URL) keep their static members.
      if (typeof value !== "function" || typeof property !== "string" || !/^[a-z]/.test(property)) return value;
      let fn = bound.get(value);
      if (!fn) bound.set(value, (fn = value.bind(real)));
      return fn;
    },
    set(_target, property, value) {
      if (typeof property === "string" && property in members) members[property] = value;
      else real[property] = value;
      return true;
    },
    has: (_target, property) => (typeof property === "string" && property in members) || property in real,
    deleteProperty: (_target, property) => delete real[property],
  }) as typeof globalThis;

  return {
    global,
    /** Fires a service-worker lifecycle event at the listeners background code added on self. */
    fire(type: "install" | "activate") {
      const event = { type, waitUntil: () => {} };
      for (const listener of listeners.get(type) ?? []) {
        try {
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        } catch (error) {
          console.error(error);
        }
      }
    },
  };
}
```

- [ ] **Step 7: Run the test**

Run: `npm run test:file -- test/unit/background-pieces.test.ts`
Expected: PASS.

- [ ] **Step 8: Type-check and commit**

Run: `npm run typecheck` (expected: exit 0), then:

```bash
git add src/runtime/identity.ts src/runtime/lifecycle.ts src/runtime/local-storage.ts src/runtime/global.ts test/unit/background-pieces.test.ts
git commit -m "Add tab identity, lifecycle checks, the background's localStorage and global object" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The messaging router

**Files:**
- Modify: `src/runtime/chrome.ts` (whole file below)
  - an event's `dispatch` returns each listener's result;
  - `withFallback` takes `"all"` for the background.
- Create: `src/runtime/messaging.ts`
- Modify: `test/unit/runtime-core.test.ts` (one test added)
- Test: `test/unit/messaging.test.ts`

**Interfaces:**
- Consumes:
  - `startRegistry`, `leaderOf`, `startBus` with a handler (Task 1);
  - `callWithLastError`, `createEvent`, `createLogger` (Plan 2);
  - `createHub` (test support).
- Produces:
  - `createEvent` returns `{ event, dispatch }`, where `dispatch(...args): unknown[]`;
  - `withFallback(log, namespace, members, faked: readonly string[] | "all")`;
  - `messaging.ts`:
    - `type Endpoint`, `type MessageSender`, `type Port`, `type MessagingDeps`, `type Messaging`;
    - `NO_RECEIVER`, `PORT_CLOSED`;
    - `createMessaging(deps)`, which returns:
      - `attach(send)`, `handle`, `setBackgroundReady(ready)`, `peerGone(id)`;
      - `runtime(endpoint)`: `sendMessage`, `onMessage`, `connect`, `onConnect`;
      - `tabs`: `sendMessage(tabId, message, ...)` and `connect(tabId, info?)`;
      - `control(tabId, op, args)`.
  - `MessagingDeps = { extensionId; log; leader(); exists(id); sender(from); control(op, args) }`.

- [ ] **Step 1: Write the failing tests.** Create `test/unit/messaging.test.ts`:

```ts
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { startBus } from "../../src/runtime/bus.ts";
import { createLogger, readLastError } from "../../src/runtime/chrome.ts";
import { leaderOf } from "../../src/runtime/elect.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { createMessaging, NO_RECEIVER, PORT_CLOSED, type Port } from "../../src/runtime/messaging.ts";
import { startRegistry } from "../../src/runtime/registry.ts";
import { createHub, type Hub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

type Listener = (message: unknown, sender: { tab?: { id: number }; url?: string }, sendResponse: (response?: unknown) => void) => unknown;
type Runtime = {
  sendMessage(...args: unknown[]): Promise<unknown> | undefined;
  onMessage: { addListener(fn: Listener): void };
  connect(info?: { name?: string }): Port;
  onConnect: { addListener(fn: (port: Port) => void): void };
};

/** One page: registry, bus and router over the shared hub, with fast timings. */
async function page(t: TestContext, hub: Hub, id: number, control: (op: string, args: unknown) => Promise<unknown> = async () => null) {
  const gm = createGm(hub.tab());
  const registry = await startRegistry(gm, "t", id, () => ({ url: `https://site.test/${id}`, title: `page ${id}`, frame: false, active: false, activeAt: 0 }), { heartbeatMs: 20, staleMs: 5_000 });
  const messaging = createMessaging({
    extensionId: "ext",
    log: createLogger("test"),
    leader: () => leaderOf(registry),
    exists: (other) => other === id || registry.live().some((tab) => tab.id === other),
    sender: (from) => (from === "content" ? { id: "ext", url: `https://site.test/${id}`, tab: { id } } : { id: "ext", url: "chrome-extension://ext/sw.js" }),
    control,
  });
  const bus = await startBus(gm, "t", registry, messaging.handle);
  messaging.attach((to, wire) => bus.send(to, wire));
  registry.onRemoved((gone) => messaging.peerGone(gone));
  t.after(async () => {
    await bus.stop();
    await registry.stop();
  });
  return {
    registry,
    messaging,
    content: messaging.runtime("content") as unknown as Runtime,
    background: messaging.runtime("background") as unknown as Runtime,
  };
}

describe("messaging", () => {
  it("delivers a content script's message to the leader's background and returns its synchronous response", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    await sleep(5);
    const other = await page(t, hub, 2);
    leader.messaging.setBackgroundReady(true);
    other.messaging.setBackgroundReady(true);
    leader.background.onMessage.addListener((message, sender, sendResponse) => sendResponse({ echo: message, from: sender.tab?.id }));
    assert.deepEqual(await other.content.sendMessage({ hi: 1 }), { echo: { hi: 1 }, from: 2 });
    assert.deepEqual(await leader.content.sendMessage("same tab"), { echo: "same tab", from: 1 });
  });

  it("waits for a response when a listener returns true or a promise", async (t) => {
    const hub = createHub();
    const tab = await page(t, hub, 1);
    tab.messaging.setBackgroundReady(true);
    tab.background.onMessage.addListener((message, _sender, sendResponse) => {
      if (message === "later") {
        setTimeout(() => sendResponse("done later"), 20);
        return true;
      }
      return undefined;
    });
    // Not an async function: a returned promise always answers, even with undefined, in Chrome as here.
    tab.background.onMessage.addListener((message) => (message === "promise" ? Promise.resolve("from a promise") : undefined));
    assert.equal(await tab.content.sendMessage("later"), "done later");
    assert.equal(await tab.content.sendMessage("promise"), "from a promise");
  });

  it("resolves undefined when nobody responds, and calls back with lastError set", async (t) => {
    const hub = createHub();
    const tab = await page(t, hub, 1);
    tab.messaging.setBackgroundReady(true);
    tab.background.onMessage.addListener(() => undefined);
    assert.equal(await tab.content.sendMessage("ignored"), undefined);
    const lastError = await new Promise((resolve) => tab.content.sendMessage("ignored", () => resolve(readLastError()?.message)));
    assert.equal(lastError, PORT_CLOSED);
  });

  it("fails with 'Receiving end does not exist' when nothing listens", async (t) => {
    const hub = createHub();
    const tab = await page(t, hub, 1);
    tab.messaging.setBackgroundReady(true);
    await assert.rejects(tab.content.sendMessage("nobody") as Promise<unknown>, new RegExp(NO_RECEIVER.replace(/\./g, "\\.")));
    // The background reaches extension pages, and there are none.
    await assert.rejects(tab.background.sendMessage("pages?") as Promise<unknown>, /Receiving end does not exist/);
  });

  it("holds a message for the background until it is ready", async (t) => {
    const hub = createHub();
    const tab = await page(t, hub, 1);
    const reply = tab.content.sendMessage("early");
    await sleep(30);
    tab.background.onMessage.addListener((_message, _sender, sendResponse) => sendResponse("started"));
    tab.messaging.setBackgroundReady(true);
    assert.equal(await reply, "started");
  });

  it("sends a background message again when the page it went to goes away unanswered", async (t) => {
    const hub = createHub();
    // A ghost leader: an old tab whose key outlived it. It never answers; the next oldest page should.
    const ghost = await page(t, hub, 1);
    await sleep(5);
    const live = await page(t, hub, 2);
    live.messaging.setBackgroundReady(true);
    live.background.onMessage.addListener((_message, _sender, sendResponse) => sendResponse("from the live leader"));
    await eventually(() => live.registry.live().length === 1, 1000);
    const reply = live.content.sendMessage("hello");
    await sleep(30);
    await ghost.registry.leave();
    assert.equal(await reply, "from the live leader");
  });

  it("delivers tabs.sendMessage from the background to one tab's content scripts", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    const other = await page(t, hub, 2);
    other.content.onMessage.addListener((message, sender, sendResponse) => sendResponse(`tab 2 got ${message} from ${sender.url}`));
    await eventually(() => leader.registry.live().length === 1, 1000);
    const reply = await (leader.messaging.tabs.sendMessage(2, "ping") as Promise<unknown>);
    assert.equal(reply, "tab 2 got ping from chrome-extension://ext/sw.js");
    await assert.rejects(leader.messaging.tabs.sendMessage(99, "nobody") as Promise<unknown>, /Receiving end does not exist/);
  });

  it("settles a pending request as closed when the other page goes away", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    const other = await page(t, hub, 2);
    other.content.onMessage.addListener(() => true); // keeps the channel open and never answers
    await eventually(() => leader.registry.live().length === 1, 1000);
    const reply = leader.messaging.tabs.sendMessage(2, "hello") as Promise<unknown>;
    await sleep(30);
    await other.registry.leave();
    assert.equal(await reply, undefined);
  });

  it("connects ports both ways, with names, messages and disconnects", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    const other = await page(t, hub, 2);
    leader.messaging.setBackgroundReady(true);
    const backgroundSaw: unknown[] = [];
    leader.background.onConnect.addListener((port) => {
      backgroundSaw.push(`connect ${port.name} from ${(port.sender as { tab: { id: number } }).tab.id}`);
      port.onMessage.addListener((message) => port.postMessage({ echo: message }));
      port.onDisconnect.addListener(() => backgroundSaw.push("disconnected"));
    });
    await eventually(() => other.registry.live().length === 1, 1000);
    const port = other.content.connect({ name: "chan" });
    const replies: unknown[] = [];
    port.onMessage.addListener((message) => replies.push(message));
    port.postMessage(1);
    port.postMessage(2);
    await eventually(() => replies.length === 2, 1000);
    assert.deepEqual(replies, [{ echo: 1 }, { echo: 2 }]);
    port.disconnect();
    await eventually(() => backgroundSaw.length === 2, 1000);
    assert.deepEqual(backgroundSaw, ["connect chan from 2", "disconnected"]);
    assert.throws(() => port.postMessage(3), /disconnected port/);
  });

  it("keeps a port's first messages while its background is starting", async (t) => {
    const hub = createHub();
    const tab = await page(t, hub, 1);
    const port = tab.content.connect({ name: "early" });
    const replies: unknown[] = [];
    port.onMessage.addListener((message) => replies.push(message));
    port.postMessage("first");
    await sleep(30);
    tab.background.onConnect.addListener((opened) => opened.onMessage.addListener((message) => opened.postMessage(`got ${message}`)));
    tab.messaging.setBackgroundReady(true);
    await eventually(() => replies.length === 1, 1000);
    assert.deepEqual(replies, ["got first"]);
  });

  it("opens a port again at the new leader when the first page leaves before taking it", async (t) => {
    const hub = createHub();
    const ghost = await page(t, hub, 1);
    await sleep(5);
    const live = await page(t, hub, 2);
    live.messaging.setBackgroundReady(true);
    live.background.onConnect.addListener((opened) => opened.onMessage.addListener((message) => opened.postMessage(`live got ${message}`)));
    await eventually(() => live.registry.live().length === 1, 1000);
    const port = live.content.connect();
    const replies: unknown[] = [];
    port.onMessage.addListener((message) => replies.push(message));
    port.postMessage("hi");
    await sleep(30);
    await ghost.registry.leave();
    await eventually(() => replies.length === 1, 1000);
    assert.deepEqual(replies, ["live got hi"]);
  });

  it("disconnects a port whose other end has no onConnect listener, with lastError set", async (t) => {
    const hub = createHub();
    const tab = await page(t, hub, 1);
    tab.messaging.setBackgroundReady(true);
    const port = tab.content.connect();
    const error = await new Promise((resolve) => port.onDisconnect.addListener(() => resolve(readLastError()?.message)));
    assert.equal(error, NO_RECEIVER);
  });

  it("disconnects ports when the other page goes away", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    const other = await page(t, hub, 2);
    leader.messaging.setBackgroundReady(true);
    leader.background.onConnect.addListener(() => {});
    await eventually(() => other.registry.live().length === 1, 1000);
    const port = other.content.connect();
    let disconnected = false;
    port.onDisconnect.addListener(() => (disconnected = true));
    await sleep(30);
    await leader.registry.leave();
    await eventually(() => disconnected, 1000);
  });

  it("runs another page's control requests and returns their result", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    const seen: unknown[] = [];
    await page(t, hub, 2, async (op, args) => {
      seen.push([op, args]);
      if (op === "fail") throw new Error("can't");
      return "ok";
    });
    await eventually(() => leader.registry.live().length === 1, 1000);
    assert.equal(await leader.messaging.control(2, "navigate", { url: "https://x.test/" }), "ok");
    await assert.rejects(leader.messaging.control(2, "fail", null), /can't/);
    assert.deepEqual(seen, [["navigate", { url: "https://x.test/" }], ["fail", null]]);
  });
});
```

In `test/unit/runtime-core.test.ts`, inside `describe("withFallback", ...)`, add this test before `it("doesn't fake then or toJSON, ...`:

```ts
  it("fakes every member when told 'all', as the background needs, but never then or toJSON", async () => {
    const alarms = withFallback(recorder(), "alarms", {}, "all") as Record<string, unknown>;
    await assert.rejects((alarms.create as () => Promise<unknown>)(), /chrome\.alarms\.create is not available in userscripts/);
    assert.equal(typeof (alarms.onAlarm as { addListener: unknown }).addListener, "function");
    assert.equal("anything" in alarms, true);
    assert.equal(alarms.then, undefined);
    assert.equal(alarms.toJSON, undefined);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:file -- test/unit/messaging.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

Run: `npm run test:file -- test/unit/runtime-core.test.ts`
Expected: FAIL, in the new `"all"` test only: `alarms.create is not a function`.

- [ ] **Step 3: Replace `src/runtime/chrome.ts`**

```ts
// What every chrome.* namespace shares (spec §5.2, §9): logging with the extension's name, calls that take a trailing
// callback or return a promise, runtime.lastError, events, and a named rejection for any member this version doesn't
// implement.

export type Logger = {
  error(...args: unknown[]): void;
  /** Logs once per key for the page's lifetime. */
  once(key: string, ...args: unknown[]): void;
};

export function createLogger(name: string): Logger {
  const prefix = `[ext2userscript:${name}]`;
  const seen = new Set<string>();
  return {
    error: (...args) => console.error(prefix, ...args),
    once: (key, ...args) => {
      if (seen.has(key)) return;
      seen.add(key);
      console.error(prefix, ...args);
    },
  };
}

let lastError: { message: string } | undefined;
let lastErrorChecked = false;

/** chrome.runtime.lastError: set only while a failed call's callback runs. */
export function readLastError(): { message: string } | undefined {
  lastErrorChecked = true;
  return lastError;
}

/** Runs a callback with runtime.lastError set, as Chrome does, and logs the error if the callback never looked at it. */
export function callWithLastError(log: Logger, error: unknown, callback: () => void): void {
  lastError = { message: error instanceof Error ? error.message : String(error) };
  lastErrorChecked = false;
  try {
    callback();
  } finally {
    if (!lastErrorChecked) log.error(`Unchecked runtime.lastError: ${lastError.message}`);
    lastError = undefined;
  }
}

/** A chrome.* method: with a trailing callback it calls back (setting lastError on failure); without one it returns a promise. */
export function method<A extends unknown[], R>(log: Logger, impl: (...args: A) => Promise<R>) {
  return (...args: unknown[]): Promise<R> | undefined => {
    const callback = typeof args[args.length - 1] === "function" ? (args.pop() as (result?: R) => void) : undefined;
    let promise: Promise<R>;
    try {
      promise = impl(...(args as A));
    } catch (error) {
      promise = Promise.reject(error);
    }
    if (!callback) return promise;
    promise.then(
      (result) => callback(result),
      (error: unknown) => callWithLastError(log, error, () => callback()),
    );
    return undefined;
  };
}

export type ChromeEvent<F extends (...args: never[]) => unknown> = {
  addListener(listener: F): void;
  removeListener(listener: F): void;
  hasListener(listener: F): boolean;
  hasListeners(): boolean;
};

/** A chrome.* event. onFirstListener runs when the first listener is added, so costly watching starts only when needed. */
export function createEvent<F extends (...args: never[]) => unknown>(log: Logger, onFirstListener?: () => void) {
  const listeners = new Set<F>();
  const event: ChromeEvent<F> = {
    addListener: (listener) => {
      if (listeners.size === 0) onFirstListener?.();
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    hasListener: (listener) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
  };
  /** Calls every listener; returns what each returned (undefined for one that threw). */
  const dispatch = (...args: Parameters<F>): unknown[] =>
    [...listeners].map((listener) => {
      try {
        return listener(...args);
      } catch (error) {
        log.error("Error in event handler:", error);
        return undefined;
      }
    });
  return { event, dispatch };
}

export const unavailable = (api: string) => new Error(`ext2userscript: chrome.${api} is not available in userscripts`);

/**
 * Wraps a namespace so that the members Chrome gives content scripts but this version doesn't implement (faked) fail
 * with a named error, logged once (spec §9): an event's addListener logs that the listener will never be called, and a
 * method rejects or calls back with lastError set. Any other missing member is undefined, as in Chrome, so feature
 * detection takes the content-script path.
 */
export function withFallback<T extends object>(log: Logger, namespace: string, members: T, faked: readonly string[] | "all"): T {
  // "all": the background, where Chrome has every API the manifest asks for. `then` and `toJSON` are never faked, so a
  // namespace never looks like a promise or changes JSON output.
  const fakes = (property: string) => (faked === "all" ? property !== "then" && property !== "toJSON" : faked.includes(property));
  return new Proxy(members, {
    has: (target, property) => property in target || (typeof property === "string" && fakes(property)),
    get(target, property, receiver) {
      if (typeof property === "symbol" || property in target || !fakes(property)) return Reflect.get(target, property, receiver);
      const api = `${namespace}.${property}`;
      if (/^on[A-Z]/.test(property)) {
        return {
          addListener: () => log.once(api, `${unavailable(api).message}; the listener will never be called`),
          removeListener: () => {},
          hasListener: () => false,
          hasListeners: () => false,
        };
      }
      return method(log, () => {
        log.once(api, unavailable(api).message);
        return Promise.reject(unavailable(api));
      });
    },
  });
}
```

- [ ] **Step 4: Write `src/runtime/messaging.ts`**

```ts
// Extension messaging (spec §5.3). Every page runs one router. It carries:
// - runtime.sendMessage / onMessage and runtime.connect / onConnect, between content scripts and the background;
// - tabs.sendMessage / tabs.connect, from the background to one tab's content scripts;
// - control requests the tabs API sends to another tab (navigate, reload, close).
// Everything travels as JSON over the cross-tab bus. A message for this same page goes through the bus too, which
// delivers it in a microtask, so delivery is always asynchronous and always a copy, as in Chrome.
import { callWithLastError, createEvent, type ChromeEvent, type Logger } from "./chrome.ts";

export type Endpoint = "content" | "background";
export type MessageSender = { id: string; url?: string; origin?: string; frameId?: number; tab?: unknown };

type Side = "opener" | "receiver";
type Outcome = { data?: unknown; error?: string; none?: boolean };
type Wire =
  | { k: "msg"; id: string; to: Endpoint; data: unknown; sender: MessageSender }
  | ({ k: "reply"; id: string } & Outcome)
  | { k: "open"; port: string; to: Endpoint; name: string; sender: MessageSender }
  | { k: "post"; port: string; side: Side; data: unknown }
  | { k: "close"; port: string; side: Side; error?: string }
  | { k: "accepted"; port: string }
  | { k: "ctl"; id: string; op: string; args: unknown };

export const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";
export const PORT_CLOSED = "The message port closed before a response was received.";
const REPLY_TIMEOUT_MS = 30_000;
/** How long a page holds messages for its background while it waits to lead (the election's grace period and boot). */
const HOLD_MS = 5_000;

export type Port = {
  name: string;
  sender?: MessageSender;
  onMessage: ChromeEvent<(message: unknown, port: Port) => void>;
  onDisconnect: ChromeEvent<(port: Port) => void>;
  postMessage(message: unknown): void;
  disconnect(): void;
};

type MessageListener = (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => unknown;

export type MessagingDeps = {
  extensionId: string;
  log: Logger;
  /** The page whose background receives runtime messages: the expected leader. */
  leader(): number | undefined;
  /** What the receiving end sees as sender, for messages and ports opened from this endpoint. Read when the message
   * leaves, so a message sent before this page knows its tab id still carries sender.tab. */
  sender(from: Endpoint): MessageSender;
  /** Whether a tab or frame with this id is live (or is this page), so a message to a closed tab fails at once. */
  exists(id: number): boolean;
  /** Runs a control request from another page's tabs API on this page. */
  control(op: string, args: unknown): Promise<unknown>;
};

export type Messaging = ReturnType<typeof createMessaging>;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createMessaging(deps: MessagingDeps) {
  const { log } = deps;
  // Message and port ids only need to be unique; this page's tab id isn't known yet when its first content script runs.
  const instance = Math.random().toString(36).slice(2, 10);
  const nextId = () => `${instance}:${++counter}`;
  let transport: ((to: number, wire: Wire) => Promise<void>) | undefined;
  const queued: Array<() => void> = [];
  let counter = 0;
  let backgroundReady = false;
  // Waiting for this page's background: messages and port openings for it, and whatever arrives on a port whose
  // opening waits, so a port's first postMessage isn't lost.
  const held: Array<{ wire: Wire; from: number; timer?: ReturnType<typeof setTimeout> }> = [];
  const opening = (port: string) => held.some((entry) => entry.wire.k === "open" && entry.wire.port === port);
  type Pending = { to?: number; settle(outcome: Outcome): void; resend?(): boolean };
  const pending = new Map<string, Pending>();
  type PortEntry = {
    peer(): number | undefined;
    receive(data: unknown): void;
    close(error?: string): void;
    /** The other end took the connection (its onConnect ran). */
    accepted?(): void;
    /** Opens again at whoever leads now, when the page it went to left before taking it. False once taken. */
    reroute?(): boolean;
  };
  const ports = new Map<string, PortEntry>();
  const events = {
    content: { message: createEvent<MessageListener>(log), connect: createEvent<(port: Port) => void>(log) },
    background: { message: createEvent<MessageListener>(log), connect: createEvent<(port: Port) => void>(log) },
  };

  /** Sends once the bus is up and the target is known; noTarget runs when there is nobody to send to. */
  const post = (target: () => number | undefined, wire: Wire | (() => Wire), noTarget?: () => void, onTarget?: (to: number) => void) => {
    const go = () => {
      const to = target();
      if (to === undefined) return noTarget?.();
      onTarget?.(to);
      transport?.(to, typeof wire === "function" ? wire() : wire).catch((error: unknown) => log.error("couldn't send a message:", error));
    };
    if (transport) go();
    else queued.push(go);
  };

  /**
   * Sends a request and settles with its reply, or with `none` if the other end goes away or 30 s pass. A request for the
   * background is sent again (up to twice) when the page it went to goes away first: the page may have been a ghost
   * that never got it, and the new leader should answer.
   */
  const request = (target: () => number | undefined, id: string, wire: () => Wire, toBackground = false): Promise<Outcome> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => entry.settle({ none: true }), REPLY_TIMEOUT_MS);
      let sends = 0;
      const go = () => {
        sends++;
        entry.to = undefined;
        post(target, wire, () => entry.settle({ error: NO_RECEIVER }), (to) => (entry.to = to));
      };
      const entry: Pending = {
        settle: (outcome) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(outcome);
        },
        ...(toBackground ? { resend: () => sends < 3 && (go(), true) } : {}),
      };
      pending.set(id, entry);
      go();
    });

  /** Chrome's two calling styles: a trailing callback (lastError on failure), or a promise. */
  const finish = (outcome: Promise<Outcome>, callback?: (response?: unknown) => void): Promise<unknown> | undefined => {
    if (callback) {
      void outcome.then((result) => {
        if (result.error !== undefined) callWithLastError(log, new Error(result.error), () => callback());
        else if (result.none) callWithLastError(log, new Error(PORT_CLOSED), () => callback());
        else callback(result.data);
      });
      return undefined;
    }
    return outcome.then((result) => {
      if (result.error !== undefined) throw new Error(result.error);
      return result.none ? undefined : result.data;
    });
  };

  const send = (target: () => number | undefined, to: Endpoint, data: unknown, from: Endpoint, callback?: (response?: unknown) => void) => {
    const id = nextId();
    return finish(request(target, id, () => ({ k: "msg", id, to, data, sender: deps.sender(from) }), to === "background"), callback);
  };

  /**
   * Creates one end of a port. `open` is set for the end that connects: it sends the opening, and keeps what was posted
   * until the other end takes the connection, so the opening can be sent again to a new leader if the first page it
   * went to leaves first (a ghost, say). Once taken, the other end leaving disconnects the port, as in Chrome.
   */
  const createPort = (id: string, side: Side, name: string, resolvePeer: () => number | undefined, sender?: MessageSender, open?: () => Wire): Port => {
    let peer: number | undefined;
    const target = () => (peer ??= resolvePeer());
    const other: Side = side === "opener" ? "receiver" : "opener";
    const onMessage = createEvent<(message: unknown, port: Port) => void>(log);
    const onDisconnect = createEvent<(port: Port) => void>(log);
    let closed = false;
    let taken = !open;
    let reroutes = 0;
    const unanswered: unknown[] = [];
    const key = `${id}:${side}`;
    const sendOpen = () => {
      if (open) post(target, open, () => setTimeout(() => ports.get(key)?.close(NO_RECEIVER)));
    };
    const port: Port = {
      name,
      ...(sender ? { sender } : {}),
      onMessage: onMessage.event,
      onDisconnect: onDisconnect.event,
      postMessage: (message) => {
        if (closed) throw new Error("Attempting to use a disconnected port object");
        if (!taken) unanswered.push(message);
        post(target, { k: "post", port: id, side: other, data: message });
      },
      // Chrome fires onDisconnect only at the other end.
      disconnect: () => {
        if (closed) return;
        closed = true;
        ports.delete(key);
        post(target, { k: "close", port: id, side: other });
      },
    };
    ports.set(key, {
      peer: () => peer,
      receive: (data) => {
        if (!closed) onMessage.dispatch(data, port);
      },
      close: (error) => {
        if (closed) return;
        closed = true;
        ports.delete(key);
        if (error === undefined) onDisconnect.dispatch(port);
        else callWithLastError(log, new Error(error), () => onDisconnect.dispatch(port));
      },
      accepted: () => {
        taken = true;
        unanswered.length = 0;
      },
      reroute: () => {
        if (taken || closed || reroutes >= 2) return false;
        reroutes++;
        peer = undefined;
        sendOpen();
        for (const message of unanswered) post(target, { k: "post", port: id, side: other, data: message });
        return true;
      },
    });
    sendOpen();
    return port;
  };

  const connect = (target: () => number | undefined, to: Endpoint, name: string, from: Endpoint): Port => {
    const id = nextId();
    return createPort(id, "opener", name, target, undefined, () => ({ k: "open", port: id, to, name, sender: deps.sender(from) }));
  };

  const onMessage = (wire: Wire & { k: "msg" }, from: number) => {
    const { message } = events[wire.to];
    let done = false;
    const respond = (outcome: Outcome) => {
      if (done) return;
      done = true;
      post(() => from, { k: "reply", id: wire.id, ...outcome });
    };
    if (!message.event.hasListeners()) return respond({ error: NO_RECEIVER });
    let open = false;
    // A listener keeps the channel open by returning true (and calling sendResponse later) or by returning a promise.
    for (const result of message.dispatch(wire.data, wire.sender, (data?: unknown) => respond({ data }))) {
      if (result === true) open = true;
      else if (result instanceof Promise) {
        open = true;
        result.then((data: unknown) => respond({ data }), (error: unknown) => respond({ error: messageOf(error) }));
      }
    }
    if (!open) respond({ none: true });
  };

  const onOpen = (wire: Wire & { k: "open" }, from: number) => {
    const { connect: event } = events[wire.to];
    if (!event.event.hasListeners()) return post(() => from, { k: "close", port: wire.port, side: "opener", error: NO_RECEIVER });
    event.dispatch(createPort(wire.port, "receiver", wire.name, () => from, wire.sender));
    post(() => from, { k: "accepted", port: wire.port });
  };

  const refuse = (wire: Wire & { k: "msg" | "open" }, from: number) =>
    post(() => from, wire.k === "msg" ? { k: "reply", id: wire.id, error: NO_RECEIVER } : { k: "close", port: wire.port, side: "opener", error: NO_RECEIVER });

  const handle = (payload: unknown, from: number): void => {
    const wire = payload as Wire;
    switch (wire.k) {
      case "msg":
      case "open":
        if (wire.to === "background" && !backgroundReady) {
          const entry = {
            wire,
            from,
            timer: setTimeout(() => {
              if (!held.includes(entry)) return;
              // Refused: it goes, and so does anything held for the port it would have opened.
              const port = wire.k === "open" ? wire.port : undefined;
              held.splice(0, held.length, ...held.filter((other) => other !== entry && !("port" in other.wire && other.wire.port === port)));
              refuse(wire, from);
            }, HOLD_MS),
          };
          held.push(entry);
        } else if (wire.k === "msg") onMessage(wire, from);
        else onOpen(wire, from);
        return;
      case "reply":
        pending.get(wire.id)?.settle(wire);
        return;
      case "accepted":
        ports.get(`${wire.port}:opener`)?.accepted?.();
        return;
      case "post":
      case "close": {
        const port = ports.get(`${wire.port}:${wire.side}`);
        if (!port && opening(wire.port)) held.push({ wire, from });
        else if (wire.k === "post") port?.receive(wire.data);
        else port?.close(wire.error);
        return;
      }
      case "ctl":
        deps.control(wire.op, wire.args).then(
          (data) => post(() => from, { k: "reply", id: wire.id, data }),
          (error: unknown) => post(() => from, { k: "reply", id: wire.id, error: messageOf(error) }),
        );
        return;
    }
  };

  /** A target for one tab: nobody, if no such tab is live. */
  const tab = (tabId: number) => () => (deps.exists(tabId) ? tabId : undefined);

  /** The runtime.* messaging members for content scripts or the background. */
  const runtime = (endpoint: Endpoint) => ({
    sendMessage: (...args: unknown[]) => {
      const callback = typeof args[args.length - 1] === "function" ? (args.pop() as (response?: unknown) => void) : undefined;
      // (message), (extensionId, message) or (extensionId, message, options)
      const external = args.length >= 2 && typeof args[0] === "string" && args[0] !== deps.extensionId;
      const message = args.length >= 2 ? args[1] : args[0];
      // Content scripts reach the background. The background reaches extension pages, and this version has none.
      const target = endpoint === "content" && !external ? deps.leader : () => undefined;
      return send(target, "background", message, endpoint, callback);
    },
    onMessage: events[endpoint].message.event,
    connect: (...args: unknown[]): Port => {
      const info = (typeof args[args.length - 1] === "object" ? args[args.length - 1] : undefined) as { name?: string } | undefined;
      return connect(endpoint === "content" ? deps.leader : () => undefined, "background", info?.name ?? "", endpoint);
    },
    onConnect: events[endpoint].connect.event,
  });

  return {
    /** Starts sending through the bus; anything sent before then goes now. */
    attach(sendWire: (to: number, wire: unknown) => Promise<void>) {
      transport = sendWire;
      for (const go of queued.splice(0)) go();
    },
    /** The bus handler: every wire message for this page. */
    handle,
    /** Whether this page's background has started (and still leads); until then, background messages are held. */
    setBackgroundReady(ready: boolean) {
      backgroundReady = ready;
      if (!ready) return;
      for (const entry of held.splice(0)) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        handle(entry.wire, entry.from);
      }
    },
    /** A page went away: its pending replies settle as closed, and ports to it disconnect. */
    peerGone(id: number) {
      for (const entry of [...pending.values()]) if (entry.to === id && !entry.resend?.()) entry.settle({ none: true });
      for (const port of [...ports.values()]) if (port.peer() === id && !port.reroute?.()) port.close();
    },
    runtime,
    tabs: {
      sendMessage: (tabId: number, message: unknown, ...rest: unknown[]) => {
        const callback = typeof rest[rest.length - 1] === "function" ? (rest.pop() as (response?: unknown) => void) : undefined;
        return send(tab(tabId), "content", message, "background", callback);
      },
      connect: (tabId: number, info?: { name?: string }) => connect(tab(tabId), "content", info?.name ?? "", "background"),
    },
    /** Asks another page to run a control request (the tabs API's update, reload and remove). */
    control: async (tabId: number, op: string, args: unknown): Promise<unknown> => {
      const id = nextId();
      const outcome = await request(tab(tabId), id, () => ({ k: "ctl", id, op, args }));
      if (outcome.error !== undefined) throw new Error(outcome.error);
      return outcome.data;
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:file -- test/unit/messaging.test.ts` and `npm run test:file -- test/unit/runtime-core.test.ts`
Expected: both PASS. Run the messaging file 5 times; it should pass every time.

- [ ] **Step 6: Type-check and commit**

Run: `npm run typecheck` (expected: exit 0), then:

```bash
git add src/runtime/chrome.ts src/runtime/messaging.ts test/unit/messaging.test.ts test/unit/runtime-core.test.ts
git commit -m "Route runtime messages, ports and tabs.sendMessage between pages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: chrome.tabs

**Files:**
- Create: `src/runtime/tabs.ts`
- Test: `test/unit/tabs.test.ts`

**Interfaces:**
- Consumes:
  - `Registry` with `onUpdated` (Task 1);
  - `Messaging` (Task 3);
  - `method`, `createEvent` (Task 3);
  - `urlMatches` (Plan 2);
  - `gm.openInTab` (Plan 1).
- Produces:
  - `type ChromeTab`, `WINDOW_ID`, `toChromeTab(info, index)`;
  - `createTabs({ gm, registry, messaging, log, dispatching })`, which returns:
    - `selfTab(): ChromeTab`;
    - `control(op, args)`;
    - `updated(info, previous)`;
    - `api`: `TAB_ID_NONE`, `query`, `get`, `getCurrent`, `sendMessage`, `connect`, `create`, `update`, `reload`, `remove`, `onCreated`, `onRemoved`, `onUpdated` and `onActivated`.

- [ ] **Step 1: Write the failing test** `test/unit/tabs.test.ts`

```ts
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
    return createTabs({ gm, registry, messaging, log: createLogger("test"), dispatching: () => true });
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
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/tabs.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write `src/runtime/tabs.ts`**

```ts
// chrome.tabs for the background (spec §5.2), from the tab registry: every page where the userscript runs is a tab,
// in one synthetic window (id 1). Events come from registry changes; update, reload and remove ask the target page
// to act on itself; create opens a tab with gm.openInTab and waits for it to join.
import { createEvent, method, type Logger } from "./chrome.ts";
import type { Gm, TabControl } from "./gm.ts";
import { urlMatches } from "./match.ts";
import type { Messaging } from "./messaging.ts";
import type { Registry, TabInfo } from "./registry.ts";

export type ChromeTab = {
  id: number;
  index: number;
  windowId: number;
  active: boolean;
  highlighted: boolean;
  pinned: boolean;
  incognito: boolean;
  discarded: boolean;
  autoDiscardable: boolean;
  groupId: number;
  status: "complete";
  url: string;
  title: string;
};

export const WINDOW_ID = 1;
/** How long tabs.create waits for the new page to join the registry. */
const CREATE_WAIT_MS = 5_000;

type Query = { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean; windowId?: number; url?: string | string[]; title?: string; index?: number; status?: string };

/** The Tab object Chrome hands out, for one registry entry. */
export function toChromeTab(info: Pick<TabInfo, "id" | "url" | "title" | "active">, index: number): ChromeTab {
  return {
    id: info.id,
    index,
    windowId: WINDOW_ID,
    active: info.active,
    highlighted: info.active,
    pinned: false,
    incognito: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    status: "complete",
    url: info.url,
    title: info.title,
  };
}

export function createTabs(deps: { gm: Gm; registry: Registry; messaging: Messaging; log: Logger; dispatching(): boolean }) {
  const { gm, registry, messaging, log } = deps;
  const opened = new Map<number, TabControl>();
  const onCreated = createEvent<(tab: ChromeTab) => void>(log);
  const onRemoved = createEvent<(tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void>(log);
  const onUpdated = createEvent<(tabId: number, change: Record<string, unknown>, tab: ChromeTab) => void>(log);
  const onActivated = createEvent<(info: { tabId: number; windowId: number }) => void>(log);

  /** Every tab, this page included, oldest first; frames aren't tabs. */
  const all = (): ChromeTab[] => {
    const me = registry.self();
    const infos = [...registry.live(), ...(me.present ? [{ ...me, ts: Date.now() }] : [])].filter((tab) => !tab.frame).sort((a, b) => a.since - b.since || a.id - b.id);
    return infos.map((info, index) => toChromeTab(info, index));
  };
  const find = (tabId: number) => {
    const tab = all().find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  };
  /** The most recently activated visible tab: what Chrome calls the active tab of the current window. */
  const current = () => {
    const me = registry.self();
    const infos = [...registry.live(), me].filter((tab) => !tab.frame && tab.active);
    return infos.sort((a, b) => b.activeAt - a.activeAt)[0]?.id;
  };
  const emit = (dispatch: () => void) => {
    if (deps.dispatching()) dispatch();
  };

  registry.onAdded((info) => {
    if (!info.frame) emit(() => onCreated.dispatch(find(info.id)));
  });
  registry.onRemoved((id) => {
    opened.delete(id);
    emit(() => onRemoved.dispatch(id, { windowId: WINDOW_ID, isWindowClosing: false }));
  });
  /** Also called for this page's own changes, which the registry doesn't report to itself. */
  const updated = (info: TabInfo, previous: TabInfo) => {
    if (info.frame) return;
    const change: Record<string, unknown> = {};
    if (info.url !== previous.url) change.url = info.url;
    if (info.title !== previous.title) change.title = info.title;
    if (Object.keys(change).length > 0) emit(() => onUpdated.dispatch(info.id, { status: "complete", ...change }, find(info.id)));
    if (info.active && info.activeAt !== previous.activeAt) emit(() => onActivated.dispatch({ tabId: info.id, windowId: WINDOW_ID }));
  };
  registry.onUpdated(updated);

  const create = async (properties: { url?: string; active?: boolean } = {}): Promise<ChromeTab> => {
    const url = properties.url ?? "about:blank";
    if (!/^[a-z][a-z\d+.-]*:/i.test(url)) throw new Error(`ext2userscript: tabs.create can't open extension pages (${url}) yet`);
    const started = Date.now();
    const control = await gm.openInTab(url, { active: properties.active ?? true });
    // The new page's id is its own choice, so wait for a tab with this URL to join; a page the userscript doesn't run on never will.
    const wanted = new URL(url, location.href).href;
    const joined = await new Promise<TabInfo | undefined>((resolve) => {
      let settled = false; // registry listeners can't be removed, so a settled check stays a no-op
      const timer = setTimeout(() => {
        settled = true;
        resolve(undefined);
      }, CREATE_WAIT_MS);
      registry.onAdded((info) => {
        if (settled || info.frame || info.since < started - 1_000 || info.url !== wanted) return;
        settled = true;
        clearTimeout(timer);
        resolve(info);
      });
    });
    if (!joined) return { ...toChromeTab({ id: -1, url, title: "", active: properties.active ?? true }, -1) };
    opened.set(joined.id, control);
    return find(joined.id);
  };

  const remove = async (tabIds: number | number[]) => {
    for (const id of typeof tabIds === "number" ? [tabIds] : tabIds) {
      const control = opened.get(id);
      if (control) control.close();
      else await messaging.control(id, "close", null);
    }
  };

  return {
    /** This page as sender.tab. A frame isn't a tab: it reports itself, so a reply or tabs.sendMessage still reaches it. */
    selfTab: (): ChromeTab => {
      const me = registry.self();
      return me.frame ? toChromeTab(me, -1) : find(me.id);
    },
    /** The control requests this page answers (see messaging.ts). */
    control: async (op: string, args: unknown): Promise<unknown> => {
      if (op === "close") window.close();
      else if (op === "reload") location.reload();
      else if (op === "navigate") location.href = String((args as { url: string }).url);
      else throw new Error(`unknown tab control ${op}`);
      return null;
    },
    updated,
    api: {
      TAB_ID_NONE: -1,
      query: method(log, async (query: Query = {}) =>
        all().filter((tab) => {
          if (query.active !== undefined && (tab.id === current()) !== query.active) return false;
          if (query.windowId !== undefined && query.windowId !== WINDOW_ID && query.windowId !== -2) return false;
          if (query.url !== undefined && !urlMatches(tab.url, typeof query.url === "string" ? [query.url] : query.url)) return false;
          if (query.title !== undefined && tab.title !== query.title) return false;
          if (query.index !== undefined && tab.index !== query.index) return false;
          return true;
        }),
      ),
      get: method(log, async (tabId: number) => find(tabId)),
      // The background isn't a tab.
      getCurrent: method(log, async () => undefined),
      sendMessage: messaging.tabs.sendMessage,
      connect: messaging.tabs.connect,
      create: method(log, create),
      update: method(log, async (...args: unknown[]) => {
        const [tabId, properties] = typeof args[0] === "number" ? [args[0], args[1] as { url?: string }] : [current(), args[0] as { url?: string }];
        if (tabId === undefined) throw new Error("No current tab");
        if (properties?.url) await messaging.control(tabId, "navigate", { url: properties.url });
        return find(tabId);
      }),
      reload: method(log, async (tabId?: number) => {
        const target = typeof tabId === "number" ? tabId : current();
        if (target !== undefined) await messaging.control(target, "reload", null);
      }),
      remove: method(log, remove),
      onCreated: onCreated.event,
      onRemoved: onRemoved.event,
      onUpdated: onUpdated.event,
      onActivated: onActivated.event,
    },
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test:file -- test/unit/tabs.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `npm run typecheck` (expected: exit 0), then:

```bash
git add src/runtime/tabs.ts test/unit/tabs.test.ts
git commit -m "Implement chrome.tabs from the tab registry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Bundle the background

**Files:**
- Modify:
  - `src/convert/scan.ts` (whole file below): token positions and `importScripts` calls;
  - `src/convert/esbuild.ts` (whole file below): `bundleModule` options;
  - `src/convert/bundle.ts` (whole file below): `bundleBackground`;
  - `test/support/extension.ts` (whole file below): adds `backgroundExtension` and `moduleBackgroundExtension`. `sampleExtension` is unchanged.
- Test: `test/unit/background-bundle.test.ts`

**Interfaces:**
- Consumes: `readManifest`, `Model` (Plan 2); `joinPath`, `dirname` (Plan 1).
- Produces:
  - **`ScanResult`** gains `importScripts: Array<{ start; end; urls? }>`.
  - **`esbuild.ts`:** `type ModuleOptions = { format?: "esm" | "iife"; define? }` and `bundleModule(esbuild, files, entry, options?)`.
  - **`bundle.ts`:**
    - `type BackgroundBundle = { code; worker; entry }`;
    - `type BackgroundResult = { background: BackgroundBundle | null; warnings; dynamicImportScripts; remoteImports }`;
    - `bundleBackground(model, files, esbuild?): Promise<BackgroundResult>`.
  - **`test/support/extension.ts`:** `backgroundExtension(origin)` and `moduleBackgroundExtension(origin)`.

- [ ] **Step 1: Write the test support and the failing test.** Replace `test/support/extension.ts` with:

```ts
// Sample extensions for conversion tests, built in memory.
// - sampleExtension exercises content scripts (no background).
// - backgroundExtension has a classic service worker that answers content scripts: messages, a port, tabs.sendMessage,
//   onInstalled, importScripts.
// - moduleBackgroundExtension has an ES-module service worker.
// - plainExtension is the smallest one that converts with no unsupported or partial entries.
import { strToU8, zipSync } from "fflate";
import type { ExtensionFiles } from "../../src/convert/unpack.ts";

/** A 1×1 PNG. */
export const PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

export const files = (entries: Record<string, string | Uint8Array>): ExtensionFiles =>
  new Map(Object.entries(entries).map(([path, content]) => [path, typeof content === "string" ? strToU8(content) : content]));

export const zipFiles = (extension: ExtensionFiles): Uint8Array<ArrayBuffer> => zipSync(Object.fromEntries(extension));

/** origin is where the test pages are served, e.g. http://127.0.0.1:4567. */
export function sampleExtension(origin: string): ExtensionFiles {
  const site = `${origin}/*`;
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "__MSG_extName__",
      version: "1.2.3",
      description: "__MSG_extDescription__",
      default_locale: "en",
      icons: { "16": "icons/16.png", "48": "icons/48.png" },
      web_accessible_resources: [{ resources: ["inject.js", "data/*"], matches: ["<all_urls>"] }],
      content_scripts: [
        { matches: [site], exclude_matches: [`${origin}/excluded*`], js: ["lib.js", "content.js"], css: ["style.css"], all_frames: true },
        { matches: [site], js: ["main-world.js"], world: "MAIN", run_at: "document_end" },
        { matches: [site], js: ["start.js"], run_at: "document_start" },
        { matches: [site], include_globs: ["*glob-yes*"], js: ["glob.js"] },
        { matches: [site], js: ["broken.js"] },
      ],
    }),
    "_locales/en/messages.json": JSON.stringify({
      extName: { message: "Sample Extension" },
      extDescription: { message: "Exercises content scripts" },
      greeting: { message: "Hello $WHO$", placeholders: { who: { content: "$1" } } },
    }),
    "_locales/fr/messages.json": JSON.stringify({ greeting: { message: "Bonjour $who$", placeholders: { who: { content: "$1" } } } }),
    // webextension-polyfill 0.10+ refuses to load unless globalThis.chrome looks like an extension's.
    // Sloppy code, as many content scripts are: assigning an undeclared name would throw if the group ran strict.
    "lib.js": 'if (!globalThis.chrome?.runtime?.id) throw new Error("not in an extension");\nsampleUndeclared = 1;\nvar sampleLib = { tag: "lib" }; // no newline at the end',
    "content.js": `const browser = chrome;
const html = document.documentElement;
html.dataset.content = sampleLib.tag;
html.dataset.greeting = browser.i18n.getMessage("greeting", ["x2u"]);
chrome.storage.local.get({ visits: 0 }).then(({ visits }) => chrome.storage.local.set({ visits: visits + 1 })).then(() => { html.dataset.stored = "1"; });
fetch(chrome.runtime.getURL("data/info.json")).then((r) => r.json()).then((info) => { html.dataset.info = info.kind; });
const script = document.createElement("script");
script.src = chrome.runtime.getURL("inject.js");
script.onload = () => { script.remove(); html.dataset.injectLoaded = "1"; };
(document.head || html).appendChild(script);
chrome.runtime.sendMessage({ hello: true }).catch((error) => { html.dataset.sendError = error.message; });
chrome.storage.onChanged.addListener((changes) => {
  const seen = new Set((html.dataset.changed || "").split(",").filter(Boolean));
  for (const key of Object.keys(changes)) seen.add(key);
  html.dataset.changed = [...seen].sort().join(",");
});
if (location.pathname === "/writer.html") setTimeout(() => chrome.storage.local.set({ fromWriter: Date.now() }), 500);
`,
    "style.css": ".x2u-box { color: rgb(1, 2, 3); background-image: url(img/dot.png); }",
    "inject.js": 'document.documentElement.dataset.injected = typeof chrome === "object" && chrome !== null && chrome.runtime && chrome.runtime.getURL ? "extension" : "page";',
    "main-world.js": "document.documentElement.dataset.main = String(window.pageValue);",
    "start.js": `const startState = document.readyState;
const markStart = () => document.documentElement.setAttribute("data-start", startState);
if (document.documentElement) markStart(); else document.addEventListener("DOMContentLoaded", markStart);`,
    "glob.js": 'document.documentElement.dataset.glob = "1";',
    "broken.js": 'throw new Error("this group fails on purpose");',
    "data/info.json": '{"kind":"sample"}',
    "img/dot.png": PIXEL,
    "icons/16.png": PIXEL,
    "icons/48.png": PIXEL,
    "unused.txt": "not referenced anywhere",
  });
}

/** origin is where the test pages are served. Content scripts run in frames too, so a frame's messages are answered. */
export function backgroundExtension(origin: string): ExtensionFiles {
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Background Sample",
      version: "3.0.0",
      background: { service_worker: "sw.js" },
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"], all_frames: true }],
    }),
    // A classic service worker: importScripts with string literals is inlined when the extension is converted. Its first
    // line uses an API this version doesn't implement; that call fails, and the rest of the background still runs.
    "sw.js": `chrome.alarms.create("tick", { periodInMinutes: 1 }).catch(() => {});
importScripts("lib/helper.js");
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "hello") sendResponse({ text: shout(message.text), tab: typeof sender.tab.id });
  if (message.type === "ping-me") chrome.tabs.sendMessage(sender.tab.id, { type: "pong", from: "background" });
});
chrome.runtime.onConnect.addListener((port) => port.onMessage.addListener((value) => port.postMessage(value * 2)));
chrome.runtime.onInstalled.addListener((details) => chrome.storage.local.set({ installedReason: details.reason }));
self.addEventListener("install", () => self.skipWaiting());
`,
    "lib/helper.js": "function shout(text) { return text.toUpperCase(); }",
    "content.js": `const html = document.documentElement;
chrome.runtime.sendMessage({ type: "hello", text: "x2u" }).then((reply) => { html.dataset.reply = reply.text + "@" + reply.tab; });
const port = chrome.runtime.connect({ name: "doubler" });
port.onMessage.addListener((value) => { html.dataset.port = String(value); });
port.postMessage(21);
chrome.runtime.onMessage.addListener((message) => { if (message.type === "pong") html.dataset.pong = message.from; });
chrome.runtime.sendMessage({ type: "ping-me" });
// onInstalled fires once per installed version; a real manager's profile keeps the stored reason from earlier runs.
const checkInstalled = () => chrome.storage.local.get("installedReason").then(({ installedReason }) => {
  if (installedReason) html.dataset.installed = installedReason;
  else setTimeout(checkInstalled, 200);
});
checkInstalled();
`,
  });
}

/** An ES-module service worker that imports a helper and reads import.meta.url. */
export function moduleBackgroundExtension(origin: string): ExtensionFiles {
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Module Background",
      version: "2.0.0",
      background: { service_worker: "bg/main.js", type: "module" },
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"] }],
    }),
    "bg/main.js": `import { label } from "./label.js";
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  sendResponse(label(new URL("icon.png", import.meta.url).pathname));
});`,
    "bg/label.js": 'export const label = (path) => "module:" + path;',
    "content.js": 'chrome.runtime.sendMessage("which").then((reply) => { document.documentElement.dataset.module = reply; });',
  });
}

/** Content scripts that use nothing unsupported or partial, so the report's verdict is likely-works. */
export function plainExtension(origin = "https://example.com"): ExtensionFiles {
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Plain Extension",
      version: "0.1.0",
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"] }],
    }),
    "content.js": 'chrome.storage.local.set({ seen: true }); document.documentElement.dataset.plain = "1";',
  });
}
```

Then write `test/unit/background-bundle.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bundleBackground } from "../../src/convert/bundle.ts";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import { scan } from "../../src/convert/scan.ts";
import { files, moduleBackgroundExtension } from "../support/extension.ts";

const extension = (manifest: Record<string, unknown>, extra: Record<string, string>) => {
  const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1.0", ...manifest }), ...extra });
  return { model: readManifest(all).model, files: all };
};

describe("scan: importScripts", () => {
  it("finds each call, where it is, and its literal URLs", () => {
    const code = 'importScripts("a.js", \'b.js\');\nself.importScripts(`c.js`);\nimportScripts(dynamic);\nother.importScripts("x.js");';
    const calls = scan(code).importScripts;
    assert.deepEqual(calls.map((call) => [code.slice(call.start, call.end), call.urls]), [
      ['importScripts("a.js", \'b.js\')', ["a.js", "b.js"]],
      ["self.importScripts(`c.js`)", ["c.js"]],
      ["importScripts(dynamic)", undefined],
    ]);
  });
});

describe("bundleBackground", () => {
  it("inlines importScripts in a classic service worker, resolving URLs against the worker, recursively", async () => {
    const { model, files: all } = extension({ background: { service_worker: "bg/sw.js" } }, {
      "bg/sw.js": 'importScripts("lib/a.js");\nconsole.log(a, b);',
      "bg/lib/a.js": 'var a = 1;\nimportScripts("lib/b.js");',
      "bg/lib/b.js": "var b = 2;",
    });
    const { background, warnings, dynamicImportScripts } = await bundleBackground(model, all);
    assert.deepEqual(warnings, []);
    assert.equal(dynamicImportScripts, false);
    assert.equal(background?.worker, true);
    assert.equal(background?.entry, "bg/sw.js");
    assert.equal(new Function(`${background?.code}\nreturn [a, b];`)().join(), "1,2");
    assert.match(background?.code ?? "", /\/\* importScripts\("lib\/a\.js"\) \*\//);
  });

  it("keeps a dynamic importScripts, reports it, and warns about missing and self-importing files", async () => {
    const { model, files: all } = extension({ background: { service_worker: "sw.js" } }, {
      "sw.js": 'importScripts(name);\nimportScripts("missing.js", "sw.js");',
    });
    const { background, warnings, dynamicImportScripts } = await bundleBackground(model, all);
    assert.equal(dynamicImportScripts, true);
    assert.match(background?.code ?? "", /importScripts\(name\)/);
    assert.deepEqual(warnings, [
      "importScripts in sw.js: missing.js isn't in the extension, so it was left out",
      'importScripts("sw.js") in sw.js imports itself, so it was left out the second time',
    ]);
  });

  it("concatenates MV2 background scripts and a background page's scripts in order", async () => {
    const scripts = extension({ manifest_version: 2, background: { scripts: ["a.js", "b.js"] } }, { "a.js": "var x = 1 // no newline", "b.js": "x++;" });
    const fromScripts = await bundleBackground(scripts.model, scripts.files);
    assert.deepEqual(fromScripts.background, { code: "var x = 1 // no newline\n;\nx++;", worker: false, entry: "a.js" });

    const page = extension({ manifest_version: 2, background: { page: "bg/page.html" } }, {
      "bg/page.html": '<html><head><script src="one.js"></script><script src=\'/two.js\'></script><script>inline()</script><script src="https://cdn.test/x.js"></script></head></html>',
      "bg/one.js": "var one = 1;",
      "two.js": "var two = 2;",
    });
    const fromPage = await bundleBackground(page.model, page.files);
    assert.deepEqual(fromPage.background, { code: "var one = 1;\n;\nvar two = 2;", worker: false, entry: "bg/page.html" });
    assert.deepEqual(fromPage.warnings, ["background.page loads https://cdn.test/x.js, which isn't in the extension, so it was left out"]);
  });

  it("bundles a module service worker into an IIFE with import.meta replaced", async () => {
    const ext = moduleBackgroundExtension("https://site.test");
    const { model } = readManifest(ext);
    const { background } = await bundleBackground(model, ext, await loadEsbuild());
    assert.equal(background?.worker, true);
    assert.doesNotMatch(background?.code ?? "", /\bexport\b|\bimport\b(?!\.)|import\.meta/);
    const replies: unknown[] = [];
    const chrome = { runtime: { onMessage: { addListener: (fn: (m: unknown, s: unknown, r: (v: unknown) => void) => void) => fn("x", {}, (v) => replies.push(v)) } } };
    new Function("chrome", "__x2uImportMeta", background?.code ?? "")(chrome, { url: "chrome-extension://id/bg/main.js" });
    assert.deepEqual(replies, ["module:/bg/icon.png"]);
  });

  it("needs esbuild for a module background", async () => {
    const ext = moduleBackgroundExtension("https://site.test");
    await assert.rejects(bundleBackground(readManifest(ext).model, ext), /needs the esbuild option/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/background-bundle.test.ts`
Expected: FAIL. `bundleBackground` isn't exported.

- [ ] **Step 3: Replace `src/convert/scan.ts`**

```ts
// A JavaScript scanner just deep enough for the analyzer (spec §3.4), the asset collector (§3.6) and the background
// bundler (§3.3). It skips comments, string and template text and regular expressions, then reads from what's left:
// member chains rooted at chrome or browser, the string-literal arguments of getURL(...), whether the code uses
// dynamic import(), and where it calls importScripts(...).
// Ceilings: aliasing (const c = chrome) and computed access (chrome["tabs"]) are missed, and a regular expression
// right after `)` or `}` is read as a division.

export type ScanResult = {
  /** Chains such as "chrome.tabs.query", in source order. browser.* is reported as chrome.*. */
  chains: string[];
  /** String literals passed to runtime.getURL or extension.getURL, as written. */
  urls: string[];
  dynamicImport: boolean;
  /** importScripts(...) calls: where each is in the code, and its URLs when every argument is a string literal. */
  importScripts: Array<{ start: number; end: number; urls?: string[] }>;
};

type Token = { kind: "name" | "punct" | "string" | "template" | "regex"; value: string; start: number; end: number };

const NAME_CHAR = /[\w$\u0080-￿]/;
/** Keywords after which a `/` starts a regular expression rather than a division. */
const BEFORE_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
/** `window.chrome` and friends are the global chrome; `foo.chrome` is someone else's property. */
const GLOBAL_OWNERS = new Set(["window", "globalThis", "self"]);

export function scan(code: string): ScanResult {
  const tokens = tokenize(code);
  const result: ScanResult = { chains: [], urls: [], dynamicImport: false, importScripts: [] };
  const isDot = (token: Token | undefined) => token?.kind === "punct" && (token.value === "." || token.value === "?.");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "name") continue;
    if (token.value === "import" && tokens[i + 1]?.value === "(" && !isDot(tokens[i - 1])) result.dynamicImport = true;
    if (token.value === "getURL" && isDot(tokens[i - 1]) && tokens[i + 1]?.value === "(" && tokens[i + 2]?.kind === "string") {
      const after = tokens[i + 3]?.value;
      if (after === ")" || after === ",") result.urls.push(tokens[i + 2].value);
    }
    if (token.value === "importScripts" && tokens[i + 1]?.value === "(") {
      const owner = isDot(tokens[i - 1]) ? tokens[i - 2] : undefined;
      // self.importScripts and globalThis.importScripts are the same function; someone else's importScripts isn't.
      if (!owner || (owner.kind === "name" && GLOBAL_OWNERS.has(owner.value))) {
        const urls: string[] = [];
        let j = i + 2;
        let literal = true;
        while (tokens[j] && tokens[j].value !== ")") {
          if (tokens[j].kind === "string") urls.push(tokens[j].value);
          else if (tokens[j].value !== ",") literal = false;
          j++;
        }
        result.importScripts.push({ start: (owner ?? token).start, end: tokens[j]?.end ?? token.end, ...(literal ? { urls } : {}) });
      }
    }
    if (token.value !== "chrome" && token.value !== "browser") continue;
    if (isDot(tokens[i - 1]) && !(tokens[i - 2]?.kind === "name" && GLOBAL_OWNERS.has(tokens[i - 2].value))) continue;
    const parts = ["chrome"];
    let j = i + 1;
    while (isDot(tokens[j]) && tokens[j + 1]?.kind === "name") {
      parts.push(tokens[j + 1].value);
      j += 2;
    }
    if (parts.length > 1) result.chains.push(parts.join("."));
  }
  return result;
}

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  /** For each open `${`, the brace depth its closing `}` returns to. */
  const substitutions: number[] = [];
  let braces = 0;
  let i = 0;

  const regexAllowed = () => {
    const last = tokens[tokens.length - 1];
    if (!last) return true;
    if (last.kind === "name") return BEFORE_EXPRESSION.has(last.value);
    if (last.kind === "punct") return !(last.value === ")" || last.value === "]" || last.value === "}");
    return false;
  };

  /** Reads template text from `start` up to its closing backtick or the next `${`. */
  const templatePart = (start: number) => {
    let text = "";
    let j = start;
    while (j < code.length) {
      const char = code[j];
      if (char === "\\") {
        text += code[j + 1] ?? "";
        j += 2;
      } else if (char === "`") {
        return { text, end: j + 1, open: false };
      } else if (char === "$" && code[j + 1] === "{") {
        return { text, end: j + 2, open: true };
      } else {
        text += char;
        j++;
      }
    }
    return { text, end: j, open: false };
  };

  const template = (start: number, first: boolean) => {
    const part = templatePart(start);
    if (part.open) {
      substitutions.push(braces);
      braces++;
      tokens.push({ kind: "punct", value: "${", start: 0, end: 0 });
    } else {
      // A template without substitutions is a plain string; the end of one with substitutions is just "a value".
      tokens.push(first ? { kind: "string", value: part.text, start: 0, end: 0 } : { kind: "template", value: "", start: 0, end: 0 });
    }
    return part.end;
  };

  while (i < code.length) {
    const char = code[i];
    const next = code[i + 1];
    const begin = i;
    const before = tokens.length;
    if (char === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      i = end === -1 ? code.length : end;
    } else if (char === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
    } else if (char === '"' || char === "'") {
      let value = "";
      let j = i + 1;
      while (j < code.length && code[j] !== char && code[j] !== "\n") {
        if (code[j] === "\\") {
          value += code[j + 1] ?? "";
          j += 2;
        } else {
          value += code[j];
          j++;
        }
      }
      tokens.push({ kind: "string", value, start: 0, end: 0 });
      i = j + 1;
    } else if (char === "`") {
      i = template(i + 1, true);
    } else if (char === "}" && substitutions.length > 0 && substitutions[substitutions.length - 1] === braces - 1) {
      substitutions.pop();
      braces--;
      i = template(i + 1, false);
    } else if (char === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < code.length && code[j] !== "\n") {
        const c = code[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (inClass) {
          if (c === "]") inClass = false;
        } else if (c === "[") {
          inClass = true;
        } else if (c === "/") {
          j++;
          while (j < code.length && NAME_CHAR.test(code[j])) j++;
          break;
        }
        j++;
      }
      tokens.push({ kind: "regex", value: "", start: 0, end: 0 });
      i = j;
    } else if (NAME_CHAR.test(char)) {
      let j = i + 1;
      while (j < code.length && NAME_CHAR.test(code[j])) j++;
      tokens.push({ kind: "name", value: code.slice(i, j), start: 0, end: 0 });
      i = j;
    } else if (char === "?" && next === "." && !/\d/.test(code[i + 2] ?? "")) {
      tokens.push({ kind: "punct", value: "?.", start: 0, end: 0 });
      i += 2;
    } else if (/\s/.test(char)) {
      i++;
    } else {
      if (char === "{") braces++;
      else if (char === "}") braces--;
      tokens.push({ kind: "punct", value: char, start: 0, end: 0 });
      i++;
    }
    // Where this step's tokens are in the code (a template step covers its whole text).
    for (let n = before; n < tokens.length; n++) {
      tokens[n].start = begin;
      tokens[n].end = i;
    }
  }
  return tokens;
}
```

- [ ] **Step 4: Replace `src/convert/esbuild.ts`**

```ts
// ES-module bundling for extension code (spec §3.3). The esbuild API is a parameter, so the same code runs on
// native esbuild in Node (esbuild-node.ts) and on esbuild-wasm in a browser worker (esbuild-browser.ts).
import type { Loader, Plugin } from "esbuild";
import { dirname, joinPath } from "./paths.ts";
import type { ExtensionFiles } from "./unpack.ts";

/** The part of the esbuild API used here. Native esbuild and esbuild-wasm both provide it. */
export type EsbuildApi = Pick<typeof import("esbuild"), "build" | "transform">;
export type ModuleBundle = { code: string; remoteImports: string[] };

const LOADERS: Record<string, Loader> = { js: "js", mjs: "js", cjs: "js", json: "json", css: "css" };

export type ModuleOptions = {
  /** "iife" leaves no export statements behind, so the bundle can sit inside a function (a module background). */
  format?: "esm" | "iife";
  /** esbuild's define, e.g. { "import.meta": "__x2uImportMeta" }. */
  define?: Record<string, string>;
};

/** Bundles an ES-module entry from the extension's files into one string. Remote imports stay external and are listed. */
export async function bundleModule(esbuild: EsbuildApi, files: ExtensionFiles, entry: string, options: ModuleOptions = {}): Promise<ModuleBundle> {
  const remoteImports: string[] = [];
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: options.format ?? "esm",
    platform: "browser",
    target: "es2020",
    write: false,
    logLevel: "silent",
    ...(options.define ? { define: options.define } : {}),
    plugins: [extensionFiles(files, remoteImports)],
  });
  return { code: result.outputFiles[0].text, remoteImports };
}

function extensionFiles(files: ExtensionFiles, remoteImports: string[]): Plugin {
  return {
    name: "x2u-extension-files",
    setup(build) {
      build.onResolve({ filter: /^https?:\/\// }, (args) => {
        remoteImports.push(args.path);
        return { path: args.path, external: true };
      });
      build.onResolve({ filter: /.*/ }, (args) => {
        const base = args.path.startsWith("/") || !args.importer ? "" : dirname(args.importer);
        const path = joinPath(base, args.path);
        if (!files.has(path)) return { errors: [{ text: `${args.path} (imported from ${args.importer || "the manifest"}) is not in the extension` }] };
        return { path, namespace: "x2u" };
      });
      build.onLoad({ filter: /.*/, namespace: "x2u" }, (args) => ({
        contents: files.get(args.path),
        loader: LOADERS[args.path.slice(args.path.lastIndexOf(".") + 1)] ?? "js",
      }));
    },
  };
}
```

- [ ] **Step 5: Replace `src/convert/bundle.ts`**

```ts
// Extension code as the userscript runs it (spec §3.3).
// - Content scripts and classic backgrounds: files concatenated as text in manifest or page order, as a browser runs
//   classic scripts in one shared scope. Nothing is renamed or hoisted.
// - A classic service worker's importScripts("a.js", ...) with string literals is replaced by the files' contents.
// - ES modules (a module service worker, <script type="module"> in a background page) are bundled by esbuild into an
//   IIFE, with import.meta standing for an object the runtime passes in.
// emit.ts wraps the results.
import type { World } from "../runtime/config.ts";
import { bundleModule, type EsbuildApi } from "./esbuild.ts";
import { decodeText } from "./files.ts";
import type { Model } from "./manifest.ts";
import { dirname, joinPath } from "./paths.ts";
import { scan } from "./scan.ts";
import type { ExtensionFiles } from "./unpack.ts";

export type ContentCode = { world: World; code: string } | null;

/** The background's code, whether it is a service worker (no window or document), and its entry file. */
export type BackgroundBundle = { code: string; worker: boolean; entry: string };

/** One entry per content group: its concatenated JS, or null when it has none (a CSS-only group). */
export function bundleContent(model: Model, files: ExtensionFiles): { code: ContentCode[]; warnings: string[] } {
  const warnings: string[] = [];
  const code = model.contentScripts.map((group, i): ContentCode => {
    const parts = group.js.flatMap((path) => {
      const bytes = files.get(path);
      if (bytes) return [decodeText(bytes)];
      warnings.push(`content_scripts[${i}].js: ${path} isn't in the extension, so it was left out`);
      return [];
    });
    // A newline after each file ends a trailing // comment; the semicolon ends a statement left open (no ASI across files).
    return parts.length === 0 ? null : { world: group.world, code: parts.join("\n;\n") };
  });
  return { code, warnings };
}

const SCRIPT_TAG = /<script\b([^>]*)>/gi;
const attribute = (attributes: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attributes)?.slice(1).find((value) => value !== undefined);

export type BackgroundResult = {
  background: BackgroundBundle | null;
  warnings: string[];
  /** importScripts(...) calls whose arguments weren't all string literals, so they couldn't be inlined. */
  dynamicImportScripts: boolean;
  remoteImports: string[];
};

export async function bundleBackground(model: Model, files: ExtensionFiles, esbuild?: EsbuildApi): Promise<BackgroundResult> {
  const warnings: string[] = [];
  const remoteImports: string[] = [];
  let dynamicImportScripts = false;
  const text = (path: string, from: string) => {
    const bytes = files.get(path);
    if (bytes) return decodeText(bytes);
    warnings.push(`${from}: ${path} isn't in the extension, so it was left out`);
    return "";
  };
  const module = async (entry: string) => {
    if (!esbuild) throw new Error("convert: this extension's background is an ES module, which needs the esbuild option");
    const bundle = await bundleModule(esbuild, files, entry, { format: "iife", define: { "import.meta": "__x2uImportMeta" } });
    remoteImports.push(...bundle.remoteImports);
    return bundle.code;
  };
  // A worker resolves importScripts URLs against its own script, whichever file makes the call.
  const inline = (path: string, base: string, stack: string[]): string => {
    let code = text(path, stack.length === 0 ? "background.service_worker" : `importScripts in ${stack[stack.length - 1]}`);
    const calls = scan(code).importScripts.sort((a, b) => b.start - a.start);
    for (const call of calls) {
      if (!call.urls) {
        dynamicImportScripts = true;
        continue;
      }
      const parts = call.urls.map((url) => {
        let target: string;
        try {
          target = joinPath(url.startsWith("/") ? "" : base, url);
        } catch {
          warnings.push(`importScripts("${url}") in ${path} points outside the extension`);
          return "";
        }
        if (stack.includes(target) || target === path) {
          warnings.push(`importScripts("${url}") in ${path} imports itself, so it was left out the second time`);
          return "";
        }
        return inline(target, base, [...stack, path]);
      });
      code = `${code.slice(0, call.start)}/* importScripts(${call.urls.map((url) => JSON.stringify(url)).join(", ")}) */\n${parts.join("\n;\n")}\n${code.slice(call.end)}`;
    }
    return code;
  };

  const background = model.background;
  let result: BackgroundBundle | null = null;
  if (background?.kind === "worker") {
    const code = background.module ? await module(background.entry) : inline(background.entry, dirname(background.entry), []);
    result = { code, worker: true, entry: background.entry };
  } else if (background?.kind === "scripts") {
    result = { code: background.files.map((path) => text(path, "background.scripts")).join("\n;\n"), worker: false, entry: background.files[0] ?? "background.js" };
  } else if (background?.kind === "page") {
    // An MV2 background page: its scripts run in page order. Its own HTML isn't created (a ceiling the report states).
    const html = text(background.html, "background.page");
    const parts: string[] = [];
    for (const match of html.matchAll(SCRIPT_TAG)) {
      const src = attribute(match[1], "src");
      if (!src) continue; // extension pages can't run inline scripts
      if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith("//")) {
        warnings.push(`background.page loads ${src}, which isn't in the extension, so it was left out`);
        continue;
      }
      const path = joinPath(src.startsWith("/") ? "" : dirname(background.html), src);
      parts.push(attribute(match[1], "type") === "module" ? await module(path) : text(path, "background.page"));
    }
    result = { code: parts.join("\n;\n"), worker: false, entry: background.html };
  }
  return { background: result, warnings, dynamicImportScripts, remoteImports };
}
```

- [ ] **Step 6: Run the tests**

Run: `npm run test:file -- test/unit/background-bundle.test.ts`, plus `test/unit/scan.test.ts`, `test/unit/esbuild.test.ts` and `test/unit/emit.test.ts`
Expected: all PASS.

- [ ] **Step 7: Type-check and commit**

Run: `npm run typecheck` (expected: exit 0), then:

```bash
git add src/convert/scan.ts src/convert/esbuild.ts src/convert/bundle.ts test/support/extension.ts test/unit/background-bundle.test.ts
git commit -m "Bundle the background: classic workers with importScripts, scripts, pages and module workers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Report background APIs

**Files:**
- Modify: `src/convert/support.ts`, `src/convert/analyze.ts` (whole files below)
- Modify: `test/unit/analyze.test.ts`, `test/unit/convert.test.ts`, `test/unit/cli.test.ts` (whole files below)
  - Content messaging is now supported, and the background is no longer "not converted yet".
  - The CLI's "unlikely" case needs another extension.
- Test: `test/unit/analyze-background.test.ts`

**Interfaces:**
- Consumes: `ScanResult` (Task 5); `BackgroundResult` (Task 5).
- Produces:
  - **`support.ts`:** `BACKGROUND_APIS` and `OUT_OF_SCOPE`. `CONTENT_APIS` now marks runtime messaging and `storage.session` supported.
  - **`analyze.ts`:** `type BackgroundScan = { scan; bundle }` and `analyze(model, scans, background?)`.

- [ ] **Step 1: Write the failing test** `test/unit/analyze-background.test.ts`

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../../src/convert/analyze.ts";
import { bundleBackground } from "../../src/convert/bundle.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import { scan } from "../../src/convert/scan.ts";
import { files } from "../support/extension.ts";

const extension = (manifest: Record<string, unknown>, extra: Record<string, string>) => {
  const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1.0", ...manifest }), ...extra });
  return { model: readManifest(all).model, files: all };
};

describe("analyze: the background", () => {
  it("reports background APIs: supported, partial, not converted yet, and never available", async () => {
    const { model, files: all } = extension({ background: { service_worker: "sw.js" } }, {
      "sw.js": "chrome.runtime.onMessage.addListener(f); chrome.tabs.query({}); chrome.tabs.create({}); chrome.alarms.create('a'); chrome.webRequest.onBeforeRequest.addListener(f); chrome.storage.local.getKeys();",
    });
    const result = await bundleBackground(model, all);
    const { entries } = analyze(model, [], { scan: scan(result.background?.code ?? ""), bundle: result });
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status, entry.reason ?? ""]), [
      ["chrome.runtime.onMessage", "supported", ""],
      ["chrome.tabs.query", "supported", ""],
      ["chrome.tabs.create", "partial", "the new tab's id is known only if the userscript runs on its page"],
      ["chrome.alarms.create", "unsupported", "isn't converted yet"],
      ["chrome.webRequest.onBeforeRequest", "unsupported", "not available in userscripts"],
      ["chrome.storage.local.getKeys", "unsupported", "not implemented yet"],
    ]);
  });

  it("flags dynamic importScripts, remote imports, a background page and persistent: true", () => {
    const { model } = extension({ manifest_version: 2, background: { page: "bg.html", persistent: true } }, { "bg.html": "" });
    const { entries } = analyze(model, [], { scan: scan(""), bundle: { dynamicImportScripts: true, remoteImports: ["https://cdn.test/m.js"] } });
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status]), [
      ["importScripts()", "partial"],
      ["import https://cdn.test/m.js", "unsupported"],
      ["manifest.background.page", "partial"],
      ["manifest.background.persistent", "partial"],
    ]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/analyze-background.test.ts`
Expected: FAIL. `analyze` ignores the background.

- [ ] **Step 3: Replace `src/convert/support.ts`**

```ts
// The API support table (spec §5.2): the single source of truth for what the runtime implements. The analyzer reads it
// for the report, and metadata.ts reads the gm methods a row needs for @grant (spec §5.1). It grows with the runtime:
// this version converts content scripts and the background's core: messaging, tabs, storage, i18n and lifecycle.
import type { GmMethod } from "../runtime/gm.ts";
import type { Context, Status } from "./report.ts";

export type Support = { status: Status; reason?: string; methods?: readonly GmMethod[] };

/** The namespaces Chrome gives content scripts. Other chrome.* names don't exist there, so the analyzer skips them. */
export const CONTENT_NAMESPACES: ReadonlySet<string> = new Set(["runtime", "storage", "i18n", "extension", "dom"]);

/** Storage areas, and the members src/runtime/storage.ts implements on them. Any other member is reported unsupported. */
export const STORAGE_AREAS: ReadonlySet<string> = new Set(["local", "sync", "session"]);
export const STORAGE_AREA_MEMBERS: ReadonlySet<string> = new Set(["get", "set", "remove", "clear", "onChanged"]);

const OLD_MESSAGING = "the MV2 extension.sendRequest messaging isn't converted";

/** Rows content scripts and the background share. */
const SHARED: Readonly<Record<string, Support>> = {
  "runtime.getURL": { status: "supported" },
  "runtime.getManifest": { status: "supported" },
  "runtime.id": { status: "supported" },
  "runtime.lastError": { status: "supported" },
  "runtime.onMessage": { status: "supported" },
  "runtime.onConnect": { status: "supported" },
  "storage.local": { status: "supported" },
  "storage.sync": { status: "supported" },
  "storage.session": { status: "supported" },
  "storage.onChanged": { status: "supported" },
  "storage.managed": { status: "unsupported", reason: "userscripts have no managed storage" },
  "i18n.getMessage": { status: "supported" },
  "i18n.getUILanguage": { status: "supported" },
  "i18n.getAcceptLanguages": { status: "supported" },
  "i18n.detectLanguage": { status: "unsupported", reason: "language detection isn't available in userscripts" },
  "extension.getURL": { status: "supported" },
  "extension.inIncognitoContext": { status: "supported" },
  "extension.sendRequest": { status: "unsupported", reason: OLD_MESSAGING },
  "extension.onRequest": { status: "unsupported", reason: OLD_MESSAGING },
};

/**
 * Content-script APIs by "<namespace>.<member>". A member not listed doesn't exist in Chrome's content scripts either,
 * so the analyzer ignores it rather than reporting code that can't run there.
 */
export const CONTENT_APIS: Readonly<Record<string, Support>> = {
  ...SHARED,
  "runtime.sendMessage": { status: "supported" },
  "runtime.connect": { status: "supported" },
  "dom.openOrClosedShadowRoot": { status: "unsupported", reason: "a userscript can't reach closed shadow roots" },
};

const NO_PAGES = "it reaches extension pages, and popups and options pages aren't converted yet";

/**
 * Background APIs by "<namespace>.<member>". Chrome gives the background every API its manifest asks for, so anything
 * not listed here is reported: unsupported, as "isn't converted yet" or, for OUT_OF_SCOPE namespaces, as unavailable.
 */
export const BACKGROUND_APIS: Readonly<Record<string, Support>> = {
  ...SHARED,
  "runtime.sendMessage": { status: "partial", reason: NO_PAGES },
  "runtime.connect": { status: "partial", reason: NO_PAGES },
  "runtime.onInstalled": { status: "supported" },
  "runtime.onStartup": { status: "supported" },
  "runtime.getPlatformInfo": { status: "supported" },
  "runtime.onSuspend": { status: "partial", reason: "never fires: the background runs while its tab is open" },
  "runtime.setUninstallURL": { status: "partial", reason: "does nothing: a userscript can't tell when it is removed" },
  "tabs.query": { status: "supported" },
  "tabs.get": { status: "supported" },
  "tabs.getCurrent": { status: "supported" },
  "tabs.sendMessage": { status: "supported" },
  "tabs.connect": { status: "supported" },
  "tabs.reload": { status: "supported" },
  "tabs.create": { status: "partial", reason: "the new tab's id is known only if the userscript runs on its page" },
  "tabs.update": { status: "partial", reason: "only url is applied" },
  "tabs.remove": { status: "partial", reason: "a tab the extension didn't open may refuse to close" },
  "tabs.onCreated": { status: "supported" },
  "tabs.onRemoved": { status: "supported" },
  "tabs.onUpdated": { status: "supported" },
  "tabs.onActivated": { status: "supported" },
  "tabs.TAB_ID_NONE": { status: "supported" },
};

/** APIs a userscript can never provide (spec §1, out of scope). */
export const OUT_OF_SCOPE: ReadonlySet<string> = new Set([
  "webRequest", "declarativeNetRequest", "proxy", "identity", "offscreen", "sidePanel", "devtools", "debugger", "tabCapture", "downloads",
]);

/** Manifest keys for browser features a userscript can't provide. The extension relies on them like on its background. */
export const UNSUPPORTED_MANIFEST_KEYS: Readonly<Record<string, { reason: string; context: Context }>> = {
  chrome_url_overrides: { reason: "a userscript can't replace browser pages", context: "background" },
  devtools_page: { reason: "a userscript can't add developer tools panels", context: "background" },
  side_panel: { reason: "a userscript can't open the side panel", context: "background" },
  sidebar_action: { reason: "a userscript can't open the sidebar", context: "background" },
  declarative_net_request: { reason: "a userscript can't block or change network requests", context: "background" },
  omnibox: { reason: "a userscript can't add address-bar keywords", context: "background" },
  commands: { reason: "keyboard shortcuts aren't converted yet", context: "background" },
};
```

- [ ] **Step 4: Replace `src/convert/analyze.ts`**

```ts
// The analyzer (spec §3.4): report entries for the chrome.* APIs the content scripts and the background use and for
// manifest features, plus the gm methods those need for @grant (spec §5.1).
import type { GmMethod } from "../runtime/gm.ts";
import type { BackgroundResult } from "./bundle.ts";
import type { Model } from "./manifest.ts";
import type { Context, ReportEntry, Status } from "./report.ts";
import type { ScanResult } from "./scan.ts";
import { BACKGROUND_APIS, CONTENT_APIS, CONTENT_NAMESPACES, OUT_OF_SCOPE, STORAGE_AREA_MEMBERS, STORAGE_AREAS, UNSUPPORTED_MANIFEST_KEYS, type Support } from "./support.ts";

/** An extension page: getURL or web_accessible_resources naming an .html or .htm file. */
const PAGE = /\.html?(?:$|[?#])/i;

/** What the analyzer knows about the background: its scanned code, and what bundling it found. */
export type BackgroundScan = { scan: ScanResult; bundle: Pick<BackgroundResult, "dynamicImportScripts" | "remoteImports"> };

/**
 * scans has one entry per content group, in manifest order: the group's scanned code, or undefined for a group without
 * JS or a MAIN-world group (code in the page's world has no chrome.* APIs, in Chrome as here).
 */
export function analyze(model: Model, scans: ReadonlyArray<ScanResult | undefined>, background?: BackgroundScan): { entries: ReportEntry[]; methods: Set<GmMethod> } {
  const entries = new Map<string, ReportEntry>();
  const methods = new Set<GmMethod>();
  const add = (subject: string, status: Status, reason: string | undefined, context: Context) => {
    const entry = entries.get(subject) ?? { subject, status, ...(reason ? { reason } : {}), contexts: [] };
    if (!entry.contexts.includes(context)) entry.contexts.push(context);
    entries.set(subject, entry);
  };
  const use = (subject: string, support: Support, context: Context) => {
    add(subject, support.status, support.reason, context);
    for (const method of support.methods ?? []) methods.add(method);
  };

  const chains = (scan: ScanResult, context: Context) => {
    for (const chain of scan.chains) {
      const [, namespace, member, areaMember] = chain.split(".");
      if (member === undefined) continue;
      if (context === "content" && !CONTENT_NAMESPACES.has(namespace)) continue;
      if (namespace === "storage" && STORAGE_AREAS.has(member) && areaMember !== undefined && !STORAGE_AREA_MEMBERS.has(areaMember)) {
        add(`chrome.storage.${member}.${areaMember}`, "unsupported", "not implemented yet", context);
        continue;
      }
      const api = `${namespace}.${member}`;
      const support = (context === "content" ? CONTENT_APIS : BACKGROUND_APIS)[api];
      if (support) use(`chrome.${api}`, support, context);
      // A member Chrome's content scripts don't have can't be relied on there; the background has every API.
      else if (context === "background") {
        add(`chrome.${api}`, "unsupported", OUT_OF_SCOPE.has(namespace) ? "not available in userscripts" : "isn't converted yet", context);
      }
    }
  };

  for (const scan of scans) {
    if (!scan) continue;
    chains(scan, "content");
    if (scan.dynamicImport) add("import()", "partial", "dynamic import() isn't bundled in content scripts", "content");
  }
  if (background) {
    chains(background.scan, "background");
    if (background.bundle.dynamicImportScripts) add("importScripts()", "partial", "importScripts with anything but string literals can't be inlined", "background");
    for (const url of background.bundle.remoteImports) add(`import ${url}`, "unsupported", "remote modules can't be bundled", "background");
  }

  // A page served from a blob: URL has no chrome object and its relative URLs break, so it is not "supported".
  const urls = [...scans.flatMap((scan) => scan?.urls ?? []), ...(background?.scan.urls ?? []), ...model.webAccessibleResources];
  const pages = [...new Set(urls.filter((path) => PAGE.test(path)))];
  if (pages.length > 0) add("extension pages", "unsupported", `extension pages (${pages.join(", ")}) aren't converted yet`, "page");

  const groups = model.contentScripts;
  if (groups.some((group) => group.runAt === "document_start")) {
    add("manifest.content_scripts.run_at", "partial", "document_start is best-effort: the script may run after the page's earliest scripts", "content");
  }
  if (groups.some((group) => group.matchAboutBlank)) {
    add("manifest.content_scripts.match_about_blank", "partial", "content scripts don't run in about:blank frames", "content");
  }
  const raw = model.raw.background as { persistent?: unknown } | undefined;
  if (model.background?.kind === "page") add("manifest.background.page", "partial", "the page's scripts run, but its HTML isn't created", "background");
  if (raw?.persistent === true) add("manifest.background.persistent", "partial", "the background starts over whenever it moves to another tab", "background");
  if (model.popup) add(`manifest.${model.popup.key}.default_popup`, "unsupported", "the popup isn't converted yet", "popup");
  if (model.options) add(`manifest.${model.options.key}`, "unsupported", "the options page isn't converted yet", "options");
  for (const [key, { reason, context }] of Object.entries(UNSUPPORTED_MANIFEST_KEYS)) {
    if (model.raw[key] !== undefined) add(`manifest.${key}`, "unsupported", reason, context);
  }
  return { entries: [...entries.values()], methods };
}
```

- [ ] **Step 5: Update the Plan 2 tests whose expectations change.** Replace `test/unit/analyze.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../../src/convert/analyze.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import { formatReport, sortEntries, verdictOf, type Report, type ReportEntry } from "../../src/convert/report.ts";
import { scan } from "../../src/convert/scan.ts";
import { files } from "../support/extension.ts";

const model = (manifest: Record<string, unknown>) =>
  readManifest(files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1.0", ...manifest }) })).model;
const group = { matches: ["https://a.test/*"], js: ["a.js"] };

describe("analyze", () => {
  it("reports each content API once, with the support table's status, and skips namespaces content scripts don't have", () => {
    const code = "chrome.storage.local.get(); chrome.storage.local.set({}); browser.runtime.sendMessage(1); chrome.tabs.query({}); chrome.runtime.getPlatformInfo();";
    const { entries } = analyze(model({ content_scripts: [group] }), [scan(code)]);
    assert.deepEqual(entries, [
      { subject: "chrome.storage.local", status: "supported", contexts: ["content"] },
      { subject: "chrome.runtime.sendMessage", status: "supported", contexts: ["content"] },
    ]);
  });

  it("reports storage-area members the runtime lacks, chrome.dom, and extension pages, instead of claiming them", () => {
    const code = "chrome.storage.local.getBytesInUse(); chrome.storage.sync.QUOTA_BYTES; chrome.storage.local.get(); chrome.dom.openOrClosedShadowRoot(el); chrome.runtime.getURL('panel.html');";
    const { entries } = analyze(model({ content_scripts: [group], web_accessible_resources: ["frame.htm", "img/*"] }), [scan(code)]);
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status, entry.contexts]), [
      ["chrome.storage.local.getBytesInUse", "unsupported", ["content"]],
      ["chrome.storage.sync.QUOTA_BYTES", "unsupported", ["content"]],
      ["chrome.storage.local", "supported", ["content"]],
      ["chrome.dom.openOrClosedShadowRoot", "unsupported", ["content"]],
      ["chrome.runtime.getURL", "supported", ["content"]],
      ["extension pages", "unsupported", ["page"]],
    ]);
    assert.equal(entries[5].reason, "extension pages (panel.html, frame.htm) aren't converted yet");
  });

  it("flags document_start, about:blank frames and dynamic import()", () => {
    const { entries } = analyze(model({ content_scripts: [{ ...group, run_at: "document_start", match_about_blank: true }] }), [scan("import('./x.js')")]);
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status]), [
      ["import()", "partial"],
      ["manifest.content_scripts.run_at", "partial"],
      ["manifest.content_scripts.match_about_blank", "partial"],
    ]);
  });

  it("reports the pages and manifest features this version doesn't convert", () => {
    const { entries } = analyze(
      model({ background: { service_worker: "sw.js" }, action: { default_popup: "p.html" }, options_ui: { page: "o.html" }, chrome_url_overrides: { newtab: "n.html" }, commands: {} }),
      [],
    );
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status, entry.contexts]), [
      ["manifest.action.default_popup", "unsupported", ["popup"]],
      ["manifest.options_ui", "unsupported", ["options"]],
      ["manifest.chrome_url_overrides", "unsupported", ["background"]],
      ["manifest.commands", "unsupported", ["background"]],
    ]);
  });

  it("skips groups without a scan (no JS, or the MAIN world)", () => {
    assert.deepEqual(analyze(model({ content_scripts: [group, group] }), [undefined, undefined]).entries, []);
  });
});

describe("verdictOf", () => {
  const entry = (status: ReportEntry["status"], context: ReportEntry["contexts"][number]): ReportEntry => ({ subject: "x", status, contexts: [context] });

  it("is unlikely when something unsupported sits in the background or content scripts", () => {
    assert.equal(verdictOf([entry("unsupported", "content")]), "unlikely");
    assert.equal(verdictOf([entry("unsupported", "background")]), "unlikely");
  });

  it("is partial for partial entries, or unsupported ones elsewhere", () => {
    assert.equal(verdictOf([entry("partial", "content")]), "partial");
    assert.equal(verdictOf([entry("unsupported", "popup")]), "partial");
  });

  it("is likely-works otherwise", () => assert.equal(verdictOf([entry("supported", "content")]), "likely-works"));
});

describe("formatReport", () => {
  it("drops control characters, so an extension's name can't rewrite the terminal", () => {
    const report: Report = {
      extension: { name: "Evil\u001b[1A\u001b[2K\rExt likely-works", version: "1\u0007", manifestVersion: 3 },
      verdict: "unlikely",
      entries: [{ subject: "x\u009b2J", status: "unsupported", reason: "r\u0000", contexts: ["content"] }],
      warnings: ["w\nnext"],
    };
    const text = formatReport(report);
    assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    assert.equal(text.split("\n")[0], "Evil[1A[2KExt likely-works 1 (manifest v3): unlikely");
    assert.deepEqual(text.split("\n").slice(-2), ["Warnings:", "  - wnext"]);
  });

  it("prints the verdict, then entries worst first in aligned columns, then warnings", () => {
    const report: Report = {
      extension: { name: "Ext", version: "1.0", manifestVersion: 3 },
      verdict: "unlikely",
      entries: sortEntries([
        { subject: "chrome.storage.local", status: "supported", contexts: ["content"] },
        { subject: "manifest.background", status: "unsupported", reason: "background scripts aren't converted yet", contexts: ["background"] },
        { subject: "chrome.storage.session", status: "partial", reason: "kept across browser restarts", contexts: ["content"] },
      ]),
      warnings: ["style.css refers to a.png, which isn't in the extension"],
    };
    assert.equal(
      formatReport(report),
      [
        "Ext 1.0 (manifest v3): unlikely",
        "  unsupported  manifest.background     background  background scripts aren't converted yet",
        "  partial      chrome.storage.session  content     kept across browser restarts",
        "  supported    chrome.storage.local    content",
        "Warnings:",
        "  - style.css refers to a.png, which isn't in the extension",
      ].join("\n"),
    );
  });
});
```

`test/unit/convert.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { convert, inspect } from "../../src/convert/index.ts";
import { plainExtension, sampleExtension } from "../support/extension.ts";

const origin = "http://127.0.0.1:4567";
/** A stand-in for the built runtime: convert() only embeds it. */
const runtime = "var __x2uRuntime = { start() {} };";

describe("convert", () => {
  it("writes the header, the runtime and the content groups", async () => {
    const { userscript } = await convert(sampleExtension(origin), { runtime });
    const header = userscript.slice(0, userscript.indexOf("// ==/UserScript==") + "// ==/UserScript==".length);
    assert.match(header, /^\/\/ ==UserScript==\n\/\/ @name {9}Sample Extension\n/);
    assert.match(header, /\n\/\/ @match {8}http:\/\/127\.0\.0\.1:4567\/\*\n/);
    assert.match(header, /\n\/\/ @run-at {7}document-start\n/);
    assert.doesNotMatch(header, /@noframes/); // one group has all_frames
    assert.doesNotMatch(header, /@exclude-match/); // only one group excludes it
    assert.match(userscript, /__x2uRuntime\.start\(/);
    assert.match(userscript, /function \(chrome, browser\) \{\nreturn function \(\) \{\nif \(!globalThis\.chrome/);
    assert.match(userscript, /"document\.documentElement\.dataset\.main = String\(window\.pageValue\);"/); // the MAIN group, as text
    assert.doesNotThrow(() => new Function(userscript), "the userscript parses");
  });

  it("puts referenced files and web_accessible_resources in the asset table, and nothing else", async () => {
    const { userscript } = await convert(sampleExtension(origin), { runtime });
    const config = JSON.parse(/__x2uRuntime\.start\((\{.*?\}), \[\n/s.exec(userscript)?.[1] ?? "{}");
    assert.deepEqual(Object.keys(config.assets), ["data/info.json", "img/dot.png", "inject.js"]);
    assert.equal(config.assets["img/dot.png"][0], "image/png");
    assert.deepEqual(config.groups[0].css, ['.x2u-box { color: rgb(1, 2, 3); background-image: url("x2u-asset:img%2Fdot.png"); }']);
    assert.deepEqual(Object.keys(config.locales).sort(), ["en", "fr"]);
  });

  it("leaves --ignore-assets files out", async () => {
    const { userscript } = await convert(sampleExtension(origin), { runtime, ignoreAssets: ["data/*", "*.png"] });
    const config = JSON.parse(/__x2uRuntime\.start\((\{.*?\}), \[\n/s.exec(userscript)?.[1] ?? "{}");
    assert.deepEqual(Object.keys(config.assets), ["inject.js"]);
    assert.deepEqual(config.groups[0].css, [".x2u-box { color: rgb(1, 2, 3); background-image: url(img/dot.png); }"], "an ignored file's url() stays as written");
  });

  it("minifies with esbuild and keeps the header", async () => {
    const options = { runtime, esbuild: await loadEsbuild() };
    const plain = await convert(sampleExtension(origin), options);
    const minified = await convert(sampleExtension(origin), { ...options, minify: true });
    assert.match(minified.userscript, /^\/\/ ==UserScript==[\s\S]*\/\/ ==\/UserScript==\n/);
    assert.ok(minified.userscript.length < plain.userscript.length);
    assert.doesNotThrow(() => new Function(minified.userscript));
  });

  it("uses the store's ID, else one derived from the manifest key, else the gecko ID, for chrome.runtime.id", async () => {
    const withId = await convert(plainExtension(), { runtime, extensionId: "abcdefghijklmnopabcdefghijklmnop" });
    assert.equal(withId.report.extension.id, "abcdefghijklmnopabcdefghijklmnop");
    const derived = (await convert(plainExtension(), { runtime })).report.extension.id;
    assert.match(derived ?? "", /^[a-p]{32}$/);
    assert.equal((await convert(plainExtension(), { runtime })).report.extension.id, derived, "the same input gives the same ID");
  });
});

describe("inspect", () => {
  it("reports the sample as partial, naming what it uses", async () => {
    const report = await inspect(sampleExtension(origin));
    assert.equal(report.verdict, "partial");
    assert.deepEqual(report.extension, { name: "Sample Extension", version: "1.2.3", manifestVersion: 3, id: report.extension.id });
    assert.deepEqual(report.entries.map((entry) => [entry.subject, entry.status, entry.contexts.join("+")]), [
      ["manifest.content_scripts.run_at", "partial", "content"],
      ["chrome.i18n.getMessage", "supported", "content"],
      ["chrome.runtime.getURL", "supported", "content"],
      ["chrome.runtime.id", "supported", "content"],
      ["chrome.runtime.sendMessage", "supported", "content"],
      ["chrome.storage.local", "supported", "content"],
      ["chrome.storage.onChanged", "supported", "content"],
    ]);
    assert.deepEqual(report.warnings, []);
  });

  it("reports a plain content-script extension as likely-works", async () => {
    assert.equal((await inspect(plainExtension())).verdict, "likely-works");
  });
});
```

`test/unit/cli.test.ts`:

```ts
// The CLI as a user runs it: a child process, in a temporary directory.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plainExtension, sampleExtension, zipFiles } from "../support/extension.ts";
import { startServer, type Server } from "../support/server.ts";

const CLI = join(import.meta.dirname, "../../src/cli.ts");

function run(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", CLI, ...args], { cwd }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe("ext2userscript CLI", () => {
  let cwd: string;
  let server: Server;
  const sampleZip = zipFiles(sampleExtension("https://example.com"));

  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), "x2u-cli-"));
    await mkdir(join(cwd, "plain"));
    for (const [path, bytes] of plainExtension()) await writeFile(join(cwd, "plain", path), bytes);
    await writeFile(join(cwd, "sample.zip"), sampleZip);
    // Replaces the new-tab page, which a userscript can't do: the verdict is unlikely.
    await mkdir(join(cwd, "newtab"));
    await writeFile(join(cwd, "newtab", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "New Tab", version: "1.0", chrome_url_overrides: { newtab: "tab.html" } }));
    server = await startServer({ "/sample.zip": () => new Response(sampleZip) });
  });

  after(() => server.close());

  it("converts a directory, exits 0 and prints the report", async () => {
    const result = await run(cwd, "convert", "plain");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Wrote plain-extension\.user\.js/);
    assert.match(result.stdout, /Plain Extension 0\.1\.0 \(manifest v3\): likely-works/);
    assert.match(await readFile(join(cwd, "plain-extension.user.js"), "utf8"), /^\/\/ ==UserScript==/);
  });

  it("refuses to overwrite without --force", async () => {
    await run(cwd, "convert", "plain", "-o", "again.user.js");
    const refused = await run(cwd, "convert", "plain", "-o", "again.user.js");
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /again\.user\.js already exists \(use --force to overwrite it\)/);
    assert.equal((await run(cwd, "convert", "plain", "-o", "again.user.js", "--force")).code, 0);
  });

  it("exits 2 when the verdict is unlikely, and writes the JSON report", async () => {
    const result = await run(cwd, "convert", "newtab", "-o", "newtab.user.js", "--report", "newtab.json");
    assert.equal(result.code, 2, result.stderr);
    const report = JSON.parse(await readFile(join(cwd, "newtab.json"), "utf8"));
    assert.equal(report.verdict, "unlikely");
    assert.ok(report.entries.some((entry: { subject: string }) => entry.subject === "manifest.chrome_url_overrides"));
  });

  it("reports without writing a userscript", async () => {
    const result = await run(cwd, "report", "plain");
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Wrote/);
  });

  it("converts from a URL and downloads an archive as it is", async () => {
    const converted = await run(cwd, "convert", `${server.origin}/sample.zip`, "-o", "from-url.user.js");
    assert.equal(converted.code, 0, converted.stderr);
    const named = await run(cwd, "download", `${server.origin}/sample.zip`);
    assert.equal(named.code, 1, "sample.zip is already there");
    const downloaded = await run(cwd, "download", `${server.origin}/sample.zip`, "-o", "downloaded.zip");
    assert.equal(downloaded.code, 0, downloaded.stderr);
    assert.deepEqual(new Uint8Array(await readFile(join(cwd, "downloaded.zip"))), sampleZip);
  });

  it("says what it downloads before it does, and nothing for local sources", async () => {
    const remote = await run(cwd, "report", `${server.origin}/sample.zip`);
    assert.equal(remote.stderr, `Downloading ${server.origin}/sample.zip\n`);
    const local = await run(cwd, "report", "plain");
    assert.equal(local.stderr, "");
  });

  it("drops control characters from error messages that quote the archive", async () => {
    await writeFile(join(cwd, "evil.zip"), zipFiles(new Map([["manifest.json", new Uint8Array()], ["a\u001b[2K.js", new Uint8Array()], ["./a\u001b[2K.js", new Uint8Array()]])));
    const result = await run(cwd, "report", "evil.zip");
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "ext2userscript: Ambiguous archive: a[2K.js appears more than once\n");
  });

  it("explains a bad command line or a missing source", async () => {
    const usage = await run(cwd, "explode", "x");
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /Usage:/);
    const unknown = await run(cwd, "convert", "plain", "--bogus");
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Unknown option '--bogus'/);
    const missing = await run(cwd, "convert", "missing/ext.zip");
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No such file or directory: missing\/ext\.zip/);
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `npm run test:file -- test/unit/analyze-background.test.ts`, then the same for `test/unit/analyze.test.ts`, `test/unit/convert.test.ts` and `test/unit/cli.test.ts`
Expected: all PASS.

- [ ] **Step 7: Type-check and commit**

Run: `npm run typecheck` (expected: exit 0), then:

```bash
git add src/convert/support.ts src/convert/analyze.ts test/unit/analyze-background.test.ts test/unit/analyze.test.ts test/unit/convert.test.ts test/unit/cli.test.ts
git commit -m "Report the background's APIs, and content messaging as supported" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Emit and convert the background

**Files:**
- Modify:
  - `src/runtime/config.ts` (whole file below): `background` in the config and the `BackgroundCode` type;
  - `src/convert/emit.ts` and `src/convert/index.ts` (whole files below);
  - `src/cli.ts`: `report` passes esbuild (edit below).
- Test: `test/unit/emit-background.test.ts`

**Interfaces:**
- Consumes: `bundleBackground` (Task 5); `analyze` with a background (Task 6).
- Produces:
  - `RuntimeConfig.background?: { worker; entry }` and `type BackgroundCode`;
  - `emit(header, runtime, config, code, background?)`, whose userscript calls `__x2uRuntime.start(config, groups, background)`;
  - `InspectOptions` keeps `esbuild`, which a module background needs.

- [ ] **Step 1: Write the failing test** `test/unit/emit-background.test.ts`

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../../src/convert/emit.ts";
import { convert } from "../../src/convert/index.ts";
import type { BackgroundCode, RuntimeConfig } from "../../src/runtime/config.ts";
import { backgroundExtension } from "../support/extension.ts";

describe("emit and convert: the background", () => {
  it("passes the background as a factory whose parameters shadow the background's globals", () => {
    const config = { name: "E", ns: "e", id: "i", manifest: {}, groups: [], assets: {}, locales: {} } satisfies RuntimeConfig;
    const userscript = emit("// h", "var __x2uRuntime = { start: (c, g, b) => __got(b) };", config, [], { code: "globalThis.__seen = [typeof window, self.tag, __x2uImportMeta.url];", worker: true, entry: "sw.js" });
    let factory: BackgroundCode | undefined;
    new Function("__got", userscript)((b: BackgroundCode) => (factory = b));
    // Inside the factory, globalThis is the parameter: the background's global object.
    const backgroundGlobal: { __seen?: unknown[] } = {};
    factory?.({}, {}, { tag: "shim" }, backgroundGlobal, undefined, undefined, () => {}, {}, { url: "u" })();
    assert.deepEqual(backgroundGlobal.__seen, ["undefined", "shim", "u"]);
  });

  it("puts the background's kind and entry in the config", async () => {
    const { userscript } = await convert(backgroundExtension("http://127.0.0.1:4567"), { runtime: "var __x2uRuntime = { start() {} };" });
    const config = JSON.parse(/__x2uRuntime\.start\((\{.*?\}), \[\n/s.exec(userscript)?.[1] ?? "{}");
    assert.deepEqual(config.background, { worker: true, entry: "sw.js" });
    assert.match(userscript, /function \(chrome, browser, self, globalThis, window, document, importScripts, localStorage, __x2uImportMeta\) \{\nreturn function \(\) \{\nimportScripts|\/\* importScripts\("lib\/helper\.js"\) \*\//);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/emit-background.test.ts`
Expected: FAIL. `emit` takes no background.

- [ ] **Step 3: Replace `src/runtime/config.ts`, `src/convert/emit.ts` and `src/convert/index.ts`**

```ts
// Types shared by the converter (src/convert) and the runtime it embeds in every userscript (src/runtime).

export type RunAt = "document_start" | "document_end" | "document_idle";
export type World = "ISOLATED" | "MAIN";

export type Message = { message: string; placeholders?: Record<string, { content: string }> };
/** One locale's messages.json. Message and placeholder names are lower-cased, because Chrome ignores their case. */
export type Messages = Record<string, Message>;

/** Which URLs a content-script group runs on (Chrome's matches, exclude_matches, include_globs, exclude_globs). */
export type UrlFilter = { matches: string[]; excludeMatches: string[]; includeGlobs: string[]; excludeGlobs: string[] };

export type GroupConfig = UrlFilter & {
  runAt: RunAt;
  allFrames: boolean;
  world: World;
  /** The group's CSS files, in order, with asset URLs replaced by placeholders (see src/runtime/assets.ts). */
  css: string[];
};

/** Extension files the runtime can hand out as blob: URLs, by path: [MIME type, base64 bytes]. */
export type AssetTable = Record<string, [mime: string, base64: string]>;

export type RuntimeConfig = {
  /** The extension's name, for log prefixes. */
  name: string;
  /** Namespace for GM value keys (x2u:<ns>:…). */
  ns: string;
  /** chrome.runtime.id. */
  id: string;
  /** manifest.json as parsed, for chrome.runtime.getManifest(). */
  manifest: unknown;
  groups: GroupConfig[];
  assets: AssetTable;
  /** Every locale's messages, keyed by the _locales folder name. */
  locales: Record<string, Messages>;
  defaultLocale?: string;
  /** Set by --locale: i18n uses this locale instead of the browser's languages. */
  locale?: string;
  /** The background, if the extension has one: whether it is a service worker, and its entry file (for import.meta.url). */
  background?: { worker: boolean; entry: string };
};

/**
 * The background's code as a factory, called once on the leader tab. Its parameters shadow the globals a background
 * reaches (spec §3.3); __x2uImportMeta stands in for import.meta in a module background.
 */
export type BackgroundCode = (
  chrome: unknown,
  browser: unknown,
  self: unknown,
  globalThis: unknown,
  window: unknown,
  document: unknown,
  importScripts: unknown,
  localStorage: unknown,
  __x2uImportMeta: { url: string },
) => () => void;

/**
 * One entry per content group, in manifest order: isolated-world code as a factory that takes the chrome and browser
 * objects and returns the code to run, MAIN-world code as source text, or null for a group without JS.
 */
export type GroupCode = ((chrome: unknown, browser: unknown) => () => void) | string | null;
```

```ts
// Final assembly (spec §3, §5): the header, then one function holding the runtime and a start() call with the config,
// each content group's code and the background's code.
// - Isolated-world code becomes a factory: function (chrome, browser) { return function () { <code> }; }. The outer
//   parameters give the code its chrome and browser, and the inner function is a scope of its own, so the code may
//   still declare `const browser = …` itself.
// - MAIN-world code stays text: the runtime puts it in the page with gm.addElement.
// - The background is a factory too, whose parameters shadow the globals a background reaches (spec §3.3).
import type { RuntimeConfig } from "../runtime/config.ts";
import type { BackgroundBundle, ContentCode } from "./bundle.ts";

export function emit(header: string, runtime: string, config: RuntimeConfig, code: readonly ContentCode[], background: BackgroundBundle | null = null): string {
  const groups = code.map((group) => {
    if (group === null) return "null";
    if (group.world === "MAIN") return JSON.stringify(group.code);
    return `function (chrome, browser) {\nreturn function () {\n${group.code}\n};\n}`;
  });
  const backgroundFactory = background
    ? `function (chrome, browser, self, globalThis, window, document, importScripts, localStorage, __x2uImportMeta) {\nreturn function () {\n${background.code}\n};\n}`
    : "null";
  return `${header}\n\n(function () {\n${runtime}\n__x2uRuntime.start(${JSON.stringify(config)}, [\n${groups.join(",\n")}\n], ${backgroundFactory});\n})();\n`;
}
```

```ts
// The conversion core (spec §3): convert(files, options) → { userscript, report }. Pure apart from esbuild (used for
// module backgrounds and --minify), and the same in the CLI and the web app. inspect() builds the report without the
// userscript.
import type { RuntimeConfig } from "../runtime/config.ts";
import { grantsFor } from "../runtime/gm.ts";
import { analyze } from "./analyze.ts";
import { collectAssets } from "./assets.ts";
import { bundleBackground, bundleContent, type BackgroundBundle, type ContentCode } from "./bundle.ts";
import { emit } from "./emit.ts";
import type { EsbuildApi } from "./esbuild.ts";
import { readManifest } from "./manifest.ts";
import { namespaceOf, renderMetadata } from "./metadata.ts";
import { sortEntries, verdictOf, type Report } from "./report.ts";
import { scan } from "./scan.ts";
import type { ExtensionFiles } from "./unpack.ts";

export type ConvertOptions = {
  /** The built runtime (src/convert/runtime-node.ts builds it in Node). */
  runtime: string;
  /** Needed for an ES-module background and for minify. */
  esbuild?: EsbuildApi;
  /** --locale: the locale for the header and for chrome.i18n. */
  locale?: string;
  minify?: boolean;
  /** --ignore-assets: path globs to leave out of the asset table. */
  ignoreAssets?: readonly string[];
  /** The store's extension ID, when the source was a store; chrome.runtime.id uses it. */
  extensionId?: string;
};

export type InspectOptions = Omit<ConvertOptions, "runtime" | "minify">;

export async function convert(files: ExtensionFiles, options: ConvertOptions): Promise<{ userscript: string; report: Report }> {
  const prepared = await prepare(files, options);
  let userscript = emit(prepared.header, options.runtime, prepared.config, prepared.code, prepared.background);
  if (options.minify) {
    if (!options.esbuild) throw new Error("convert: minify needs the esbuild option");
    const body = userscript.slice(prepared.header.length);
    userscript = `${prepared.header}\n${(await options.esbuild.transform(body, { minify: true, target: "es2020" })).code}`;
  }
  return { userscript, report: prepared.report };
}

export async function inspect(files: ExtensionFiles, options: InspectOptions = {}): Promise<Report> {
  return (await prepare(files, options)).report;
}

async function prepare(
  files: ExtensionFiles,
  options: InspectOptions,
): Promise<{ header: string; config: RuntimeConfig; code: ContentCode[]; background: BackgroundBundle | null; report: Report }> {
  const { model, warnings: manifestWarnings } = readManifest(files, { locale: options.locale });
  const { code, warnings: bundleWarnings } = bundleContent(model, files);
  const scans = code.map((group) => (group?.world === "ISOLATED" ? scan(group.code) : undefined));
  const background = await bundleBackground(model, files, options.esbuild);
  const backgroundScan = background.background ? scan(background.background.code) : undefined;
  const { entries, methods } = analyze(model, scans, backgroundScan ? { scan: backgroundScan, bundle: background } : undefined);
  const getUrls = [...scans.flatMap((result) => result?.urls ?? []), ...(backgroundScan?.urls ?? [])];
  const assets = collectAssets(model, files, getUrls, options.ignoreAssets);
  const id = options.extensionId ?? (model.key ? await chromeId(base64Bytes(model.key)) : undefined) ?? model.geckoId ?? (await chromeId(new TextEncoder().encode(model.name)));
  const ns = namespaceOf(model);
  const config: RuntimeConfig = {
    name: model.name,
    ns,
    id,
    manifest: model.raw,
    groups: model.contentScripts.map((group, i) => ({
      matches: group.matches,
      excludeMatches: group.excludeMatches,
      includeGlobs: group.includeGlobs,
      excludeGlobs: group.excludeGlobs,
      runAt: group.runAt,
      allFrames: group.allFrames,
      world: group.world,
      css: assets.css[i],
    })),
    assets: assets.table,
    locales: model.locales,
    defaultLocale: model.defaultLocale,
    locale: options.locale ? model.locale : undefined,
    ...(background.background ? { background: { worker: background.background.worker, entry: background.background.entry } } : {}),
  };
  const report: Report = {
    extension: { name: model.name, version: model.version, manifestVersion: model.manifestVersion, id },
    verdict: verdictOf(entries),
    entries: sortEntries(entries),
    warnings: [...manifestWarnings, ...bundleWarnings, ...background.warnings, ...assets.warnings],
  };
  return { header: renderMetadata(model, files, ns, grantsFor(methods)), config, code, background: background.background, report };
}

const base64Bytes = (base64: string) => Uint8Array.from(atob(base64.replace(/\s+/g, "")), (char) => char.charCodeAt(0));

/** Chrome's extension ID scheme: the first 128 bits of a SHA-256, written with the letters a–p. */
async function chromeId(seed: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", seed));
  return [...hash.subarray(0, 16)].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
}
```

- [ ] **Step 4: Let `report` bundle a module background.** In `src/cli.ts`, replace:

```ts
      report = await inspect(files, options);
```

with:

```ts
      report = await inspect(files, { ...options, esbuild: await loadEsbuild() });
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:file -- test/unit/emit-background.test.ts`, plus `test/unit/emit.test.ts`, `test/unit/convert.test.ts`, `test/unit/runtime-build.test.ts` and `test/unit/cli.test.ts`
Expected: all PASS. The Plan 2 runtime ignores start()'s third argument until Task 8.

- [ ] **Step 6: Type-check and commit**

Run: `npm run typecheck` (expected: exit 0), then:

```bash
git add src/runtime/config.ts src/convert/emit.ts src/convert/index.ts src/cli.ts test/unit/emit-background.test.ts
git commit -m "Emit the background as a factory and put it in the runtime config" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Boot the background on the leader tab

**Files:**
- Create: `src/runtime/background.ts`
- Modify:
  - `src/runtime/index.ts` (whole file below): joins the other tabs and runs the election and the background;
  - `src/runtime/content.ts` (whole file below): `withGlobals` uses `Reflect`.
- Modify:
  - `test/browser/content-runtime.test.ts` (whole file below): a background suite and a module-background suite. The content suite's no-background message now fails with Chrome's error.
  - `README.md` (usage paragraph, below).
- Test: `test/browser/content-runtime.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `startBackground(deps): Promise<{ pause(); resume() }>`;
  - `start(config, code, background?)`.

- [ ] **Step 1: Write the failing test.** Replace `test/browser/content-runtime.test.ts` with:

```ts
// Converted extensions end to end, on each backend in X2U_BACKENDS (default: the CI emulator): content scripts, and a
// background that runs on the leader tab. Release tier: X2U_BACKENDS=tm,vm with the bench profile from `npm run bench:setup`.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { backendsFromEnv, startSession, type Session } from "../../bench/session.ts";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { convert } from "../../src/convert/index.ts";
import { loadRuntime } from "../../src/convert/runtime-node.ts";
import type { ExtensionFiles } from "../../src/convert/unpack.ts";
import { readAttr, waitForAttr } from "../support/dom.ts";
import { backgroundExtension, moduleBackgroundExtension, sampleExtension } from "../support/extension.ts";
import { startServer, type Server } from "../support/server.ts";
import { sleep } from "../support/time.ts";

const html = (body: string, head = "") => () =>
  new Response(`<!doctype html><html><head><title>x2u</title>${head}</head><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
const page = html('<div class="x2u-box">box</div>', "<script>window.pageValue = 42;</script>");

/** Polls an attribute on any element (a frame's <html>, say) until it satisfies ok, for up to 10 s. */
async function attrUntil(element: Locator, name: string, ok: (value: string | null) => boolean): Promise<string | null> {
  let value = await element.getAttribute(name);
  for (let waited = 0; !ok(value) && waited < 10_000; waited += 100) {
    await sleep(100);
    value = await element.getAttribute(name);
  }
  return value;
}

/** One converted extension in one session, with the test pages served next to it. */
function harness(backend: (typeof backends)[number], extension: (origin: string) => ExtensionFiles) {
  const state: { site?: Server; session?: Session } = {};
  before(async () => {
    state.site = await startServer({
      "/page.html": page,
      "/writer.html": page,
      "/excluded.html": page,
      "/glob-yes.html": page,
      "/framed.html": html('<iframe src="/child.html"></iframe>'),
      "/child.html": html("child"),
    });
    const { userscript } = await convert(extension(state.site.origin), { runtime: await loadRuntime(), esbuild: await loadEsbuild() });
    state.session = await startSession(backend, userscript);
  });
  after(async () => {
    await state.session?.close();
    await state.site?.close();
  });
  return {
    session: () => state.session as Session,
    open: async (path: string): Promise<Page> => {
      const tab = await (state.session as Session).context.newPage();
      await tab.goto(`${(state.site as Server).origin}${path}`);
      return tab;
    },
  };
}

const backends = backendsFromEnv();
for (const backend of backends) {
  describe(`converted content scripts on ${backend}`, () => {
    const { open } = harness(backend, sampleExtension);

    it("runs isolated, MAIN-world and document_start groups with their chrome APIs, despite a failing group", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-content", "lib"); // lib.js passed webextension-polyfill's globalThis.chrome check
      assert.equal(await readAttr(tab, "data-greeting"), "Hello x2u");
      await waitForAttr(tab, "data-stored", "1");
      await waitForAttr(tab, "data-info", "sample");
      await waitForAttr(tab, "data-main", "42");
      assert.match((await readAttr(tab, "data-start")) ?? "", /^(loading|interactive|complete)$/);
      assert.equal(await readAttr(tab, "data-glob"), null);
      // This extension has no background, so a message to it fails at once, as in Chrome.
      await waitForAttr(tab, "data-send-error", "Could not establish connection. Receiving end does not exist.");
    });

    it("applies the group's CSS, with its images as blob URLs", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-content", "lib");
      const style = await tab.locator(".x2u-box").evaluate((box) => ({ color: getComputedStyle(box).color, image: getComputedStyle(box).backgroundImage }));
      assert.equal(style.color, "rgb(1, 2, 3)");
      assert.match(style.image, /^url\("blob:/);
    });

    it("runs a <script src=runtime.getURL(...)> in the page's world, then fires its load event", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-inject-loaded", "1");
      assert.equal(await readAttr(tab, "data-injected"), "page");
    });

    it("honours exclude_matches, include_globs and all_frames", async () => {
      const excluded = await open("/excluded.html");
      await waitForAttr(excluded, "data-main", "42");
      assert.equal(await readAttr(excluded, "data-content"), null);

      await waitForAttr(await open("/glob-yes.html"), "data-glob", "1");

      const child = (await open("/framed.html")).frameLocator("iframe").locator("html");
      assert.equal(await attrUntil(child, "data-content", (value) => value === "lib"), "lib");
      assert.equal(await child.getAttribute("data-main"), null);
    });

    it("delivers storage.onChanged across tabs", async () => {
      const reader = await open("/page.html");
      await waitForAttr(reader, "data-stored", "1");
      await open("/writer.html");
      assert.match((await attrUntil(reader.locator("html"), "data-changed", (value) => (value ?? "").includes("fromWriter"))) ?? "", /fromWriter/);
    });
  });

  describe(`background on ${backend}`, () => {
    const { session, open } = harness(backend, backgroundExtension);

    it("answers content scripts: replies, ports, tabs.sendMessage and onInstalled", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-reply", "X2U@number");
      await waitForAttr(tab, "data-port", "42");
      await waitForAttr(tab, "data-pong", "background");
      await waitForAttr(tab, "data-installed", "install");
    });

    it("answers a frame's content scripts", async () => {
      const child = (await open("/framed.html")).frameLocator("iframe").locator("html");
      assert.equal(await attrUntil(child, "data-reply", (value) => value !== null), "X2U@number");
    });

    it("moves the background to another tab when the leader closes", async () => {
      // Every earlier tab closes, so the oldest of these two leads, then hands over when it closes.
      for (const tab of session().context.pages()) await tab.close({ runBeforeUnload: true });
      const first = await open("/page.html");
      await waitForAttr(first, "data-reply", "X2U@number");
      const second = await open("/page.html");
      await waitForAttr(second, "data-reply", "X2U@number");
      await first.close({ runBeforeUnload: true });
      const third = await open("/page.html");
      await waitForAttr(third, "data-reply", "X2U@number", 15_000);
    });
  });

  describe(`module background on ${backend}`, () => {
    const { open } = harness(backend, moduleBackgroundExtension);

    it("bundles the service worker's imports and gives it import.meta.url", async () => {
      await waitForAttr(await open("/page.html"), "data-module", "module:/bg/icon.png");
    });
  });
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/browser/content-runtime.test.ts`
Expected: FAIL in the background, module-background and no-background-message cases. The Plan 2 runtime ignores the background, and its `sendMessage` fails with "not available".

- [ ] **Step 3: Write `src/runtime/background.ts`**

```ts
// The background (spec §5.4): runs on the leader tab only, from the top, once per page. Before its code runs, the leader
// checks install and session state and loads localStorage; after, it fires the service-worker events and
// runtime.onInstalled / onStartup. A leader that steps down pauses: messages and events stop reaching the background's
// listeners (its timers keep running, a ceiling the spec accepts); if it leads again, it resumes without running the
// code a second time.
import type { Assets } from "./assets.ts";
import { createEvent, createLogger, method, readLastError, withFallback, type Logger } from "./chrome.ts";
import type { BackgroundCode, RuntimeConfig } from "./config.ts";
import type { Gm } from "./gm.ts";
import { createBackgroundGlobal } from "./global.ts";
import { keys } from "./keys.ts";
import { checkLifecycle } from "./lifecycle.ts";
import { createLocalStorage } from "./local-storage.ts";
import type { Messaging } from "./messaging.ts";
import { REGISTRY_TIMING } from "./registry.ts";

export type BackgroundDeps = {
  config: RuntimeConfig;
  code: BackgroundCode;
  gm: Gm;
  log: Logger;
  assets: Assets;
  i18n: object;
  storage: object;
  tabs: object;
  messaging: Messaging;
};

const platform = () => {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "win" : /Mac OS X/.test(ua) ? "mac" : /CrOS/.test(ua) ? "cros" : /Android/.test(ua) ? "android" : "linux";
  return { os, arch: /arm|aarch64/i.test(ua) ? "arm64" : "x86-64", nacl_arch: "x86-64" };
};

export async function startBackground(deps: BackgroundDeps): Promise<{ pause(): void; resume(): void }> {
  const { config, gm, log, assets, messaging } = deps;
  const background = config.background;
  if (!background) throw new Error("startBackground: this extension has no background");
  const lifecycle = await checkLifecycle(gm, config.ns, String((config.manifest as { version?: unknown }).version ?? ""));
  const localStorage = await createLocalStorage(gm, config.ns, log);
  let active = true;
  // While it leads, the session stamp stays fresh, so a new leader in this browser session doesn't fire onStartup.
  setInterval(() => {
    if (active) void gm.setValue(keys(config.ns).session, { t: Date.now() });
  }, REGISTRY_TIMING.heartbeatMs);

  const onInstalled = createEvent<(details: object) => void>(log);
  const onStartup = createEvent<() => void>(log);
  const onSuspend = createEvent<() => void>(log);
  const getURL = (path: string) => assets.url(path);
  const runtime = withFallback(log, "runtime", {
    id: config.id,
    get lastError() {
      return readLastError();
    },
    getURL,
    getManifest: () => structuredClone(config.manifest),
    ...messaging.runtime("background"),
    onInstalled: onInstalled.event,
    onStartup: onStartup.event,
    // The background never suspends while its tab is open.
    onSuspend: onSuspend.event,
    getPlatformInfo: method(log, async () => platform()),
    setUninstallURL: method(log, async () => {}),
  }, "all");
  const extension = withFallback(log, "extension", {
    getURL,
    inIncognitoContext: false,
    get lastError() {
      return readLastError();
    },
  }, "all");
  const known: Record<string, object> = {
    runtime,
    storage: deps.storage,
    i18n: deps.i18n,
    tabs: withFallback(log, "tabs", deps.tabs, "all"),
    extension,
  };
  // The background has every API the manifest asks for. Ones this version doesn't implement fail with a named error when
  // used, so top-level code that sets them up (chrome.alarms.create(...)) doesn't stop the rest of the background.
  const fallbacks = new Map<string, object>();
  const chrome = new Proxy(known, {
    get(target, property) {
      if (typeof property === "symbol" || property in target || property === "then" || property === "toJSON") return Reflect.get(target, property);
      let namespace = fallbacks.get(property);
      if (!namespace) fallbacks.set(property, (namespace = withFallback(log, property, {}, "all")));
      return namespace;
    },
  });
  const importScripts = () => {
    throw new Error("ext2userscript: importScripts works only with string literals, which are inlined when the extension is converted");
  };
  const { global, fire } = createBackgroundGlobal({ chrome, browser: chrome, importScripts, localStorage });
  try {
    deps.code(
      chrome,
      chrome,
      global,
      global,
      // A service worker has no window or document; code that checks for them must see that.
      background.worker ? undefined : global,
      background.worker ? undefined : document,
      importScripts,
      localStorage,
      { url: `chrome-extension://${config.id}/${background.entry}` },
    )();
  } catch (error) {
    createLogger(`${config.name} background`).error(error);
  }
  messaging.setBackgroundReady(true);
  setTimeout(() => {
    // A service worker gets install and activate when the extension is installed or updated, as in Chrome.
    if (background.worker && lifecycle.installed) {
      fire("install");
      fire("activate");
    }
    if (lifecycle.installed) onInstalled.dispatch(lifecycle.installed);
    if (lifecycle.startup) onStartup.dispatch();
  });
  return {
    pause: () => {
      active = false;
      messaging.setBackgroundReady(false);
    },
    resume: () => {
      active = true;
      messaging.setBackgroundReady(true);
    },
  };
}
```

- [ ] **Step 4: Replace `src/runtime/content.ts` and `src/runtime/index.ts`**

```ts
// Content-script boot (spec §5.5). Each group whose URL filter matches this page (and this frame) gets:
// - its CSS, injected through gm.addElement as soon as there is a document element (Chrome injects content CSS early);
// - its JS at its run_at: isolated-world code called with this extension's chrome object, MAIN-world code put in the
//   page through gm.addElement. One failing group doesn't stop the others (spec §9).
// It also makes <script src=runtime.getURL(...)> work: such a script is swapped for gm.addElement with the file's text.
import type { Assets } from "./assets.ts";
import type { Logger } from "./chrome.ts";
import type { GroupCode, RunAt, RuntimeConfig } from "./config.ts";
import type { Gm } from "./gm.ts";
import { filterMatches } from "./match.ts";

type Deps = { gm: Gm; chrome: object; assets: Assets; log: Logger };

export function runContent(config: RuntimeConfig, code: readonly GroupCode[], deps: Deps): void {
  const inFrame = window.top !== window;
  const groups = config.groups
    .map((group, index) => ({ group, index, code: code[index] }))
    .filter(({ group }) => (!inFrame || group.allFrames) && filterMatches(location.href, group));
  if (groups.length === 0) return;
  if (groups.some(({ code: c }) => typeof c === "function")) interceptAssetScripts(deps);

  const root = () => document.head ?? document.documentElement;
  whenRoot(() => {
    for (const { group } of groups) {
      for (const css of group.css) deps.gm.addElement(root(), "style", { textContent: deps.assets.css(css) }).catch((error: unknown) => deps.log.error(error));
    }
  });

  for (const { group, index, code: c } of groups) {
    if (c === null || c === undefined) continue;
    const run = () => {
      try {
        if (typeof c === "string") deps.gm.addElement(root(), "script", { textContent: c }).catch((error: unknown) => deps.log.error(error));
        else withGlobals(deps.chrome, c(deps.chrome, deps.chrome));
      } catch (error) {
        deps.log.error(`content_scripts[${index}] failed:`, error);
      }
    };
    // MAIN-world code needs an element to go into; isolated-world code at document_start runs at once, as in Chrome.
    if (group.runAt === "document_start") (typeof c === "string" ? whenRoot : (fn: () => void) => fn())(run);
    else whenParsed(group.runAt, run);
  }
}

/** document_end runs at DOMContentLoaded; document_idle runs in a task after that, so after every document_end group. */
function whenParsed(runAt: Exclude<RunAt, "document_start">, fn: () => void): void {
  const run = runAt === "document_end" ? fn : () => setTimeout(fn, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
}

/** A userscript can start before <html> exists; this waits for it. */
function whenRoot(fn: () => void): void {
  if (document.documentElement) return fn();
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    fn();
  });
  observer.observe(document, { childList: true });
}

/**
 * Runs a group's code with globalThis.chrome and globalThis.browser set to this extension's object, then restores
 * them. webextension-polyfill 0.10+ checks globalThis.chrome?.runtime?.id while it loads; code that reads those globals
 * later, from a callback, sees the originals (a ceiling).
 */
function withGlobals(chrome: object, fn: () => void): void {
  // Reflect, not delete or defineProperty: a manager's sandbox global can be a proxy that reports a change as refused
  // (Violentmonkey's delete does, while removing the property), and strict mode would turn that report into an error
  // after the group's code has already run.
  const global = globalThis as unknown as Record<string, unknown>;
  const saved = (["chrome", "browser"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(global, name)] as const);
  for (const [name, descriptor] of saved) {
    if (!descriptor || descriptor.configurable) Reflect.defineProperty(global, name, { value: chrome, configurable: true, writable: true });
  }
  try {
    fn();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor && !descriptor.configurable) continue;
      if (descriptor) Reflect.defineProperty(global, name, descriptor);
      else Reflect.deleteProperty(global, name);
    }
  }
}

/**
 * Content scripts often run code in the page with <script src=runtime.getURL("inject.js")>. A blob: URL would meet the
 * page's CSP, so when such a script is inserted, gm.addElement inserts the file's text instead, and the original
 * element gets its load event. Patched: appendChild, insertBefore, append and prepend (spec §5.5); the script goes at
 * the end of the parent whatever position was asked for.
 */
function interceptAssetScripts({ gm, assets, log }: Deps): void {
  const assetPath = (node: unknown) =>
    node instanceof HTMLScriptElement && node.src && node.type !== "module" ? assets.pathOf(node.src) : undefined;
  // A script with a src runs after the current task, never during the call that inserted it; so does this one.
  const inject = (parent: Node, script: HTMLScriptElement, path: string) =>
    setTimeout(() =>
      gm.addElement(parent, "script", { textContent: assets.text(path) ?? "" }).then(
        () => script.dispatchEvent(new Event("load")),
        (error: unknown) => {
          log.error(error);
          script.dispatchEvent(new Event("error"));
        },
      ),
    );

  const appendChild = Node.prototype.appendChild;
  Node.prototype.appendChild = function <T extends Node>(this: Node, node: T): T {
    const path = assetPath(node);
    if (path === undefined) return appendChild.call(this, node) as T;
    inject(this, node as unknown as HTMLScriptElement, path);
    return node;
  };
  const insertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, child: Node | null): T {
    const path = assetPath(node);
    if (path === undefined) return insertBefore.call(this, node, child) as T;
    inject(this, node as unknown as HTMLScriptElement, path);
    return node;
  };
  for (const name of ["append", "prepend"] as const) {
    const original = Element.prototype[name];
    Element.prototype[name] = function (this: Element, ...nodes: Array<Node | string>) {
      if (!nodes.some((node) => assetPath(node) !== undefined)) return original.apply(this, nodes);
      for (const node of nodes) {
        const path = assetPath(node);
        if (path === undefined) original.call(this, node);
        else inject(this, node as HTMLScriptElement, path);
      }
    };
  }
}
```

```ts
// The runtime's entry point (spec §5). runtime-node.ts bundles this file to an IIFE named __x2uRuntime, and every
// userscript calls __x2uRuntime.start(config, code, background) once per page.
// Content scripts start at once, so document_start stays early; joining the other tabs (registry, bus, election) is
// asynchronous, and messages sent before it finishes wait in the router.
import { createAssets } from "./assets.ts";
import { startBackground } from "./background.ts";
import { createLogger, readLastError, withFallback } from "./chrome.ts";
import type { BackgroundCode, GroupCode, RuntimeConfig } from "./config.ts";
import { runContent } from "./content.ts";
import { leaderOf, startElection } from "./elect.ts";
import { createGm } from "./gm.ts";
import { createI18n } from "./i18n.ts";
import { tabIdentity } from "./identity.ts";
import { createMessaging } from "./messaging.ts";
import { startRegistry, type Registry, type TabInfo, type TabState } from "./registry.ts";
import { startBus } from "./bus.ts";
import { createStorage } from "./storage.ts";
import { createTabs } from "./tabs.ts";

export function start(config: RuntimeConfig, code: readonly GroupCode[], background: BackgroundCode | null = null): void {
  const log = createLogger(config.name);
  try {
    const gm = createGm();
    if (!gm.caps.valueListeners) {
      log.error(`${gm.handler} isn't supported: ext2userscript supports Tampermonkey and Violentmonkey`);
      return;
    }
    const frame = window.top !== window;
    // Each namespace fakes the content-script members Chrome has and this version doesn't implement yet.
    const i18n = withFallback(log, "i18n", createI18n(config, log), ["detectLanguage"]);
    const assets = createAssets(config.assets, config.id, i18n.getMessage, log);
    const getURL = (path: string) => assets.url(path);
    const storage = createStorage(gm, config.ns, log);
    let registry: Registry | undefined;
    let tabs: ReturnType<typeof createTabs> | undefined;
    let leading = false;
    let activeAt = document.visibilityState === "visible" ? Date.now() : 0;
    const state = (): TabState => ({ url: location.href, title: document.title, frame, active: document.visibilityState === "visible", activeAt });

    const messaging = createMessaging({
      extensionId: config.id,
      log,
      leader: () => (registry ? leaderOf(registry) : undefined),
      exists: (id) => registry !== undefined && (id === registry.me || registry.live().some((tab) => tab.id === id)),
      sender: (from) =>
        from === "background"
          ? { id: config.id, url: `chrome-extension://${config.id}/${config.background?.entry ?? ""}`, origin: `chrome-extension://${config.id}` }
          : { id: config.id, url: location.href, origin: location.origin, frameId: frame ? 1 : 0, ...(tabs ? { tab: tabs.selfTab() } : {}) },
      control: async (op, args) => {
        if (!tabs) throw new Error("this tab isn't ready");
        return tabs.control(op, args);
      },
    });
    // Without a background, a message for it fails at once instead of waiting for one to start.
    if (!background) messaging.setBackgroundReady(true);

    const runtime = withFallback(log, "runtime", {
      id: config.id,
      get lastError() {
        return readLastError();
      },
      getURL,
      getManifest: () => structuredClone(config.manifest),
      ...messaging.runtime("content"),
    }, []);
    const extension = withFallback(log, "extension", {
      getURL,
      inIncognitoContext: false,
      get lastError() {
        return readLastError();
      },
    }, ["sendRequest", "onRequest"]);
    const dom = withFallback(log, "dom", {}, ["openOrClosedShadowRoot"]);
    // The namespaces Chrome gives content scripts. chrome.tabs and the rest are undefined there, as in Chrome.
    runContent(config, code, { gm, chrome: { runtime, storage, i18n, extension, dom }, assets, log });

    void (async () => {
      const me = await tabIdentity(gm, config.ns, frame);
      const joined = await startRegistry(gm, config.ns, me, state);
      registry = joined;
      const pageTabs = createTabs({ gm, registry: joined, messaging, log, dispatching: () => leading });
      tabs = pageTabs;
      const bus = await startBus(gm, config.ns, joined, messaging.handle);
      messaging.attach((to, wire) => bus.send(to, wire));
      joined.onRemoved((id) => messaging.peerGone(id));

      // This page's own changes: other tabs learn them from its heartbeat; its own background learns them here.
      let last: TabInfo = { ...joined.self(), ts: Date.now() };
      const changed = () => {
        const now: TabInfo = { ...joined.self(), ts: Date.now() };
        pageTabs.updated(now, last);
        last = now;
        void joined.touch();
      };
      addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") activeAt = Date.now();
        changed();
      });
      addEventListener("popstate", changed);
      addEventListener("hashchange", changed);
      addEventListener("pagehide", () => void joined.leave());
      addEventListener("pageshow", (event) => {
        if (event.persisted) void joined.rejoin();
      });

      if (frame || !background) return;
      let handle: { pause(): void; resume(): void } | undefined;
      let starting = false;
      startElection(joined, {
        acquire: () => {
          leading = true;
          if (handle) return handle.resume();
          if (starting) return;
          starting = true;
          startBackground({ config, code: background, gm, log, assets, i18n, storage, tabs: pageTabs.api, messaging }).then(
            (started) => {
              handle = started;
              if (!leading) started.pause();
            },
            (error: unknown) => log.error("the background couldn't start:", error),
          );
        },
        lose: () => {
          leading = false;
          handle?.pause();
        },
      });
    })().catch((error: unknown) => log.error("couldn't join the other tabs:", error));
  } catch (error) {
    log.error("couldn't start:", error);
  }
}
```

- [ ] **Step 5: Run the browser tests on the emulator**

Run: `npm run test:file -- test/browser/content-runtime.test.ts`
Expected: PASS, 9 tests. Run it 3 times.

Run: `S4_CHURN_MS=10000 npm run test:browser`
Expected: everything passes, apart from the known Firefox S3 failure on macOS 27.

- [ ] **Step 6 (controller, release tier): run it on real managers.** It needs the bench profile and one browser at a time.

Run: `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/content-runtime.test.ts`
Expected: PASS, 18 tests. The prototype got 18 of 18, three times, on Tampermonkey 5.5.1 and Violentmonkey 2.49.0. The profiles hold ghost tabs from earlier runs, which the registry sweeps.

Run: `S4_CHURN_MS=20000 X2U_BACKENDS=tm,vm npm run test:file -- test/browser/s4-crosstab.test.ts`
Expected: PASS, 4 tests: 1,050 of 1,050 messages per manager, and one leader at every check.

Afterwards, `pgrep -fl "Google Chrome for Testing"` should show nothing.

- [ ] **Step 7: Update the README's usage paragraph.** Replace:

```
Content scripts are converted today; background pages, popups and options pages come next, and the report says what
didn't convert.
```

with:

```
Content scripts and the background (service workers, background scripts and pages) are converted today, with
messaging, ports, tabs, storage and lifecycle events. Popups, options pages and the rest of the extension APIs come
next, and the report says what didn't convert.
```

- [ ] **Step 8: Run everything, then commit**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; every unit test passes (279 in the prototype).

```bash
git add src/runtime/background.ts src/runtime/index.ts src/runtime/content.ts test/browser/content-runtime.test.ts README.md
git commit -m "Run the background on the leader tab and connect it to content scripts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After Plan 3

- **Ceilings this plan accepts.** Each is noted where its code is.
  - An `importScripts(...)` call inside an unbraced `if`, or used as an expression, inlines as statements.
  - A background's top-level declarations don't land on `self`.
  - An MV2 background page's HTML isn't created.
  - The background's `localStorage` isn't shared with other tabs. Plan 4 adds listeners when popups share it.
  - `tabs.update` applies only `url`.
  - `tabs.remove` may not close a tab the extension didn't open.
  - `tabs.create` learns the new tab's id only if the userscript runs on its page.
  - A frame's `sender.tab` is the frame itself, and `tabs.sendMessage` reaches the top frame or that frame, not every frame.
  - A background message resent after its page left may run twice, if that page had started on it.
  - A leader that steps down keeps the timers its background started.
- **Plan 3b:**
  - the network shim (fetch/XHR through `gm.xmlHttpRequest` for `host_permissions`, `@connect`), including `fetch(new URL(..., import.meta.url))`;
  - alarms, context menus and `action` menu commands, `commands`, `notifications`, `scripting`/`tabs.executeScript`, `permissions`, `cookies`, `windows` and `getBackgroundPage`.
- **Plan 4:** popup and options pages, and `runtime.sendMessage`/`connect` from the background to them.
