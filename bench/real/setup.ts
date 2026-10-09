// One-time, by hand (spec §10.5). Downloads Tampermonkey and Violentmonkey, opens the bench profile in a
// visible browser, and waits while you switch on "Allow User Scripts" for both. Run: npm run bench:setup
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { unpack } from "../../src/convert/unpack.ts";
import { cwsCrxUrl, fetchBytes } from "../../src/download.ts";
import { MANAGERS, managerDir, profileDir, type ManagerName } from "./managers.ts";

async function fetchManager(manager: ManagerName): Promise<string> {
  const { label, cwsIds } = MANAGERS[manager];
  for (const id of cwsIds) {
    const files = unpack(await fetchBytes(cwsCrxUrl(id)));
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as { manifest_version: number; version: string };
    if (manifest.manifest_version !== 3) {
      console.log(`${label} (${id}) is MV${manifest.manifest_version}; trying the next listing`);
      continue;
    }
    const dir = managerDir(manager);
    await rm(dir, { recursive: true, force: true });
    for (const [path, bytes] of files) {
      if (path.startsWith("_metadata/")) continue; // Chrome refuses unpacked extensions that contain _metadata
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    console.log(`${label} ${manifest.version} (${id}) → ${dir}`);
    return dir;
  }
  throw new Error(`No MV3 build of ${label} is available from the Chrome Web Store`);
}

const dirs = [await fetchManager("tm"), await fetchManager("vm")];
const context = await chromium.launchPersistentContext(profileDir(), {
  channel: "chromium",
  headless: false,
  args: [`--disable-extensions-except=${dirs.join(",")}`, `--load-extension=${dirs.join(",")}`],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("chrome://extensions/").catch(() => console.log("Open chrome://extensions/ in the browser window yourself."));
console.log(`
In the browser window that just opened:
  1. Click Details under Tampermonkey and switch on "Allow User Scripts".
  2. Do the same for Violentmonkey.
  3. Close the browser window.
Profile: ${profileDir()}`);
await new Promise<void>((resolve) => context.on("close", () => resolve()));
