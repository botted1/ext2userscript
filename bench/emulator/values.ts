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

/** A listener's error must not undo or block the write, so it goes to the page's error handler from a microtask instead. */
const rethrowLater = (error: unknown): void => queueMicrotask(() => {
  throw error;
});

export function createValueStore(
  initial: Record<string, unknown>,
  publish: (key: string, value: unknown) => void,
  reportError: (error: unknown) => void = rethrowLater,
): ValueStore {
  const cache = new Map<string, unknown>(Object.entries(initial));
  const listeners = new Map<string, { key: string; fn: ValueListener }>();
  let nextId = 1;

  /**
   * Updates the copy, publishes a local write, then tells the listeners. Publishing first keeps a write that a
   * listener makes in reply behind the one that triggered it, so the other pages and the hub end on the newer value.
   */
  const change = (key: string, value: unknown, remote: boolean) => {
    const oldValue = cache.get(key);
    if (value === undefined) cache.delete(key);
    else cache.set(key, value);
    if (!remote) publish(key, value);
    for (const listener of [...listeners.values()]) {
      if (listener.key !== key) continue;
      try {
        listener.fn(key, copy(oldValue), copy(value), remote);
      } catch (error) {
        reportError(error);
      }
    }
  };

  return {
    GM_getValue: (key, fallback) => (cache.has(key) ? copy(cache.get(key)) : fallback),
    GM_setValue: (key, value) => change(key, copy(value), false),
    GM_deleteValue: (key) => {
      if (cache.has(key)) change(key, undefined, false);
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
