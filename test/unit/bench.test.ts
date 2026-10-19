import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseResult, Outcome } from "../../bench/case.ts";
import type { BrowserContext } from "playwright";
import { archiveOf, loadCorpus, selectCases, sha256, type CorpusEntry } from "../../bench/corpus.ts";
import { pinEntry } from "../../bench/pin.ts";
import { copyProfile } from "../../bench/real/managers.ts";
import { check, runCase, runCorpus, runReference } from "../../bench/run.ts";
import { criteria, scorecard } from "../../bench/scorecard.ts";
import { files, zipFiles } from "../support/extension.ts";

const entry = (id: string, kind: CorpusEntry["kind"], extra: Partial<CorpusEntry> = {}): CorpusEntry => ({
  id, name: id, store: "cws", extensionId: "a".repeat(32), version: "1.0", sha256: "0".repeat(64), kind, ...extra,
});
const archive = (version: string) => zipFiles(files({ "manifest.json": JSON.stringify({ name: "A", version, manifest_version: 3 }) }));
const PASS: Outcome = { result: "pass" };
const FAIL: Outcome = { result: "fail", detail: "no effect" };
const NA: Outcome = { result: "n/a" };
const result = (id: string, kind: CorpusEntry["kind"], ours: Outcome, theirs: Outcome, reference: Outcome = kind === "negative" ? NA : PASS): CaseResult => ({
  entry: entry(id, kind), version: "1.0", drifted: false, reference, outcomes: { ext2userscript: ours, "baseline": theirs },
});

describe("criteria", () => {
  it("counts the cases the baseline passes, the modern cases it fails, and the negatives", () => {
    const c = criteria([
      result("l1", "legacy", PASS, PASS),
      result("l2", "legacy", FAIL, PASS),
      result("m1", "modern", PASS, FAIL),
      result("m2", "modern", FAIL, FAIL),
      result("m3", "modern", PASS, PASS),
      result("n1", "negative", PASS, NA),
    ]);
    assert.deepEqual(c, { matched: [2, 3], modern: [1, 2], negatives: [1, 1], inconclusive: [], met: false });
  });

  it("is met at 75% of the modern cases the baseline fails, and not below", () => {
    const modern = (passed: number) => [result("l", "legacy", PASS, PASS), ...Array.from({ length: 4 }, (_, i) => result(`m${i}`, "modern", i < passed ? PASS : FAIL, FAIL))];
    assert.equal(criteria(modern(3)).met, true);
    assert.equal(criteria(modern(2)).met, false);
  });

  it("isn't met when the baseline passes no case, as when it never ran", () => {
    const broken: Outcome = { result: "fail", detail: "conversion failed: npm error code ENOENT" };
    const results = [result("l1", "legacy", FAIL, broken), ...["m1", "m2", "m3", "m4"].map((id) => result(id, "modern", PASS, broken))];
    const c = criteria(results);
    assert.deepEqual([c.matched, c.modern, c.met], [[0, 0], [4, 4], false]);
    assert.match(scorecard(results, { backend: "emulator", baseline: "0.1.4", commit: "abc1234", date: "2026-10-19" }), /- \[ \] Passes every case the baseline passes: none to count/);
  });

  it("leaves out a case the original extension fails, and isn't met while one is inconclusive", () => {
    const c = criteria([result("l1", "legacy", FAIL, PASS, FAIL), result("m1", "modern", PASS, FAIL)]);
    assert.deepEqual(c.matched, [0, 0]);
    assert.deepEqual(c.inconclusive, ["l1"]);
    assert.equal(c.met, false);
  });
});

describe("scorecard", () => {
  it("shows each case's outcomes, a drifted version, and the criteria", () => {
    const drifted = { ...result("rg", "modern", { result: "fail", detail: "a | b\nc" }, FAIL), version: "2.0", drifted: true };
    const card = scorecard([drifted, result("mv2", "legacy", PASS, PASS, { result: "n/a", detail: "Manifest V2" })], {
      backend: "emulator", baseline: "0.1.4", commit: "abc1234", date: "2026-10-19",
    });
    assert.match(card, /2026-10-19, backend emulator, ext2userscript abc1234, the baseline 0\.1\.4/);
    assert.match(card, /\| rg \| modern \| 2\.0 \(pinned 1\.0\) \| pass \| fail: a \\\| b c \| fail: no effect \|/);
    assert.match(card, /\| mv2 \| legacy \| 1\.0 \| n\/a \(Manifest V2\) \| pass \| pass \|/);
    assert.match(card, /- \[x\] Passes every case the baseline passes: 1 of 1, 100%/);
    assert.match(card, /- \[ \] Passes at least 75% of the modern cases the baseline fails: 0 of 1, 0%/);
    assert.match(card, /- \[x\] An accurate report for every negative case: none to count/);
    assert.match(card, /\*\*Not met yet\.\*\*/);
  });
});

describe("archiveOf", () => {
  it("uses the pinned archive from the cache without downloading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-bench-"));
    const bytes = archive("1.0");
    const pinned = entry("x", "modern", { sha256: sha256(bytes) });
    await writeFile(join(dir, `x-${pinned.sha256.slice(0, 12)}.crx`), bytes);
    const got = await archiveOf(pinned, { dir, download: () => assert.fail("downloaded") });
    assert.deepEqual([got.version, got.drifted, got.sha256], ["1.0", false, pinned.sha256]);
  });

  it("downloads the store's current archive when the pinned one isn't cached, and caches it by its hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-bench-"));
    const bytes = archive("2.0");
    const got = await archiveOf(entry("x", "modern"), { dir, download: async () => bytes });
    assert.deepEqual([got.version, got.drifted, got.sha256], ["2.0", true, sha256(bytes)]);
    assert.deepEqual(await readdir(dir), [`x-${sha256(bytes).slice(0, 12)}.crx`]);
  });

  it("isn't drifted when the download is the pinned archive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-bench-"));
    const bytes = archive("1.0");
    const got = await archiveOf(entry("x", "modern", { sha256: sha256(bytes) }), { dir, download: async () => bytes });
    assert.equal(got.drifted, false);
  });
});

describe("pinEntry", () => {
  it("pins the store's current version and hash, even when the old pin is cached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-bench-"));
    const old = archive("1.0");
    const current = archive("2.0");
    await writeFile(join(dir, `x-${sha256(old).slice(0, 12)}.crx`), old);
    const pinned = await pinEntry(entry("x", "modern", { sha256: sha256(old) }), { dir, download: async () => current });
    assert.deepEqual([pinned.version, pinned.sha256], ["2.0", sha256(current)]);
  });
});

describe("the corpus", () => {
  it("pins 23 cases, 8 legacy, 12 modern and 3 negative, each with its script", async () => {
    const corpus = await loadCorpus();
    assert.equal(new Set(corpus.map((c) => c.id)).size, corpus.length);
    assert.deepEqual(["legacy", "modern", "negative"].map((kind) => corpus.filter((c) => c.kind === kind).length), [8, 12, 3]);
    for (const c of corpus) {
      assert.match(c.sha256, /^[0-9a-f]{64}$/, c.id);
      const bench = (await import(`../../bench/cases/${c.id}.ts`)).default;
      assert.equal("report" in bench, c.kind === "negative", c.id);
    }
    const scripts = (await readdir(new URL("../../bench/cases/", import.meta.url))).map((file) => file.replace(/\.ts$/, ""));
    assert.deepEqual(scripts.sort(), corpus.map((c) => c.id).sort());
  });
});

describe("copyProfile", () => {
  it("copies a profile without its caches and a running browser's locks", async () => {
    const from = await mkdtemp(join(tmpdir(), "x2u-profile-"));
    for (const dir of ["Default/Cache", "Default/Code Cache", "Default/Local Extension Settings"]) await mkdir(join(from, dir), { recursive: true });
    await writeFile(join(from, "Default/Preferences"), "{}");
    await writeFile(join(from, "Default/Cache/data_0"), "x");
    await writeFile(join(from, "SingletonLock"), "x");
    const to = join(await mkdtemp(join(tmpdir(), "x2u-profile-")), "copy");
    await copyProfile(from, to);
    assert.deepEqual((await readdir(to)).sort(), ["Default"]);
    assert.deepEqual((await readdir(join(to, "Default"))).sort(), ["Local Extension Settings", "Preferences"]);
  });
});

describe("runReference", () => {
  it("is n/a for a negative case and for Manifest V2, without starting a browser", async () => {
    const mv2 = zipFiles(files({ "manifest.json": JSON.stringify({ name: "A", version: "1", manifest_version: 2 }) }));
    const archive2 = { path: "", bytes: mv2, version: "1", sha256: "", drifted: false };
    assert.deepEqual(await runReference(archive2, { report: { verdict: "unlikely", subjects: [] } }), { result: "n/a" });
    assert.deepEqual(await runReference(archive2, { run: async () => {} }), { result: "n/a", detail: "Manifest V2" });
  });
});

describe("runCase on a negative case", () => {
  const devtools = zipFiles(files({ "manifest.json": JSON.stringify({ name: "D", version: "1", manifest_version: 3, devtools_page: "d.html" }), "d.html": "<!doctype html>" }));
  const archiveD = { path: "", bytes: devtools, version: "1", sha256: "", drifted: false };

  it("passes when the report is unlikely and names each subject as unsupported, and is n/a for the baseline", async () => {
    const bench = { report: { verdict: "unlikely" as const, subjects: ["manifest.devtools_page"] } };
    assert.deepEqual(await runCase("ext2userscript", entry("d", "negative"), archiveD, bench, "emulator"), { result: "pass" });
    assert.deepEqual(await runCase("baseline", entry("d", "negative"), archiveD, bench, "emulator"), { result: "n/a" });
  });

  it("fails, naming what the report misses", async () => {
    const bench = { report: { verdict: "unlikely" as const, subjects: ["manifest.devtools_page", "manifest.chrome_url_overrides"] } };
    assert.deepEqual(await runCase("ext2userscript", entry("d", "negative"), archiveD, bench, "emulator"), {
      result: "fail",
      detail: "the report doesn't name manifest.chrome_url_overrides as unsupported",
    });
  });
});

describe("runCase on a browser case", () => {
  it("fails when the conversion does, with the build's error and not just its heading", async () => {
    const manifest = { name: "B", version: "1", manifest_version: 3, background: { service_worker: "bg.js", type: "module" } };
    const bytes = zipFiles(files({ "manifest.json": JSON.stringify(manifest), "bg.js": `import "./missing.js";` }));
    const outcome = await runCase("ext2userscript", entry("b", "modern"), { path: "", bytes, version: "1", sha256: "", drifted: false }, { run: async () => {} }, "emulator");
    assert.equal(outcome.result, "fail");
    assert.match(outcome.detail ?? "", /^conversion failed: Build failed with 1 error: .*\.\/missing\.js \(imported from bg\.js\) is not in the extension$/);
  });
});

describe("runCase with the baseline", () => {
  it("fails when the baseline can't run, with npm's reason and not just the command", async (t) => {
    const before = process.env.X2U_BASELINE;
    t.after(() => (before === undefined ? delete process.env.X2U_BASELINE : (process.env.X2U_BASELINE = before)));
    process.env.X2U_BASELINE = "file:/nonexistent/x2u";
    const outcome = await runCase("baseline", entry("t", "modern"), { path: "/nonexistent/t.crx", bytes: new Uint8Array(), version: "1", sha256: "", drifted: false }, { run: async () => {} }, "emulator");
    assert.equal(outcome.result, "fail");
    assert.match(outcome.detail ?? "", /^conversion failed: npm error code ENOENT .*\/nonexistent\/x2u\/package\.json/);
  });
});

describe("check", () => {
  it("gives the case's outcome even when closing its session fails", async () => {
    const session = { context: { on() {} } as unknown as BrowserContext, close: async () => { throw new Error("Target closed"); } };
    assert.deepEqual(await check({ run: async () => { throw new Error("no effect"); } }, session), { result: "fail", detail: "no effect" });
  });
});

describe("selectCases", () => {
  const corpus = [entry("a", "legacy"), entry("b", "modern")];

  it("runs the whole corpus, or the cases --case names", () => {
    assert.deepEqual(selectCases(corpus, []).map((c) => c.id), ["a", "b"]);
    assert.deepEqual(selectCases(corpus, ["--case", "b"]).map((c) => c.id), ["b"]);
  });

  it("refuses ids the corpus doesn't have, and a gate on part of the corpus", () => {
    assert.throws(() => selectCases(corpus, ["--case", "a,c,d"]), /^Error: No case c, d in bench\/corpus\.json$/);
    assert.throws(() => selectCases(corpus, ["--case", "--gate"]), /^Error: No case --gate in bench\/corpus\.json$/);
    assert.throws(() => selectCases(corpus, ["--case"]), /^Error: --case needs case ids, like --case json-formatter,dark-reader$/);
    assert.throws(() => selectCases(corpus, ["--gate", "--case", "a"]), /^Error: --gate judges the whole corpus: leave out --case$/);
  });
});

describe("runCorpus", () => {
  it("marks a case whose archive can't be had as failed everywhere, its reference too, and goes on", async () => {
    const results = await runCorpus(["emulator", "tm"], [entry("gone", "modern")], async () => {
      throw new Error("The download is empty");
    });
    const failed = { result: "fail", detail: "couldn't get the archive: The download is empty" };
    for (const backend of ["emulator", "tm"] as const) {
      assert.deepEqual(results.get(backend)?.map(({ reference, outcomes }) => ({ reference, outcomes })), [{ reference: failed, outcomes: { ext2userscript: failed, "baseline": failed } }]);
    }
  });
});
