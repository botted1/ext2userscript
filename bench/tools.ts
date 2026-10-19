// The two converters the benchmark compares (spec §10.5): ext2userscript, from this checkout, and the baseline, the
// npm package's latest version, run through npx as its own CLI would be.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadEsbuild } from "../src/convert/esbuild-node.ts";
import { convert } from "../src/convert/index.ts";
import type { Report } from "../src/convert/report.ts";
import { loadRuntime } from "../src/convert/runtime-node.ts";
import { unpack } from "../src/convert/unpack.ts";
import type { Tool } from "./case.ts";
import type { Archive, CorpusEntry } from "./corpus.ts";

const run = promisify(execFile);

/** The baseline's npm version; X2U_BASELINE pins another one. */
export const baselineSpec = () => process.env.X2U_BASELINE ?? "";

/** The version npx resolves for the baseline, for the scorecard. */
export async function baselineVersion(): Promise<string> {
  const { stdout } = await run("npm", ["view", baselineSpec(), "version"]);
  return stdout.trim();
}

export async function convertWith(tool: Tool, entry: CorpusEntry, archive: Archive): Promise<{ userscript: string; report?: Report }> {
  if (tool === "ext2userscript") {
    const { userscript, report } = await convert(unpack(archive.bytes), {
      runtime: await loadRuntime(),
      esbuild: await loadEsbuild(),
      // The store's ID is the extension's ID, as the CLI gives it (spec §7).
      ...(entry.store === "amo" ? {} : { extensionId: entry.extensionId }),
    });
    return { userscript, report };
  }
  const dir = await mkdtemp(join(tmpdir(), "x2u-base-"));
  try {
    const out = join(dir, `${entry.id}.user.js`);
    await run("npx", ["--yes", baselineSpec(), "convert", archive.path, "-o", out, "--no-minify", "--force"], { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    return { userscript: await readFile(out, "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
