// GM value functions over a local copy of the store (spec §10.2). Shared by the browser emulator and the Node
// test hub: each page or tab reads its copy synchronously, and writes reach the others asynchronously.
import type { ValueListener } from "../../src/runtime/gm.ts";

export type ValueStore = {
  GM_getValue(key: string, fallback?: unknown): unknown;
  GM_setValue(key: string, value: unknown): void;
  GM_deleteValue(key: string): void;
  GM_listValues(): string[];
  GM_addValueChangeListener(key: string, fn: ValueListener): string;
  GM_removeValueChangeListener(id: number | string): void;
  /** Applies a change made by another page or tab. */
  applyRemote(key: string, value: unknown): void;
};

const copy = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export function createValueStore(initial: Record<string, unknown>, publish: (key: string, value: unknown) => void): ValueStore {
  const cache = new Map<string, unknown>(Object.entries(initial));
  const listeners = new Map<string, { key: string; fn: ValueListener }>();
  let nextId = 1;

  const change = (key: string, value: unknown, remote: boolean) => {
    const oldValue = cache.get(key);
    if (value === undefined) cache.delete(key);
    else cache.set(key, value);
    for (const listener of [...listeners.values()]) {
      if (listener.key === key) listener.fn(key, copy(oldValue), copy(value), remote);
    }
  };

  return {
    GM_getValue: (key, fallback) => (cache.has(key) ? copy(cache.get(key)) : fallback),
    GM_setValue: (key, value) => {
      const stored = copy(value);
      change(key, stored, false);
      publish(key, stored);
    },
    GM_deleteValue: (key) => {
      if (!cache.has(key)) return;
      change(key, undefined, false);
      publish(key, undefined);
    },
    GM_listValues: () => [...cache.keys()],
    GM_addValueChangeListener: (key, fn) => {
      const id = String(nextId++);
      listeners.set(id, { key, fn });
      return id;
    },
    GM_removeValueChangeListener: (id) => {
      listeners.delete(String(id));
    },
    applyRemote: (key, value) => change(key, copy(value), true),
  };
}
