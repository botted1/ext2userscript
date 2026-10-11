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
