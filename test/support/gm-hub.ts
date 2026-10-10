// In-memory GM for Node unit tests.
// - Each tab() returns one tab's raw GM functions, the same shape a manager provides, over a shared store.
// - Changes reach the other tabs after delayMs, like a manager's propagation.
// - With coalesce, a tab sees only the latest value per key in each window (the spec §5.3 overflow case).
import { createValueStore, type ValueStore } from "../../bench/emulator/values.ts";
import type { GmApi } from "../../src/runtime/gm.ts";

export type HubOptions = { delayMs?: number; coalesce?: boolean };
export type Hub = { store: Map<string, unknown>; tab(): GmApi };

export function createHub({ delayMs = 1, coalesce = false }: HubOptions = {}): Hub {
  const store = new Map<string, unknown>();
  const tabs = new Set<ValueStore>();
  const pending = new Map<ValueStore, Map<string, unknown>>();

  const deliver = (target: ValueStore, key: string, value: unknown) => {
    if (!coalesce) {
      setTimeout(() => target.applyRemote(key, value), delayMs);
      return;
    }
    let batch = pending.get(target);
    if (!batch) {
      const fresh = new Map<string, unknown>();
      batch = fresh;
      pending.set(target, fresh);
      setTimeout(() => {
        pending.delete(target);
        for (const [k, v] of fresh) target.applyRemote(k, v);
      }, delayMs);
    }
    batch.set(key, value);
  };

  return {
    store,
    tab() {
      const values: ValueStore = createValueStore(Object.fromEntries(store), (key, value) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
        for (const other of tabs) if (other !== values) deliver(other, key, value);
      });
      tabs.add(values);
      return { ...values, GM_info: { scriptHandler: "hub" } };
    },
  };
}
