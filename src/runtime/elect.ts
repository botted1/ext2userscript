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
