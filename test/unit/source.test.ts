import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSource, readSource, sourceName } from "../../src/source.ts";

const ID = "hlepfoohegkhhmjieoechaddaejaokhf";

describe("parseSource", () => {
  it("reads Chrome Web Store URLs, old and new, and bare IDs", async () => {
    assert.deepEqual(await parseSource(`https://chromewebstore.google.com/detail/refined-github/${ID}`), { kind: "cws", id: ID });
    assert.deepEqual(await parseSource(`https://chromewebstore.google.com/detail/${ID}?hl=en`), { kind: "cws", id: ID });
    assert.deepEqual(await parseSource(`https://chrome.google.com/webstore/detail/refined-github/${ID}`), { kind: "cws", id: ID });
    assert.deepEqual(await parseSource(ID), { kind: "cws", id: ID });
  });

  it("reads Edge Add-ons URLs", async () => {
    assert.deepEqual(await parseSource(`https://microsoftedge.microsoft.com/addons/detail/some-name/${ID}`), { kind: "edge", id: ID });
  });

  it("reads AMO URLs and slugs", async () => {
    assert.deepEqual(await parseSource("https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/"), { kind: "amo", slug: "ublock-origin" });
    assert.deepEqual(await parseSource("darkreader"), { kind: "amo", slug: "darkreader" });
  });

  it("treats any other URL as a direct download", async () => {
    assert.deepEqual(await parseSource("https://example.com/files/ext.crx"), { kind: "url", url: "https://example.com/files/ext.crx" });
  });

  it("prefers a local file or directory, and names a missing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-source-"));
    await writeFile(join(dir, "darkreader"), "");
    assert.deepEqual(await parseSource(join(dir, "darkreader")), { kind: "file", path: join(dir, "darkreader") });
    assert.deepEqual(await parseSource(dir), { kind: "dir", path: dir });
    await assert.rejects(parseSource(join(dir, "missing.zip")), /No such file or directory/);
    await assert.rejects(parseSource("missing.crx"), /No such file or directory/);
  });
});

describe("readSource", () => {
  it("reads a directory, skipping hidden files and folders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-source-"));
    await mkdir(join(dir, "js"));
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "manifest.json"), "{}");
    await writeFile(join(dir, "js", "a.js"), "1");
    await writeFile(join(dir, ".git", "HEAD"), "x");
    await writeFile(join(dir, ".DS_Store"), "x");
    const { files, extensionId } = await readSource({ kind: "dir", path: dir });
    assert.deepEqual([...files.keys()].sort(), ["js/a.js", "manifest.json"]);
    assert.equal(extensionId, undefined);
  });

  it("refuses a directory without manifest.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x2u-source-"));
    await assert.rejects(readSource({ kind: "dir", path: dir }), /has no manifest\.json/);
  });
});

describe("sourceName", () => {
  it("names output after the store ID, slug or file", () => {
    assert.equal(sourceName({ kind: "cws", id: ID }), ID);
    assert.equal(sourceName({ kind: "amo", slug: "darkreader" }), "darkreader");
    assert.equal(sourceName({ kind: "url", url: "https://example.com/a/ext.crx?x=1" }), "ext");
    assert.equal(sourceName({ kind: "file", path: "/tmp/my-ext.zip" }), "my-ext");
  });
});
