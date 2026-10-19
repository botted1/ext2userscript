// One API over the backends a userscript can run on (spec §10.5): the CI emulator, or real Tampermonkey and
// Violentmonkey in the release tier.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { installEmulator, type Emulator } from "./emulator/index.ts";
import { installUserscript } from "./real/install.ts";
import { launchReal } from "./real/launch.ts";
import { copyProfile, profileDir } from "./real/managers.ts";

export const BACKENDS = ["emulator", "tm", "vm"] as const;
export type Backend = (typeof BACKENDS)[number];
export type Session = { context: BrowserContext; emulator?: Emulator; close(): Promise<void> };

export function backendsFromEnv(): Backend[] {
  const names = (process.env.X2U_BACKENDS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) names.push("emulator"); // unset, empty or blank all mean the default
  for (const name of names) {
    if (!(BACKENDS as readonly string[]).includes(name)) throw new Error(`Unknown backend "${name}" in X2U_BACKENDS (expected ${BACKENDS.join(", ")})`);
  }
  return names as Backend[];
}

export async function startSession(backend: Backend, userscript: string): Promise<Session> {
  if (backend === "emulator") {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const emulator = await installEmulator(context, userscript);
      return { context, emulator, close: () => browser.close() };
    } catch (error) {
      await browser.close().catch(() => {}); // the original error matters more than a failed close
      throw error;
    }
  }
  // Each session gets its own copy of the profile, so it runs only its own userscript.
  const profile = await mkdtemp(join(tmpdir(), "x2u-profile-"));
  const removeProfile = () => rm(profile, { recursive: true, force: true });
  const { context, extensionId } = await copyProfile(profileDir(), profile)
    .then(() => launchReal(backend, profile))
    .catch(async (error: unknown) => {
      await removeProfile();
      throw error;
    });
  try {
    await installUserscript(context, extensionId, userscript);
  } catch (error) {
    await context.close().catch(() => {});
    await removeProfile();
    throw error;
  }
  return { context, close: () => context.close().finally(removeProfile) };
}
