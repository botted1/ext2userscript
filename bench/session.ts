// One API over the backends a userscript can run on (spec §10.5): the CI emulator, or real Tampermonkey and
// Violentmonkey in the release tier.
import { chromium, type BrowserContext } from "playwright";
import { installEmulator, type Emulator } from "./emulator/index.ts";

export const BACKENDS = ["emulator", "tm", "vm"] as const;
export type Backend = (typeof BACKENDS)[number];
export type Session = { context: BrowserContext; emulator?: Emulator; close(): Promise<void> };

export function backendsFromEnv(): Backend[] {
  const names = (process.env.X2U_BACKENDS ?? "emulator").split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    if (!(BACKENDS as readonly string[]).includes(name)) throw new Error(`Unknown backend "${name}" in X2U_BACKENDS (expected ${BACKENDS.join(", ")})`);
  }
  return names as Backend[];
}

export async function startSession(backend: Backend, userscript: string): Promise<Session> {
  if (backend !== "emulator") throw new Error(`Backend "${backend}" is not wired up yet`);
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const emulator = await installEmulator(context, userscript);
  return { context, emulator, close: () => browser.close() };
}
