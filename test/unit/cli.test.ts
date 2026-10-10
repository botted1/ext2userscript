// The CLI as a user runs it: a child process, in a temporary directory.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plainExtension, sampleExtension, zipFiles } from "../support/extension.ts";
import { startServer, type Server } from "../support/server.ts";

const CLI = join(import.meta.dirname, "../../src/cli.ts");

function run(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", CLI, ...args], { cwd }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe("ext2userscript CLI", () => {
  let cwd: string;
  let server: Server;
  const sampleZip = zipFiles(sampleExtension("https://example.com"));

  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), "x2u-cli-"));
    await mkdir(join(cwd, "plain"));
    for (const [path, bytes] of plainExtension()) await writeFile(join(cwd, "plain", path), bytes);
    await writeFile(join(cwd, "sample.zip"), sampleZip);
    server = await startServer({ "/sample.zip": () => new Response(sampleZip) });
  });

  after(() => server.close());

  it("converts a directory, exits 0 and prints the report", async () => {
    const result = await run(cwd, "convert", "plain");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Wrote plain-extension\.user\.js/);
    assert.match(result.stdout, /Plain Extension 0\.1\.0 \(manifest v3\): likely-works/);
    assert.match(await readFile(join(cwd, "plain-extension.user.js"), "utf8"), /^\/\/ ==UserScript==/);
  });

  it("refuses to overwrite without --force", async () => {
    await run(cwd, "convert", "plain", "-o", "again.user.js");
    const refused = await run(cwd, "convert", "plain", "-o", "again.user.js");
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /again\.user\.js already exists \(use --force to overwrite it\)/);
    assert.equal((await run(cwd, "convert", "plain", "-o", "again.user.js", "--force")).code, 0);
  });

  it("exits 2 when the verdict is unlikely, and writes the JSON report", async () => {
    const result = await run(cwd, "convert", "sample.zip", "-o", "sample.user.js", "--report", "sample.json");
    assert.equal(result.code, 2, result.stderr);
    const report = JSON.parse(await readFile(join(cwd, "sample.json"), "utf8"));
    assert.equal(report.verdict, "unlikely");
    assert.ok(report.entries.some((entry: { subject: string }) => entry.subject === "chrome.runtime.sendMessage"));
  });

  it("reports without writing a userscript", async () => {
    const result = await run(cwd, "report", "plain");
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Wrote/);
  });

  it("converts from a URL and downloads an archive as it is", async () => {
    const converted = await run(cwd, "convert", `${server.origin}/sample.zip`, "-o", "from-url.user.js");
    assert.equal(converted.code, 2, converted.stderr);
    const named = await run(cwd, "download", `${server.origin}/sample.zip`);
    assert.equal(named.code, 1, "sample.zip is already there");
    const downloaded = await run(cwd, "download", `${server.origin}/sample.zip`, "-o", "downloaded.zip");
    assert.equal(downloaded.code, 0, downloaded.stderr);
    assert.deepEqual(new Uint8Array(await readFile(join(cwd, "downloaded.zip"))), sampleZip);
  });

  it("says what it downloads before it does, and nothing for local sources", async () => {
    const remote = await run(cwd, "report", `${server.origin}/sample.zip`);
    assert.equal(remote.stderr, `Downloading ${server.origin}/sample.zip\n`);
    const local = await run(cwd, "report", "plain");
    assert.equal(local.stderr, "");
  });

  it("drops control characters from error messages that quote the archive", async () => {
    await writeFile(join(cwd, "evil.zip"), zipFiles(new Map([["manifest.json", new Uint8Array()], ["a\u001b[2K.js", new Uint8Array()], ["./a\u001b[2K.js", new Uint8Array()]])));
    const result = await run(cwd, "report", "evil.zip");
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "ext2userscript: Ambiguous archive: a[2K.js appears more than once\n");
  });

  it("explains a bad command line or a missing source", async () => {
    const usage = await run(cwd, "explode", "x");
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /Usage:/);
    const unknown = await run(cwd, "convert", "plain", "--bogus");
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Unknown option '--bogus'/);
    const missing = await run(cwd, "convert", "missing/ext.zip");
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No such file or directory: missing\/ext\.zip/);
  });
});
