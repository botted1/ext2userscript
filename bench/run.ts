// Runs the corpus (spec §10.4) for ext2userscript and the baseline on each backend in X2U_BACKENDS (default: the
// emulator), and writes a scorecard per backend to bench/.cache/scorecard-<backend>.md. Each browser case also runs
// once against the original extension, the reference.
// Usage: npm run bench [-- --case id[,id…]] [--gate]. --gate exits 1 unless the ship criteria are met (a release needs it).
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BrowserContext } from "playwright";
import type { Report } from "../src/convert/report.ts";
import { TOOLS, type BenchCase, type BrowserCase, type CaseResult, type Outcome, type Tool } from "./case.ts";
import { archiveOf, CACHE, loadCorpus, type Archive, type CorpusEntry } from "./corpus.ts";
import { startReference } from "./reference.ts";
import { criteria, scorecard } from "./scorecard.ts";
import { backendsFromEnv, startSession, type Backend, type Session } from "./session.ts";
import { convertWith, baselineVersion } from "./tools.ts";

const CASE_TIMEOUT_MS = 120_000;

/** An error's first line, and the next one too when the first only introduces it ("Build failed with 2 errors:"). */
const firstLine = (error: unknown) => {
  const [first = "", next] = (error instanceof Error ? error.message : String(error)).split("\n");
  return first.endsWith(":") && next ? `${first} ${next.trim()}` : first;
};

async function loadCase(id: string): Promise<BenchCase> {
  return ((await import(`./cases/${id}.ts`)) as { default: BenchCase }).default;
}

/** Serves the case's routes. The emulator's own requests go on to its routes: a route added later wins in Playwright. */
export async function serve(context: BrowserContext, bench: BrowserCase): Promise<void> {
  for (const [glob, answer] of Object.entries(bench.routes ?? {})) {
    await context.route(glob, (route) =>
      new URL(route.request().url()).pathname.startsWith("/__x2u_emu__/") ? route.fallback() : route.fulfill({ status: 200, contentType: answer.type, body: answer.body }),
    );
  }
}

/** Runs a browser case in a session, then closes it. A failure names the first error a page threw, if any. */
export async function check(bench: BrowserCase, session: Session): Promise<Outcome> {
  const errors: string[] = [];
  session.context.on("page", (page) => page.on("pageerror", (error) => errors.push(firstLine(error))));
  try {
    await serve(session.context, bench);
    const open = async (url: string) => {
      const page = await session.context.newPage();
      // The case waits for its own effect: a site's slow third-party resources mustn't hold up the load event.
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return page;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${CASE_TIMEOUT_MS / 1000} s`)), CASE_TIMEOUT_MS)));
    await Promise.race([bench.run({ open }), timeout]).finally(() => clearTimeout(timer));
    return { result: "pass" };
  } catch (error) {
    return { result: "fail", detail: firstLine(error) + (errors.length > 0 ? ` (first page error: ${errors[0]})` : "") };
  } finally {
    await session.close();
  }
}

/** One tool on one case, on one backend. */
export async function runCase(tool: Tool, entry: CorpusEntry, archive: Archive, bench: BenchCase, backend: Backend): Promise<Outcome> {
  if ("report" in bench) {
    // Only ext2userscript writes a report: the baseline has none to judge.
    if (tool !== "ext2userscript") return { result: "n/a" };
    let report: Report | undefined;
    try {
      ({ report } = await convertWith(tool, entry, archive));
    } catch (error) {
      return { result: "fail", detail: `conversion failed: ${firstLine(error)}` };
    }
    const missing = bench.report.subjects.filter((subject) => !report?.entries.some((e) => e.subject === subject && e.status === "unsupported"));
    if (report?.verdict !== bench.report.verdict) return { result: "fail", detail: `verdict is ${report?.verdict}, not ${bench.report.verdict}` };
    if (missing.length > 0) return { result: "fail", detail: `the report doesn't name ${missing.join(", ")} as unsupported` };
    return { result: "pass" };
  }
  let userscript: string;
  try {
    ({ userscript } = await convertWith(tool, entry, archive));
  } catch (error) {
    return { result: "fail", detail: `conversion failed: ${firstLine(error)}` };
  }
  let session: Session;
  try {
    session = await startSession(backend, userscript);
  } catch (error) {
    return { result: "fail", detail: `couldn't start ${backend}: ${firstLine(error)}` };
  }
  return check(bench, session);
}

/** The case against the original extension: n/a for a negative case, and for Manifest V2, which Chromium can't load. */
export async function runReference(archive: Archive, bench: BenchCase): Promise<Outcome> {
  if ("report" in bench) return { result: "n/a" };
  let session: Session | undefined;
  try {
    session = await startReference(archive);
  } catch (error) {
    return { result: "fail", detail: `couldn't load the extension: ${firstLine(error)}` };
  }
  return session ? check(bench, session) : { result: "n/a", detail: "Manifest V2" };
}

/**
 * Runs the cases on each backend, the reference once per case. A case whose archive can't be had fails everywhere,
 * its reference too, so it is inconclusive, and the run goes on.
 */
export async function runCorpus(
  backends: readonly Backend[],
  entries: readonly CorpusEntry[],
  getArchive: (entry: CorpusEntry) => Promise<Archive> = archiveOf,
): Promise<Map<Backend, CaseResult[]>> {
  const results = new Map(backends.map((backend) => [backend, [] as CaseResult[]]));
  for (const entry of entries) {
    let archive: Archive;
    try {
      archive = await getArchive(entry);
    } catch (error) {
      const failed: Outcome = { result: "fail", detail: `couldn't get the archive: ${firstLine(error)}` };
      for (const backend of backends) results.get(backend)?.push({ entry, version: entry.version, drifted: false, reference: failed, outcomes: { ext2userscript: failed, "baseline": failed } });
      console.log(`${entry.id}: ${failed.detail}`);
      continue;
    }
    const bench = await loadCase(entry.id);
    const reference = await runReference(archive, bench);
    for (const backend of backends) {
      const outcomes = {} as Record<Tool, Outcome>;
      for (const tool of TOOLS) outcomes[tool] = await runCase(tool, entry, archive, bench, backend);
      console.log(`${entry.id} (${backend}): reference ${reference.result}, ${TOOLS.map((tool) => `${tool} ${outcomes[tool].result}`).join(", ")}`);
      results.get(backend)?.push({ entry, version: archive.version, drifted: archive.drifted, reference, outcomes });
    }
  }
  return results;
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const only = args.includes("--case") ? args[args.indexOf("--case") + 1]?.split(",") : undefined;
  const commit = await promisify(execFile)("git", ["rev-parse", "--short", "HEAD"]).then(({ stdout }) => stdout.trim(), () => "(not a git checkout)");
  const baseline = await baselineVersion();
  const date = new Date().toISOString().slice(0, 10);
  let met = true;
  await mkdir(CACHE, { recursive: true });
  const entries = (await loadCorpus()).filter((entry) => !only || only.includes(entry.id));
  for (const [backend, results] of await runCorpus(backendsFromEnv(), entries)) {
    const card = scorecard(results, { backend, baseline, commit, date });
    await writeFile(join(CACHE, `scorecard-${backend}.md`), card);
    console.log(`\n${card}`);
    met &&= criteria(results).met;
  }
  // A browser whose connection dropped (a userscript too large for addInitScript does that) stays alive and would keep
  // the run from ending: exiting kills every browser Playwright launched.
  process.exit(args.includes("--gate") && !met ? 1 : 0);
}
