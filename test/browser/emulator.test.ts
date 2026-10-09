import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { installEmulator, type Emulator } from "../../bench/emulator/index.ts";
import { readAttr, waitForAttr } from "../support/dom.ts";
import { startServer, type Server } from "../support/server.ts";
import { renderMeta, type MetaInput } from "../support/userscript.ts";

const html = (head = "") => () =>
  new Response(`<!doctype html><html><head><title>t</title>${head}</head><body></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("CI emulator", () => {
  let browser: Browser;
  let site: Server;
  let other: Server;

  before(async () => {
    browser = await chromium.launch();
    site = await startServer({
      "/a.html": html(),
      "/ab.html": html(),
      "/order.html": html(`<script>document.documentElement.setAttribute("data-page-saw", document.documentElement.getAttribute("data-us") ?? "none")</script>`),
      "/echo": async (request) => Response.json({ body: await request.text() }),
    });
    other = await startServer({ "/b.html": html() });
  });

  after(async () => {
    await browser.close();
    await site.close();
    await other.close();
  });

  async function withScript(meta: Partial<MetaInput>, body: string, run: (context: BrowserContext, emulator: Emulator) => Promise<void>) {
    const context = await browser.newContext();
    try {
      const userscript = `${renderMeta({ name: "emulator test", match: [`${site.origin}/*`, `${other.origin}/*`], grant: [], runAt: "document-start", ...meta })}\n${body}`;
      await run(context, await installEmulator(context, userscript));
    } finally {
      await context.close();
    }
  }

  it("shares values across pages on different origins", async () => {
    const body = `
      const root = document.documentElement;
      root.setAttribute("data-initial", JSON.stringify(GM_getValue("k") ?? null));
      GM_addValueChangeListener("k", (key, oldValue, newValue, remote) => root.setAttribute("data-change", JSON.stringify({ newValue, remote })));
      if (location.pathname === "/a.html") GM_setValue("k", { n: 1 });
    `;
    await withScript({ grant: ["GM_getValue", "GM_setValue", "GM_addValueChangeListener"], runAt: "document-end" }, body, async (context) => {
      const b = await context.newPage();
      await b.goto(`${other.origin}/b.html`);
      await waitForAttr(b, "data-initial", "null");
      const a = await context.newPage();
      await a.goto(`${site.origin}/a.html`);
      await waitForAttr(b, "data-change", JSON.stringify({ newValue: { n: 1 }, remote: true }));
      const c = await context.newPage();
      await c.goto(`${other.origin}/b.html`);
      await waitForAttr(c, "data-initial", JSON.stringify({ n: 1 }));
    });
  });

  it("honours @match, @exclude-match and @run-at", async () => {
    const body = `document.documentElement.setAttribute("data-us", "ran");`;
    await withScript({ match: [`${site.origin}/*`], excludeMatch: [`${site.origin}/ab*`] }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/a.html`);
      assert.equal(await readAttr(page, "data-us"), "ran");
      await page.goto(`${site.origin}/ab.html`);
      assert.equal(await readAttr(page, "data-us"), null);
      await page.goto(`${other.origin}/b.html`);
      assert.equal(await readAttr(page, "data-us"), null);
      await page.goto(`${site.origin}/order.html`);
      assert.equal(await readAttr(page, "data-page-saw"), "ran", "document-start runs before the page's scripts");
    });
    await withScript({ runAt: "document-end" }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/order.html`);
      await waitForAttr(page, "data-us", "ran");
      assert.equal(await readAttr(page, "data-page-saw"), "none", "document-end runs after the page's scripts");
    });
  });

  it("defines only the granted functions", async () => {
    const body = `document.documentElement.setAttribute("data-types", [typeof GM_getValue, typeof GM_setValue, typeof GM_info].join(","));`;
    await withScript({ grant: ["GM_getValue"] }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/a.html`);
      assert.equal(await readAttr(page, "data-types"), "function,undefined,object");
    });
  });

  it("GM_xmlhttpRequest skips CORS but enforces @connect", async () => {
    const body = `
      const root = document.documentElement;
      if (location.pathname === "/b.html") GM_xmlhttpRequest({ url: "${site.origin}/echo", method: "POST", data: "hi", responseType: "json",
        onload: (r) => root.setAttribute("data-xhr", r.response.body), onerror: () => root.setAttribute("data-xhr", "error") });
      if (location.pathname === "/a.html") GM_xmlhttpRequest({ url: "http://blocked.example/",
        onload: () => root.setAttribute("data-xhr", "loaded"), onerror: () => root.setAttribute("data-xhr", "blocked") });
    `;
    await withScript({ grant: ["GM_xmlhttpRequest"], connect: ["127.0.0.1"] }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${other.origin}/b.html`);
      await waitForAttr(page, "data-xhr", "hi");
      await page.goto(`${site.origin}/a.html`);
      await waitForAttr(page, "data-xhr", "blocked");
    });
  });

  it("runs menu commands through the test hook", async () => {
    const body = `GM_registerMenuCommand("Say hi", () => document.documentElement.setAttribute("data-menu", "clicked"));`;
    await withScript({ grant: ["GM_registerMenuCommand"] }, body, async (context, emulator) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/a.html`);
      assert.deepEqual(await emulator.menu(page), ["Say hi"]);
      assert.equal(await emulator.clickMenu(page, "Say hi"), true);
      assert.equal(await readAttr(page, "data-menu"), "clicked");
    });
  });
});
