// Real managers for the release tier (spec §10.5), unpacked into bench/.cache so --load-extension can load them.
import { cp } from "node:fs/promises";
import { basename, join } from "node:path";

export type ManagerName = "tm" | "vm";

export const MANAGERS: Record<ManagerName, { label: string; cwsIds: readonly string[] }> = {
  tm: { label: "Tampermonkey", cwsIds: ["dhdgffkkebhmkfjojejmpbldmpobfkfo"] },
  // Stable listing first. The BETA listing is the fallback in case stable still ships MV2.
  vm: { label: "Violentmonkey", cwsIds: ["jinjaccalgkegednnccohejagnlnfdag", "opokoaglpekkimldnlggpoagmjegichg"] },
};

const CACHE = join(import.meta.dirname, "..", ".cache");
export const profileDir = (): string => process.env.BENCH_PROFILE ?? join(CACHE, "profile");
export const managerDir = (manager: ManagerName): string => join(CACHE, "managers", manager);

/** What Chromium rebuilds by itself, and the locks a running browser holds: left out of a profile's copy. */
const NOT_COPIED = /^(Cache|Code Cache|GPUCache|GPUPersistentCache|GraphiteDawnCache|DawnGraphiteCache|DawnWebGPUCache|Singleton.*)$/;

/**
 * Copies a profile, for a session that must not see what earlier ones installed: a manager keeps every userscript in
 * the profile, so the bench's cases would otherwise run each other's. The copy keeps "Allow User Scripts".
 */
export async function copyProfile(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, filter: (source) => !NOT_COPIED.test(basename(source)) });
}
