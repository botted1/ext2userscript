// chrome.storage on GM values (spec §5.2): one value per key under x2u:<ns>:s:<area>:<key>, with Chrome's JSON-like
// value rules. GM value listeners are per key, so onChanged works like this:
// - once a listener is added, the tab listens to every storage key that exists, and to a doorbell key;
// - a tab that creates a key rings the doorbell, and listening tabs rescan and start listening to the new key;
// - changes that arrive in the same task are delivered as one event per area, as one set() call would be.
import { createEvent, method, withFallback, type Logger } from "./chrome.ts";
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";

const AREAS = ["local", "sync", "session"] as const;
type Area = (typeof AREAS)[number];
export type StorageChange = { oldValue?: unknown; newValue?: unknown };
type Changes = Record<string, StorageChange>;
type Query = null | undefined | string | string[] | Record<string, unknown>;

export function createStorage(gm: Gm, ns: string, log: Logger) {
  const k = keys(ns);
  const watched = new Set<string>();
  let watching: Promise<void> | undefined;
  const onChanged = createEvent<(changes: Changes, areaName: string) => void>(log, () => void watch());
  const areaChanged = Object.fromEntries(AREAS.map((area) => [area, createEvent<(changes: Changes) => void>(log, () => void watch())])) as Record<
    Area,
    ReturnType<typeof createEvent<(changes: Changes) => void>>
  >;

  const parse = (fullKey: string): { area: Area; key: string } | undefined => {
    if (!fullKey.startsWith(k.storagePrefix)) return undefined;
    const rest = fullKey.slice(k.storagePrefix.length);
    const colon = rest.indexOf(":");
    const area = rest.slice(0, colon) as Area;
    return colon > 0 && AREAS.includes(area) ? { area, key: rest.slice(colon + 1) } : undefined;
  };

  const pending = new Map<Area, Changes>();
  const queue = (area: Area, key: string, change: StorageChange) => {
    let batch = pending.get(area);
    if (!batch) {
      const fresh: Changes = {};
      batch = fresh;
      pending.set(area, fresh);
      setTimeout(() => {
        pending.delete(area);
        onChanged.dispatch(fresh, area);
        areaChanged[area].dispatch(fresh);
      });
    }
    const earlier = batch[key];
    const merged: StorageChange = {};
    const oldValue = earlier ? earlier.oldValue : change.oldValue;
    if (oldValue !== undefined) merged.oldValue = oldValue;
    if (change.newValue !== undefined) merged.newValue = change.newValue;
    batch[key] = merged;
  };

  const listen = async (fullKey: string) => {
    if (watched.has(fullKey)) return;
    watched.add(fullKey);
    await gm.addValueChangeListener(fullKey, (name, oldValue, newValue) => {
      const parsed = parse(name);
      if (parsed) queue(parsed.area, parsed.key, { oldValue, newValue });
    });
  };

  /** Starts listening to keys this tab doesn't know yet; with announce, reports each one as just created. */
  const rescan = async (announce: boolean) => {
    for (const fullKey of await gm.listValues()) {
      const parsed = parse(fullKey);
      if (!parsed || watched.has(fullKey)) continue;
      await listen(fullKey);
      if (!announce) continue;
      const value = await gm.getValue(fullKey);
      if (value !== undefined) queue(parsed.area, parsed.key, { newValue: value });
    }
  };

  const watch = () =>
    (watching ??= (async () => {
      // The doorbell listener comes first, so a key created during the first scan still gets picked up.
      await gm.addValueChangeListener(k.storageDoorbell, () => void rescan(true).catch((error: unknown) => log.error(error)));
      await rescan(false);
    })().catch((error: unknown) => log.error("storage.onChanged couldn't start:", error)));

  const area = (name: Area) => {
    const fullKey = (key: string) => k.storage(name, key);
    const prefix = k.storage(name, "");
    const all = async () => {
      const items: Record<string, unknown> = {};
      for (const key of await gm.listValues()) {
        if (!key.startsWith(prefix)) continue;
        const value = await gm.getValue(key);
        if (value !== undefined) items[key.slice(prefix.length)] = value;
      }
      return items;
    };
    return withFallback(log, `storage.${name}`, {
      get: method(log, async (query?: Query) => {
        if (query === null || query === undefined) return all();
        const names = typeof query === "string" ? [query] : Array.isArray(query) ? query : Object.keys(query);
        const defaults = typeof query === "object" && !Array.isArray(query) ? query : {};
        const items: Record<string, unknown> = {};
        for (const key of names) {
          const value = await gm.getValue(fullKey(key));
          if (value !== undefined) items[key] = value;
          else if (key in defaults) items[key] = defaults[key];
        }
        return items;
      }),
      set: method(log, async (items: Record<string, unknown>) => {
        let created = false;
        for (const [key, value] of Object.entries(items)) {
          if (value === undefined) continue; // Chrome skips undefined values
          const id = fullKey(key);
          if (watching) await listen(id); // so this tab's own onChanged hears a key it creates
          if ((await gm.getValue(id)) === undefined) created = true;
          await gm.setValue(id, typeof value === "function" ? {} : value); // Chrome stores a function as {}
        }
        if (created) await gm.setValue(k.storageDoorbell, `${Date.now()}:${Math.random()}`);
      }),
      remove: method(log, async (names: string | string[]) => {
        for (const key of typeof names === "string" ? [names] : names) await gm.deleteValue(fullKey(key));
      }),
      clear: method(log, async () => {
        for (const key of await gm.listValues()) if (key.startsWith(prefix)) await gm.deleteValue(key);
      }),
      onChanged: areaChanged[name].event,
    });
  };

  const managed = withFallback(log, "storage.managed", {});
  return withFallback(log, "storage", { local: area("local"), sync: area("sync"), session: area("session"), managed, onChanged: onChanged.event });
}
