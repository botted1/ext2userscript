import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveOf, sha256, type CorpusEntry } from "../../bench/corpus.ts";
import { pinEntry } from "../../bench/pin.ts";
import { files, zipFiles } from "../support/extension.ts";

const entry = (id: string, kind: CorpusEntry["kind"], extra: Partial<CorpusEntry> = {}): CorpusEntry => ({
  id, name: id, store: "cws", extensionId: "a".repeat(32), version: "1.0", sha256: "0".repeat(64), kind, ...extra,
});
const archive = (version: string) => zipFiles(files({ "manifest.json": JSON.stringify({ name: "A", version, manifest_version: 3 }) }));

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
