// The extension's localStorage (spec §3.3, §5.1), for the background and its pages: synchronous, like the real one,
// over GM values under x2u:<ns>:ls:*. Every value is read into a cache before the code that uses it starts; writes
// update the cache at once and are saved with gm.setValue. Each tab's copy follows the other tabs' writes, as storage.ts
// follows its keys: a listener per key, and a doorbell rung when a key is created.
import type { Logger } from "./chrome.ts";
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";

export async function createLocalStorage(gm: Gm, ns: string, log: Logger): Promise<Storage> {
  const k = keys(ns);
  const cache = new Map<string, string>();
  const followed = new Set<string>();
  const follow = async (fullKey: string) => {
    if (followed.has(fullKey)) return;
    followed.add(fullKey);
    const key = fullKey.slice(k.localStoragePrefix.length);
    await gm.addValueChangeListener(fullKey, (_name, _old, value, remote) => {
      if (!remote) return;
      if (typeof value === "string") cache.set(key, value);
      else cache.delete(key);
    });
    // A key this copy wrote is already in the cache, and newer there than a read could be.
    if (cache.has(key)) return;
    const value = await gm.getValue(fullKey);
    if (typeof value === "string") cache.set(key, value);
  };
  const scan = async () => {
    for (const key of await gm.listValues()) if (key.startsWith(k.localStoragePrefix)) await follow(key);
  };
  await gm.addValueChangeListener(k.localStorageDoorbell, (_name, _old, _value, remote) => {
    if (remote) scan().catch((error: unknown) => log.error("localStorage couldn't follow a new key:", error));
  });
  await scan();
  const save = (promise: Promise<unknown>) => void promise.catch((error: unknown) => log.error("localStorage couldn't be saved:", error));
  const storage = {
    get length() {
      return cache.size;
    },
    key: (index: number) => [...cache.keys()][index] ?? null,
    getItem: (key: string) => cache.get(String(key)) ?? null,
    setItem: (key: string, value: unknown) => {
      // A new key, or one created again after its removal: follow it, and ring so the other tabs follow it too, even
      // one that started while it was gone.
      const created = !cache.has(String(key));
      cache.set(String(key), String(value));
      const fullKey = k.localStorage(String(key));
      save(gm.setValue(fullKey, String(value)).then(() => (created ? Promise.all([follow(fullKey), gm.setValue(k.localStorageDoorbell, Date.now())]) : undefined)));
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
