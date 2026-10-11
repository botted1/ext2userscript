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
