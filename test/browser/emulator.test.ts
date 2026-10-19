import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { installEmulator, type Emulator } from "../../bench/emulator/index.ts";
import { GRANTS } from "../../src/runtime/gm.ts";
import { readAttr, waitForAttr, waitForJson } from "../support/dom.ts";
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
      // YouTube's rule: scripts need Trusted Types.
      "/tt.html": () => new Response("<!doctype html><title>t</title>", { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "require-trusted-types-for 'script'" } }),
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

  it("puts a GM_addElement script into a page that requires Trusted Types, as the managers do", async () => {
    const body = `GM_addElement(document.head, "script", { textContent: "document.documentElement.dataset.ran = 'yes'" });`;
    await withScript({ grant: ["GM_addElement"], runAt: "document-end" }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/tt.html`);
      await waitForAttr(page, "data-ran", "yes");
    });
  });

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
      // b has the change, so Node has already sent it to every frame it sends it to. The evaluate() below uses the same
      // channel as any echo to a, so it returns only after an echo has landed. a's listener must still show just its own
      // local event: a write is not echoed back to the page that made it.
      await a.evaluate(() => 0);
      assert.equal(await readAttr(a, "data-change"), JSON.stringify({ newValue: { n: 1 }, remote: false }));
      const c = await context.newPage();
      await c.goto(`${other.origin}/b.html`);
      await waitForAttr(c, "data-initial", JSON.stringify({ n: 1 }));
    });
  });

  // A page that reloads while another keeps writing has frames with no document. Writes aimed at them wait for the next
  // document, whose snapshot may already hold them. Each counter value must reach the reader once, in order.
  it("does not deliver a write that the reloaded page's snapshot already holds", async () => {
    const body = `
      if (location.pathname === "/a.html") {
        let n = 0;
        setInterval(() => GM_setValue("counter", ++n), 2);
      } else {
        GM_addValueChangeListener("counter", (key, oldValue, newValue, remote) => window.__record(JSON.stringify({ oldValue, newValue, remote })));
      }
    `;
    await withScript({ grant: ["GM_setValue", "GM_addValueChangeListener"] }, body, async (context) => {
      const events: Array<{ oldValue?: number; newValue: number; remote: boolean }> = [];
      await context.exposeFunction("__record", (json: string) => {
        events.push(JSON.parse(json));
      });
      const writer = await context.newPage();
      await writer.goto(`${site.origin}/a.html`);
      const reader = await context.newPage();
      await reader.goto(`${other.origin}/b.html`);
      // About 0.8s in all. The pause lets each document receive some writes of its own between the reloads.
      for (let reload = 0; reload < 40; reload++) {
        await reader.reload();
        await reader.waitForTimeout(10);
      }

      assert.ok(events.length >= 20, `only ${events.length} writes reached the reader, so this proves nothing`);
      const bad = events.filter((event) => !event.remote || event.newValue <= (event.oldValue ?? 0));
      assert.deepEqual(bad.slice(0, 5), [], `${bad.length} of ${events.length} deliveries repeated or went back to an earlier value`);
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

  it("provides every function in gm.ts's grant table", async () => {
    const names = Object.values(GRANTS).flat();
    const body = `document.documentElement.setAttribute("data-types", JSON.stringify({ ${names.map((name) => `${name}: typeof ${name}`).join(", ")} }));`;
    await withScript({ grant: names }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/a.html`);
      const types = await waitForJson<Record<string, string>>(page, "data-types");
      const missing = names.filter((name) => types[name] !== "function" && types[name] !== "object");
      assert.deepEqual(missing, [], `granted but not provided by the emulator: ${missing.join(", ")}`);
    });
  });

  it("GM_xmlhttpRequest skips CORS", async () => {
    const body = `
      const root = document.documentElement;
      GM_xmlhttpRequest({ url: "${site.origin}/echo", method: "POST", data: "hi", responseType: "json",
        onload: (r) => root.setAttribute("data-xhr", r.response.body), onerror: (r) => root.setAttribute("data-xhr", "error: " + r.error) });
    `;
    await withScript({ grant: ["GM_xmlhttpRequest"], connect: ["127.0.0.1"] }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${other.origin}/b.html`);
      await waitForAttr(page, "data-xhr", "hi");
    });
  });

  // A page on 127.0.0.1 asks for localhost: a different host that is just as reachable, so only @connect decides.
  // The denial is told apart from a network failure by its message.
  it("GM_xmlhttpRequest enforces @connect for other hosts", async () => {
    const body = `
      const root = document.documentElement;
      GM_xmlhttpRequest({ url: "http://localhost:${site.port}/echo", method: "POST", data: "hi", responseType: "json",
        onload: (r) => root.setAttribute("data-xhr", r.response.body), onerror: (r) => root.setAttribute("data-xhr", "error: " + r.error) });
    `;
    const denied = "error: @connect does not allow localhost";
    const cases: Array<[connect: string[], expected: string]> = [
      [[], denied],
      [["127.0.0.1"], denied],
      [["localhost"], "hi"],
      [["*"], "hi"],
    ];
    for (const [connect, expected] of cases) {
      await withScript({ grant: ["GM_xmlhttpRequest"], connect }, body, async (context) => {
        const page = await context.newPage();
        await page.goto(`${site.origin}/a.html`);
        await waitForAttr(page, "data-xhr", expected);
      });
    }
  });

  it("GM_xmlhttpRequest sends a URLSearchParams body as form text", async () => {
    const body = `
      const root = document.documentElement;
      GM_xmlhttpRequest({ url: "${site.origin}/echo", method: "POST", data: new URLSearchParams({ a: "1", b: "x y" }), responseType: "json",
        onload: (r) => root.setAttribute("data-form", r.response.body), onerror: (r) => root.setAttribute("data-form", "error: " + r.error) });
    `;
    await withScript({ grant: ["GM_xmlhttpRequest"] }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/a.html`);
      await waitForAttr(page, "data-form", "a=1&b=x+y");
    });
  });

  it("GM_xmlhttpRequest throws for a body it cannot send instead of dropping it", async () => {
    const body = `
      const root = document.documentElement;
      try {
        GM_xmlhttpRequest({ url: "${site.origin}/echo", method: "POST", data: new ArrayBuffer(4), onload() {}, onerror() {} });
        root.setAttribute("data-thrown", "no throw");
      } catch (error) {
        root.setAttribute("data-thrown", error.name + ": " + error.message);
      }
    `;
    await withScript({ grant: ["GM_xmlhttpRequest"] }, body, async (context) => {
      const page = await context.newPage();
      await page.goto(`${site.origin}/a.html`);
      assert.equal(await readAttr(page, "data-thrown"), "TypeError: emulator: GM_xmlhttpRequest data of type ArrayBuffer is not supported");
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
