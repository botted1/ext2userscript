// The npm package as a user gets it: npm pack, npm install of the tarball into a temporary directory, then its
// ext2userscript command. It builds and installs, so it runs apart from the unit tests: npm run test:package.
// X2U_ARCHIVE=<.crx, .xpi or .zip> also converts that archive, e.g. one from bench/.cache/archives.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { files, moduleBackgroundExtension, zipFiles } from "./support/extension.ts";

function run(file: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
  });
}

describe("the npm package", () => {
  let dir: string;
  let cli: string;
  let packed: string[];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "x2u-package-"));
    const pack = await run("npm", ["pack", "--json", "--silent", "--pack-destination", dir], join(import.meta.dirname, ".."));
    assert.equal(pack.code, 0, pack.stderr);
    const [{ filename, files }] = JSON.parse(pack.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    packed = files.map((file) => file.path).sort();
    const install = await run("npm", ["install", "--prefix", join(dir, "app"), "--prefer-offline", "--no-audit", "--no-fund", join(dir, filename)], dir);
    assert.equal(install.code, 0, install.stderr);
    cli = join(dir, "app", "node_modules", ".bin", "ext2userscript");
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it("ships the built CLI and none of the repository's source", () => {
    assert.deepEqual(packed, ["LICENSE", "README.md", "dist/cli.js", "package.json"]);
  });

  it("runs --help through npm's command link and exits 0", async () => {
    const result = await run(cli, ["--help"], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Usage:\n {2}ext2userscript convert <source>/);
  });

  it("converts an archive with a module background, bundled by the installed esbuild, and exits 0", async () => {
    await writeFile(join(dir, "module.zip"), zipFiles(moduleBackgroundExtension("https://example.com")));
    const result = await run(cli, ["convert", "module.zip", "-o", "module.user.js"], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Module Background 2\.0\.0 \(manifest v3\)/);
    const userscript = await readFile(join(dir, "module.user.js"), "utf8");
    assert.match(userscript, /^\/\/ ==UserScript==/);
    assert.match(userscript, /"module:" \+ path/, "the background's import is bundled in");
  });

  it("exits 2 when the verdict is unlikely", async () => {
    const newtab = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "New Tab", version: "1.0", chrome_url_overrides: { newtab: "tab.html" } }) });
    await writeFile(join(dir, "newtab.zip"), zipFiles(newtab));
    const result = await run(cli, ["convert", "newtab.zip", "-o", "newtab.user.js"], dir);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stdout, /New Tab 1\.0 \(manifest v3\): unlikely/);
  });

  const archive = process.env.X2U_ARCHIVE;
  it("converts X2U_ARCHIVE and exits 0 or 2", { skip: !archive && "X2U_ARCHIVE is not set" }, async () => {
    const result = await run(cli, ["convert", resolve(archive!), "-o", "archive.user.js", "--report", "archive.json"], dir);
    assert.ok(result.code === 0 || result.code === 2, `exit ${result.code}: ${result.stderr}`);
    assert.equal(result.code, JSON.parse(await readFile(join(dir, "archive.json"), "utf8")).verdict === "unlikely" ? 2 : 0);
    assert.match(await readFile(join(dir, "archive.user.js"), "utf8"), /^\/\/ ==UserScript==/);
  });
});
