// Real managers for the release tier (spec §10.5), unpacked into bench/.cache so --load-extension can load them.
import { join } from "node:path";

export type ManagerName = "tm" | "vm";

export const MANAGERS: Record<ManagerName, { label: string; cwsIds: readonly string[] }> = {
  tm: { label: "Tampermonkey", cwsIds: ["dhdgffkkebhmkfjojejmpbldmpobfkfo"] },
  // Stable listing first. The BETA listing is the fallback in case stable still ships MV2.
  vm: { label: "Violentmonkey", cwsIds: ["jinjaccalgkegednnccohejagnlnfdag", "opokoaglpekkimldnlggpoagmjegichg"] },
};

const CACHE = join(import.meta.dirname, "..", ".cache");
export const profileDir = (): string => process.env.BENCH_PROFILE ?? join(CACHE, "profile");
export const managerDir = (manager: ManagerName): string => join(CACHE, "managers", manager);
