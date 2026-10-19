// Re-pins corpus cases to the stores' current archives: their version and SHA-256 in bench/corpus.json.
// Usage: npm run bench:pin [-- --case id[,id…]]
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { archiveOf, type CorpusEntry } from "./corpus.ts";

/** The entry pinned to the store's current archive, which archiveOf downloads and caches. */
export async function pinEntry(entry: CorpusEntry, options: Parameters<typeof archiveOf>[1] = {}): Promise<CorpusEntry> {
  const archive = await archiveOf({ ...entry, sha256: "" }, options);
  return { ...entry, version: archive.version, sha256: archive.sha256 };
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const only = args.includes("--case") ? args[args.indexOf("--case") + 1]?.split(",") : undefined;
  const path = join(import.meta.dirname, "corpus.json");
  const corpus = JSON.parse(await readFile(path, "utf8")) as { cases: CorpusEntry[] };
  for (const [i, entry] of corpus.cases.entries()) {
    if (only && !only.includes(entry.id)) continue;
    const pinned = await pinEntry(entry);
    corpus.cases[i] = pinned;
    console.log(`${entry.id}: ${pinned.version}${pinned.sha256 === entry.sha256 ? " (unchanged)" : ` (was ${entry.version})`}`);
  }
  await writeFile(path, `${JSON.stringify(corpus, null, 2)}\n`);
}
