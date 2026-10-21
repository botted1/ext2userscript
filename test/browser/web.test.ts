// The web app (spec §8) end to end: built as `npm run web` builds it, served under a subpath as GitHub Pages serves a
// project site, and driven in Chromium, Firefox and WebKit.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { buildWeb } from "../../web/build.ts";
import { files, moduleBackgroundExtension, sampleExtension, zipFiles } from "../support/extension.ts";
import { startServer, type Handler, type Server } from "../support/server.ts";

const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css", js: "text/javascript", wasm: "application/wasm" };
const ID = "abcdefghijklmnopabcdefghijklmnop";
const STORE_PAGE = `https://chromewebstore.google.com/detail/sample/${ID}`;
const LARGE_PAGE = `https://microsoftedge.microsoft.com/addons/detail/large/${ID}`;

/** The built site's routes under /x2u/, as GitHub Pages serves a project site. */
async function site(proxyUrl?: string) {
  const dir = await mkdtemp(join(tmpdir(), "x2u-web-"));
  await buildWeb(dir, { proxyUrl });
  const routes: Record<string, Handler> = {};
  for (const name of await readdir(dir)) {
    const bytes = await readFile(join(dir, name));
    const response = () => new Response(bytes, { headers: { "content-type": TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream" } });
    routes[`/x2u/${name}`] = response;
    if (name === "index.html") routes["/x2u/"] = response;
  }
  await rm(dir, { recursive: true });
  return routes;
}

const archive = (name: string, extension: Map<string, Uint8Array>) => ({ name, mimeType: "application/zip", buffer: Buffer.from(zipFiles(extension)) });

async function result(page: Page): Promise<string> {
  await page.locator("#result").waitFor({ state: "visible", timeout: 30_000 });
  return (await page.locator("#result-title").textContent()) ?? "";
}

const browsers: Array<[string, BrowserType]> = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];
for (const [name, type] of browsers) {
  describe(`web app in ${name}`, { skip: name === "firefox" && process.platform === "darwin" ? "Playwright's Firefox doesn't launch on macOS 27 (CI runs it)" : false }, () => {
    let browser: Browser;
    let server: Server;
    let origin = "";

    before(async () => {
      browser = await type.launch();
      server = await startServer(await site());
      origin = server.origin;
    });

    after(async () => {
      await browser?.close();
      await server?.close();
    });

    it("converts a chosen archive and shows its report, with the userscript to download", async () => {
      const page = await browser.newPage({ acceptDownloads: true });
      await page.goto(`${origin}/x2u/`);
      await page.locator("#file").setInputFiles(archive("sample.zip", sampleExtension(origin)));
      assert.equal(await result(page), "Sample Extension 1.2.3");
      // The result takes the focus, so a screen reader announces it and the keyboard goes on from there.
      assert.equal(await page.evaluate(() => document.activeElement?.id), "result-title");
      assert.equal(await page.locator("#verdict").textContent(), "Partly works");
      assert.deepEqual(await page.locator("#groups summary").allTextContents(), ["Partly supported (1)", "Supported (6)"]);
      const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download").click()]);
      assert.equal(download.suggestedFilename(), "sample-extension.user.js");
      const userscript = await readFile((await download.path()) as string, "utf8");
      assert.match(userscript, /^\/\/ ==UserScript==\n\/\/ @name {9}Sample Extension\n/);
      await page.close();
    });

    it("copies the userscript, and is usable from the keyboard", { skip: name !== "chromium" ? "only Chromium lets a test read the clipboard" : false }, async () => {
      const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
      const page = await context.newPage();
      await page.goto(`${origin}/x2u/`);
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "file");
      await page.locator("#file").setInputFiles(archive("sample.zip", sampleExtension(origin)));
      await result(page);
      await page.locator("#copy").click();
      await page.locator("#status", { hasText: "Copied." }).waitFor();
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^\/\/ ==UserScript==\n\/\/ @name {9}Sample Extension\n/);
      await context.close();
    });

    it("loads the converter with the first conversion, and esbuild only for one that needs it", async () => {
      const page = await browser.newPage();
      const asked: string[] = [];
      page.on("request", (request) => asked.push(new URL(request.url()).pathname));
      await page.goto(`${origin}/x2u/`);
      assert.deepEqual(asked.filter((path) => /worker|wasm/.test(path)), []);
      await page.locator("#file").setInputFiles(archive("sample.zip", sampleExtension(origin)));
      await result(page);
      assert.deepEqual(asked.filter((path) => /worker|wasm/.test(path)), ["/x2u/worker.js"]);
      await page.locator("#file").setInputFiles(archive("module.zip", moduleBackgroundExtension(origin)));
      await page.locator("#result-title", { hasText: "Module Background" }).waitFor({ timeout: 30_000 });
      assert.deepEqual(asked.filter((path) => /worker|wasm/.test(path)), ["/x2u/worker.js", "/x2u/esbuild.wasm"]);
      await page.close();
    });

    it("converts a 20 MB archive", async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/x2u/`);
      const extension = sampleExtension(origin);
      // Incompressible, so the archive is as large as its files.
      extension.set("data/blob.bin", randomBytes(20 * 1024 * 1024));
      await page.locator("#file").setInputFiles(archive("large.zip", extension));
      assert.equal(await result(page), "Sample Extension 1.2.3");
      await page.close();
    });

    it("says so when esbuild fails to load, and loads it on the next try", async () => {
      // esbuild.wasm fails once, as on a flaky connection, then loads.
      const routes = await site();
      let failures = 1;
      const wasm = routes["/x2u/esbuild.wasm"];
      routes["/x2u/esbuild.wasm"] = (request) => (failures-- > 0 ? new Response("unavailable", { status: 503 }) : wasm(request));
      const flaky = await startServer(routes);
      try {
        const page = await browser.newPage();
        await page.goto(`${flaky.origin}/x2u/`);
        await page.locator("#file").setInputFiles(archive("module.zip", moduleBackgroundExtension(flaky.origin)));
        await page.locator("#error").waitFor({ state: "visible", timeout: 30_000 });
        assert.match((await page.locator("#error").textContent()) ?? "", /^Couldn't convert it: Failed to download ".*\/x2u\/esbuild\.wasm"$/);
        await page.locator("#file").setInputFiles(archive("module.zip", moduleBackgroundExtension(flaky.origin)));
        assert.equal(await result(page), "Module Background 2.0.0");
        await page.close();
      } finally {
        await flaky.close();
      }
    });

    it("starts the converter again after it failed to load", async () => {
      // worker.js fails once, as on a connection that dropped after the page loaded, then loads.
      const routes = await site();
      let failures = 1;
      const worker = routes["/x2u/worker.js"];
      routes["/x2u/worker.js"] = (request) => (failures-- > 0 ? new Response("unavailable", { status: 503 }) : worker(request));
      const flaky = await startServer(routes);
      try {
        const page = await browser.newPage();
        await page.goto(`${flaky.origin}/x2u/`);
        await page.locator("#file").setInputFiles(archive("sample.zip", sampleExtension(flaky.origin)));
        await page.locator("#error").waitFor({ state: "visible", timeout: 30_000 });
        assert.match((await page.locator("#error").textContent()) ?? "", /^The converter couldn't start: /);
        await page.locator("#file").setInputFiles(archive("sample.zip", sampleExtension(flaky.origin)));
        assert.equal(await result(page), "Sample Extension 1.2.3");
        await page.close();
      } finally {
        await flaky.close();
      }
    });

    it("shows the file picked last, even when an earlier one takes longer to read", async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/x2u/`);
      const large = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Large Sample", version: "1.0", content_scripts: [{ matches: ["https://a.test/*"], js: ["c.js"] }] }), "c.js": "" });
      large.set("data/blob.bin", randomBytes(40 * 1024 * 1024));
      await page.locator("#file").setInputFiles(archive("large.zip", large));
      await page.locator("#file").setInputFiles(archive("sample.zip", sampleExtension(origin)));
      assert.equal(await result(page), "Sample Extension 1.2.3");
      await page.waitForTimeout(3_000);
      assert.equal(await page.locator("#result-title").textContent(), "Sample Extension 1.2.3");
      await page.close();
    });

    it("shows the latest of two overlapping conversions", async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/x2u/`);
      // The module background waits for esbuild to load; the sample, chosen after it, finishes first.
      await page.locator("#file").setInputFiles(archive("module.zip", moduleBackgroundExtension(origin)));
      await page.locator("#file").setInputFiles(archive("sample.zip", sampleExtension(origin)));
      assert.equal(await result(page), "Sample Extension 1.2.3");
      await page.waitForTimeout(3_000);
      assert.equal(await page.locator("#result-title").textContent(), "Sample Extension 1.2.3");
      await page.close();
    });

    it("takes a dropped archive, and says what is wrong with a file that isn't one", async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/x2u/`);
      await page.evaluate((bytes) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], "sample.zip", { type: "application/zip" }));
        document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }, [...zipFiles(sampleExtension(origin))]);
      assert.equal(await result(page), "Sample Extension 1.2.3");
      await page.locator("#file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
      assert.equal(await page.locator("#error").textContent(), "notes.txt isn't an extension archive: choose a .crx, .zip or .xpi file (zip a folder first).");
      await page.locator("#file").setInputFiles({ name: "broken.zip", mimeType: "application/zip", buffer: Buffer.from("not a zip") });
      await page.locator("#error", { hasText: "Unrecognised" }).waitFor();
      assert.equal(await page.locator("#error").textContent(), "Couldn't convert it: Unrecognised archive: expected a .crx, .xpi or .zip file");
      assert.equal(await page.locator("#result").isHidden(), true);
      await page.close();
    });

    it("shows an extension's name as text, never as markup", async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/x2u/`);
      const name = '<img src=x onerror="document.title = 1">';
      const extension = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name, version: "1.0", content_scripts: [{ matches: ["https://a.test/*"], js: ["c.js"] }] }), "c.js": "" });
      await page.locator("#file").setInputFiles(archive("odd.zip", extension));
      assert.equal(await result(page), `${name} 1.0`);
      assert.equal(await page.locator("#result img").count(), 0);
      assert.equal(await page.title(), "ext2userscript");
      await page.close();
    });

    it("converts from a store page through the download proxy, with the store's ID as the extension's", async () => {
      // The site and a stand-in for the proxy on one server, whose address the build needs first.
      const routes: Record<string, Handler> = {};
      const proxied = await startServer(routes);
      try {
        Object.assign(routes, await site(`${proxied.origin}/proxy`), {
          "/proxy": (request: Request) => {
            const src = new URL(request.url).searchParams.get("src");
            if (src === STORE_PAGE) return new Response(zipFiles(sampleExtension(origin)));
            if (src === LARGE_PAGE) return new Response(`Download is larger than 50 MiB: ${src}`, { status: 502 });
            return new Response("src must be a Chrome Web Store, Firefox Add-ons or Edge Add-ons page", { status: 400 });
          },
        });
        const page = await browser.newPage({ acceptDownloads: true });
        await page.goto(`${proxied.origin}/x2u/`);
        await page.locator("#link").fill(STORE_PAGE);
        await page.locator("#store button").click();
        assert.equal(await result(page), "Sample Extension 1.2.3");
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#download").click()]);
        assert.match(await readFile((await download.path()) as string, "utf8"), new RegExp(`"id":"${ID}"`));
        await page.locator("#link").fill("https://example.com/extension.crx");
        await page.locator("#store button").click();
        await page.locator("#error", { hasText: "store" }).waitFor();
        assert.equal(await page.locator("#error").textContent(), "Couldn't convert it: That isn't a Chrome Web Store, Firefox Add-ons or Edge Add-ons page");
        // The proxy's own reason for failing reaches the page.
        await page.locator("#link").fill(LARGE_PAGE);
        await page.locator("#store button").click();
        await page.locator("#error", { hasText: "50 MiB" }).waitFor();
        assert.equal(await page.locator("#error").textContent(), `Couldn't convert it: Download is larger than 50 MiB: ${LARGE_PAGE}`);
        await page.close();
      } finally {
        await proxied.close();
      }
    });

    it("disables the store link without a download proxy, saying why", async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/x2u/`);
      assert.equal(await page.locator("#link").isDisabled(), true);
      assert.equal(await page.locator("#store button").isDisabled(), true);
      assert.equal(await page.locator("#store-hint").isVisible(), true);
      assert.equal(await page.locator("#link").getAttribute("aria-describedby"), "store-hint");
      await page.close();
    });
  });
}
