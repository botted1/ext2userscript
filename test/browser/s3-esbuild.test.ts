// Spike S3 (spec §11): esbuild-wasm in a Web Worker bundles a real MV3 module service worker byte-for-byte like
// native esbuild, in Chromium, Firefox and WebKit. The fixture is downloaded once into bench/.cache/fixtures.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { chromium, firefox, webkit, type BrowserType } from "playwright";
import { bundleModule } from "../../src/convert/esbuild.ts";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { unpack } from "../../src/convert/unpack.ts";
import { cwsCrxUrl, fetchBytes } from "../../src/download.ts";
import { startServer, type Server } from "../support/server.ts";

const FIXTURE = { name: "Refined GitHub", cwsId: "hlepfoohegkhhmjieoechaddaejaokhf" };
const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE_PATH = join(ROOT, "bench", ".cache", "fixtures", `${FIXTURE.cwsId}.crx`);
const PAGE = `<!doctype html><html><head><title>s3</title><script type="module">
const worker = new Worker("/worker.js", { type: "module" });
// Listen from the start: a worker that fails to load reports before runS3 is called.
const failed = new Promise((resolve) => {
  worker.onerror = (event) => resolve({ error: "worker error: " + (event.message || "the worker failed to load or start") });
  worker.onmessageerror = () => resolve({ error: "the worker's reply could not be deserialised" });
});
window.runS3 = (job) => Promise.race([
  new Promise((resolve) => { worker.onmessage = (event) => resolve(event.data); worker.postMessage(job); }),
  failed,
  new Promise((resolve) => setTimeout(resolve, 30000, { error: "no reply from the worker within 30s" })),
]);
</script></head><body>s3</body></html>`;

async function fixture(): Promise<Uint8Array<ArrayBuffer>> {
  if (!existsSync(FIXTURE_PATH)) {
    await mkdir(dirname(FIXTURE_PATH), { recursive: true });
    await writeFile(FIXTURE_PATH, await fetchBytes(cwsCrxUrl(FIXTURE.cwsId)));
  }
  return new Uint8Array(await readFile(FIXTURE_PATH));
}

describe(`S3: esbuild-wasm bundles ${FIXTURE.name}'s module service worker in a Web Worker`, () => {
  let server: Server | undefined;
  let entry = "";
  let expected = "";

  before(async () => {
    const crx = await fixture();
    const files = unpack(crx);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as {
      version: string;
      background?: { service_worker?: string; type?: string };
    };
    assert.equal(manifest.background?.type, "module", "the fixture must declare a module service worker");
    entry = manifest.background?.service_worker ?? "";
    const source = new TextDecoder().decode(files.get(entry));
    assert.match(source, /\bimport\b[^;]*["']\.{0,2}\//, "the fixture's worker should import other files, or S3 proves little");
    const native = await bundleModule(await loadEsbuild(), files, entry);
    expected = createHash("sha256").update(native.code).digest("hex");
    console.log(`[S3] ${FIXTURE.name} ${manifest.version}: ${entry}, native bundle ${native.code.length} bytes`);
    const worker = await build({ entryPoints: [join(import.meta.dirname, "s3", "worker.ts")], bundle: true, format: "esm", platform: "browser", target: "es2020", write: false });
    const wasm = new Uint8Array(await readFile(join(ROOT, "node_modules", "esbuild-wasm", "esbuild.wasm")));
    server = await startServer({
      "/s3.html": () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "/worker.js": () => new Response(worker.outputFiles[0].text, { headers: { "content-type": "text/javascript" } }),
      "/esbuild.wasm": () => new Response(wasm, { headers: { "content-type": "application/wasm" } }),
      "/fixture.crx": () => new Response(crx, { headers: { "content-type": "application/octet-stream" } }),
    });
  });

  after(async () => {
    await server?.close();
  });

  const browsers: Array<[string, BrowserType]> = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];
  for (const [name, type] of browsers) {
    it(`${name}: byte-identical to native esbuild, first run under 10s`, { timeout: 60_000 }, async () => {
      const browser = await type.launch();
      try {
        const tab = await browser.newPage();
        await tab.goto(`${server?.origin}/s3.html`);
        await tab.waitForFunction(() => "runS3" in window);
        const result = (await tab.evaluate(
          (e) => (window as unknown as { runS3(job: { url: string; entry: string }): Promise<unknown> }).runS3({ url: "/fixture.crx", entry: e }),
          entry,
        )) as { sha256?: string; ms?: number; error?: string };
        console.log(`[S3] ${name}: ${JSON.stringify(result)}`);
        assert.equal(result.error, undefined);
        assert.equal(result.sha256, expected, "the wasm output differs from native esbuild");
        assert.ok((result.ms ?? Infinity) < 10_000, `the first conversion took ${Math.round(result.ms ?? 0)}ms`);
      } finally {
        await browser.close();
      }
    });
  }
});
