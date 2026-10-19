// The reference run: a case against the original extension, loaded unpacked into Playwright's Chromium. A case the
// original fails can't judge a conversion (the site blocked the browser, or changed), so it doesn't count.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { readManifest } from "../src/convert/manifest.ts";
import { unpack } from "../src/convert/unpack.ts";
import type { Archive } from "./corpus.ts";
import type { Session } from "./session.ts";

/** The original extension in a fresh profile, or undefined for Manifest V2, which Chromium no longer loads. */
export async function startReference(archive: Archive): Promise<Session | undefined> {
  const files = unpack(archive.bytes);
  if (readManifest(files).model.manifestVersion === 2) return undefined;
  const root = await mkdtemp(join(tmpdir(), "x2u-reference-"));
  try {
    const extension = join(root, "extension");
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(extension, path)), { recursive: true });
      await writeFile(join(extension, path), bytes);
    }
    const context = await chromium.launchPersistentContext(join(root, "profile"), {
      // Only Chromium's new headless mode loads extensions.
      channel: "chromium",
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    return { context, close: () => context.close().finally(() => rm(root, { recursive: true, force: true })) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
