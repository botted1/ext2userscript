// The converters the benchmark compares (spec §10.5): ext2userscript, from this checkout, and the baseline, any
// converter X2U_BASELINE names by its npm spec (name@version), run through npx as
// `<spec> convert <archive> -o <out> --no-minify --force`. Without X2U_BASELINE there is no baseline.
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

/** The baseline's npm spec, from X2U_BASELINE; undefined when there is no baseline. */
export const baselineSpec = (): string | undefined => process.env.X2U_BASELINE || undefined;

/** The version npx resolves for the baseline, for the scorecard, or "none". */
export async function baselineVersion(): Promise<string> {
  const spec = baselineSpec();
  if (!spec) return "none";
  const { stdout } = await run("npm", ["view", spec, "version"]);
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
    const spec = baselineSpec();
    if (!spec) throw new Error("no baseline: X2U_BASELINE isn't set");
    await run("npx", ["--yes", spec, "convert", archive.path, "-o", out, "--no-minify", "--force"], { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }).catch(
      (error: Error & { stderr?: string; killed?: boolean }) => {
        // The error's message is only the command: the reason is in what npx or the baseline wrote to stderr.
        const said = (error.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
        throw new Error(error.killed ? "the baseline took more than 300 s" : said || error.message);
      },
    );
    return { userscript: await readFile(out, "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
