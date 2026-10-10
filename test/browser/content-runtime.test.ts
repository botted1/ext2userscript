// A converted extension's content scripts end to end, on each backend in X2U_BACKENDS (default: the CI emulator).
// Release tier: X2U_BACKENDS=tm,vm with the bench profile from `npm run bench:setup`.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { backendsFromEnv, startSession, type Session } from "../../bench/session.ts";
import { convert } from "../../src/convert/index.ts";
import { loadRuntime } from "../../src/convert/runtime-node.ts";
import { readAttr, waitForAttr } from "../support/dom.ts";
import { sampleExtension } from "../support/extension.ts";
import { startServer, type Server } from "../support/server.ts";
import { sleep } from "../support/time.ts";

const html = (body: string, head = "") => () =>
  new Response(`<!doctype html><html><head><title>x2u</title>${head}</head><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
const page = html('<div class="x2u-box">box</div>', "<script>window.pageValue = 42;</script>");

/** Polls an attribute on any element (a frame's <html>, say) until it satisfies ok, for up to 10 s. */
async function attrUntil(element: Locator, name: string, ok: (value: string | null) => boolean): Promise<string | null> {
  let value = await element.getAttribute(name);
  for (let waited = 0; !ok(value) && waited < 10_000; waited += 100) {
    await sleep(100);
    value = await element.getAttribute(name);
  }
  return value;
}

for (const backend of backendsFromEnv()) {
  describe(`converted content scripts on ${backend}`, () => {
    let site: Server;
    let session: Session;

    before(async () => {
      site = await startServer({
        "/page.html": page,
        "/writer.html": page,
        "/excluded.html": page,
        "/glob-yes.html": page,
        "/framed.html": html('<iframe src="/child.html"></iframe>'),
        "/child.html": html("child"),
      });
      const { userscript } = await convert(sampleExtension(site.origin), { runtime: await loadRuntime() });
      session = await startSession(backend, userscript);
    });

    after(async () => {
      await session?.close();
      await site?.close();
    });

    const open = async (path: string): Promise<Page> => {
      const tab = await session.context.newPage();
      await tab.goto(`${site.origin}${path}`);
      return tab;
    };

    it("runs isolated, MAIN-world and document_start groups with their chrome APIs, despite a failing group", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-content", "lib"); // lib.js passed webextension-polyfill's globalThis.chrome check
      assert.equal(await readAttr(tab, "data-greeting"), "Hello x2u");
      await waitForAttr(tab, "data-stored", "1");
      await waitForAttr(tab, "data-info", "sample");
      await waitForAttr(tab, "data-main", "42");
      assert.match((await readAttr(tab, "data-start")) ?? "", /^(loading|interactive|complete)$/);
      assert.equal(await readAttr(tab, "data-glob"), null);
      await waitForAttr(tab, "data-send-error", "ext2userscript: chrome.runtime.sendMessage is not available in userscripts");
    });

    it("applies the group's CSS, with its images as blob URLs", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-content", "lib");
      const style = await tab.locator(".x2u-box").evaluate((box) => ({ color: getComputedStyle(box).color, image: getComputedStyle(box).backgroundImage }));
      assert.equal(style.color, "rgb(1, 2, 3)");
      assert.match(style.image, /^url\("blob:/);
    });

    it("runs a <script src=runtime.getURL(...)> in the page's world, then fires its load event", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-inject-loaded", "1");
      assert.equal(await readAttr(tab, "data-injected"), "page");
    });

    it("honours exclude_matches, include_globs and all_frames", async () => {
      const excluded = await open("/excluded.html");
      await waitForAttr(excluded, "data-main", "42");
      assert.equal(await readAttr(excluded, "data-content"), null);

      await waitForAttr(await open("/glob-yes.html"), "data-glob", "1");

      const child = (await open("/framed.html")).frameLocator("iframe").locator("html");
      assert.equal(await attrUntil(child, "data-content", (value) => value === "lib"), "lib");
      assert.equal(await child.getAttribute("data-main"), null);
    });

    it("delivers storage.onChanged across tabs", async () => {
      const reader = await open("/page.html");
      await waitForAttr(reader, "data-stored", "1");
      await open("/writer.html");
      assert.match((await attrUntil(reader.locator("html"), "data-changed", (value) => (value ?? "").includes("fromWriter"))) ?? "", /fromWriter/);
    });
  });
}
