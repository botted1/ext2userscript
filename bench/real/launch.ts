// Launches the bench profile with one real manager loaded (release tier, spec §10.5). HEADED=1 shows the window.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Worker } from "playwright";
import { MANAGERS, managerDir, profileDir, type ManagerName } from "./managers.ts";

const isExtensionWorker = (worker: Worker) => worker.url().startsWith("chrome-extension://");

export async function launchReal(manager: ManagerName, profile = profileDir()): Promise<{ context: BrowserContext; extensionId: string }> {
  const dir = managerDir(manager);
  if (!existsSync(join(dir, "manifest.json"))) throw new Error(`${MANAGERS[manager].label} isn't set up: run npm run bench:setup first`);
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  try {
    // Only the manager's service worker counts: a site the profile visited earlier may have started one too.
    const worker = context.serviceWorkers().find(isExtensionWorker) ?? (await context.waitForEvent("serviceworker", { predicate: isExtensionWorker, timeout: 20_000 }));
    return { context, extensionId: new URL(worker.url()).host };
  } catch (error) {
    // Without this the browser keeps running and holds the profile, so the next launch fails too.
    await context.close().catch(() => {});
    throw new Error(`${MANAGERS[manager].label} did not start its service worker within 20s`, { cause: error });
  }
}
