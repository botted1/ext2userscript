// Background leader election (spec §5.4): the live tab that joined first leads. Every tab computes this from
// the registry, whose keys each have a single writer, so all tabs converge on the same answer.
import type { Registry } from "./registry.ts";

export type ElectionTiming = { graceMs: number };

/** A tab must be the oldest for this long before it leads, so tabs that start together can't both lead. */
export const ELECTION_TIMING: ElectionTiming = { graceMs: 300 };

export type Election = { isLeader(): boolean; stop(): void };

export function startElection(registry: Registry, on: { acquire(): void; lose(): void }, timing: ElectionTiming = ELECTION_TIMING): Election {
  let leader = false;
  let stopped = false;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const isOldest = (): boolean => {
    const me = registry.self();
    if (!me.present) return false;
    return registry.live().every((tab) => tab.since > me.since || (tab.since === me.since && tab.id > me.id));
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
