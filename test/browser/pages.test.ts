// The popup and options pages end to end (spec §6), on each backend in X2U_BACKENDS (default: the CI emulator).
// Release tier: X2U_BACKENDS=tm,vm with the bench profile from `npm run bench:setup`.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Frame, Page } from "playwright";
import { backendsFromEnv, startSession, type Session } from "../../bench/session.ts";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { convert } from "../../src/convert/index.ts";
import { loadRuntime } from "../../src/convert/runtime-node.ts";
import type { ExtensionFiles } from "../../src/convert/unpack.ts";
import { NO_RECEIVER } from "../../src/runtime/messaging.ts";
import { waitForAttr } from "../support/dom.ts";
import { pagesExtension, popupOnlyExtension } from "../support/extension.ts";
import { startServer, type Server } from "../support/server.ts";
import { sleep } from "../support/time.ts";

const html = (head = "", headers: Record<string, string> = {}) => () =>
  new Response(`<!doctype html><html><head><title>x2u</title>${head}</head><body>page</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

/** The modal's iframe, once it holds `has`. */
async function modalFrame(tab: Page, has: string): Promise<Frame> {
  for (let waited = 0; waited < 10_000; waited += 100) {
    for (const frame of tab.frames()) {
      if (frame !== tab.mainFrame() && !frame.isDetached() && (await frame.locator(has).count().catch(() => 0)) > 0) return frame;
    }
    await sleep(100);
  }
  throw new Error(`no modal frame with ${has}`);
}

async function frameAttr(frame: Frame, selector: string, name: string, expected: string | RegExp): Promise<void> {
  let last: string | null = null;
  for (let waited = 0; waited < 10_000; waited += 100) {
    last = await frame.locator(selector).getAttribute(name);
    if (last !== null && (typeof expected === "string" ? last === expected : expected.test(last))) return;
    await sleep(100);
  }
  throw new Error(`${selector}[${name}] is ${last}, not ${expected}`);
}

async function until(ok: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 100) {
    if (await ok()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A converted extension in a session, and a way to open a test page that has joined the other tabs. */
function harness(backend: (typeof backends)[number], extension: (origin: string) => ExtensionFiles) {
  const state: { site?: Server; session?: Session } = {};
  before(async () => {
    state.site = await startServer({
      "/page.html": html(),
      // A site that hides every element and moves <html> (which moves a fixed element that isn't in the top layer).
      "/hostile.html": html("<style>html > * { display: none !important; } html { transform: translateX(-50px); }</style>"),
      "/style-csp.html": html("", { "content-security-policy": "style-src 'self'; img-src 'self'" }),
      "/trusted-types.html": html("", { "content-security-policy": "require-trusted-types-for 'script'" }),
    });
    const { userscript } = await convert(extension(state.site.origin), { runtime: await loadRuntime(), esbuild: await loadEsbuild() });
    state.session = await startSession(backend, userscript);
  });
  after(async () => {
    await state.session?.close();
    await state.site?.close();
  });
  return {
    session: () => state.session as Session,
    open: async (path: string): Promise<Page> => {
      const tab = await (state.session as Session).context.newPage();
      await tab.goto(`${(state.site as Server).origin}${path}`);
      await waitForAttr(tab, "data-content", "ready");
      // Content scripts run at once; the tab joins the others, and the leader starts its background, a moment later.
      await sleep(1_000);
      return tab;
    },
  };
}

const backends = backendsFromEnv();
for (const backend of backends) {
  describe(`popup and options pages on ${backend}`, () => {
    const { open, session } = harness(backend, pagesExtension);

    it("opens the popup with its shortcut and runs it with its own chrome object, until it closes", async () => {
      const tab = await open("/page.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      // Its scripts ran in order, after the DOM was built, then DOMContentLoaded and load; broken.js threw last.
      await frameAttr(popup, "body", "data-shared", "lib");
      await frameAttr(popup, "body", "data-loaded", "1");
      await frameAttr(popup, "body", "data-load", "1");
      // Its CSS, with images as blob URLs, and its style attribute; the popup is as wide as its body.
      await frameAttr(popup, "body", "data-image", "true");
      assert.equal(await popup.locator("#title").evaluate((title) => getComputedStyle(title).color), "rgb(7, 8, 9)");
      assert.ok((await popup.locator("#logo").evaluate((img: HTMLImageElement) => img.naturalWidth)) > 0);
      assert.equal((await (await popup.frameElement()).boundingBox())?.width, 240);
      // Inline SVG keeps its mixed-case names and its xlink: attributes, which it needs to draw.
      assert.deepEqual(await popup.locator("#icon").evaluate((svg: SVGSVGElement) => [svg.viewBox.baseVal.width, (svg.querySelector("use") as SVGUseElement).href.baseVal]), [10, "#dot"]);
      // Its chrome object: messages to the background and the tab's content script, the button's state in the
      // background, and the background's own global in the tab where it runs.
      await frameAttr(popup, "body", "data-reply", "background saw popup/popup.html");
      await frameAttr(popup, "body", "data-tab-reply", "content ok");
      await waitForAttr(tab, "data-popup-says", "hi");
      await frameAttr(popup, "body", "data-badge", "7");
      await frameAttr(popup, "body", "data-background-page", "object");
      await frameAttr(popup, "body", "data-top", "true");
      // What one script put on window, the next finds by its bare name.
      await frameAttr(popup, "body", "data-lib-api", "lib api");
      // The page has the focus, on its autofocus field, as a Chrome popup does.
      assert.equal(await popup.evaluate(() => document.activeElement?.id), "field");
      assert.equal(await tab.evaluate(() => document.activeElement?.tagName), "DIV");
      // Its URLs don't resolve against the site's: a fragment stays in the page, and so does pushState with one.
      await frameAttr(popup, "body", "data-route", "#/route");
      await popup.locator("#jump").click();
      await sleep(300);
      assert.equal(await popup.locator("#title").count(), 1, "following an in-page link must not load the site in the page's frame");
      // A content script's message reaches the open popup.
      await tab.evaluate(() => document.dispatchEvent(new Event("x2u-ask-pages")));
      await waitForAttr(tab, "data-pages-reply", "popup, asked by a tab");

      await tab.keyboard.press("Escape");
      await until(() => popup.isDetached(), "the popup to close");
      // Its port disconnects, and its listeners are gone: the background listens but doesn't answer this one.
      await waitForAttr(tab, "data-popup-closed", "1");
      await tab.evaluate(() => document.dispatchEvent(new Event("x2u-ask-pages")));
      await waitForAttr(tab, "data-pages-reply", "undefined");
      await tab.close();
    });

    it("forgets the listeners and ports a page sets up after it has closed", async () => {
      const tab = await open("/page.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      await tab.keyboard.press("Escape");
      await until(() => popup.isDetached(), "the popup to close");
      // The popup's slow message is answered a second after it was sent, when the popup has gone.
      await sleep(2_000);
      await tab.evaluate(() => document.dispatchEvent(new Event("x2u-ask-late")));
      await waitForAttr(tab, "data-late-ports", "0");
      // The popup opened again answers for itself, not the closed one's late listener.
      await tab.keyboard.press("Alt+Shift+P");
      const again = await modalFrame(tab, "#title");
      await frameAttr(again, "body", "data-reply", "background saw popup/popup.html");
      await tab.evaluate(() => document.dispatchEvent(new Event("x2u-ask-pages")));
      await waitForAttr(tab, "data-pages-reply", "popup, asked by a tab");
      await tab.close();
    });

    it("opens one popup however often it is asked, and runs it in a tab that doesn't lead", async () => {
      const leader = await open("/page.html");
      const tab = await open("/page.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      await tab.keyboard.press("Alt+Shift+P");
      await frameAttr(popup, "body", "data-reply", "background saw popup/popup.html");
      await frameAttr(popup, "body", "data-background-page", "elsewhere");
      assert.equal(tab.frames().filter((frame) => frame !== tab.mainFrame()).length, 1);
      assert.equal(popup.isDetached(), false);
      await tab.close();
      await leader.close();
    });

    it("shows the modal over a site that hides every element, moves <html> and covers itself with an overlay", async () => {
      const tab = await open("/hostile.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      await frameAttr(popup, "body", "data-load", "1");
      await tab.evaluate(() => {
        const cover = document.createElement("div");
        cover.style.cssText = "position: fixed; inset: 0; z-index: 2147483647; display: block !important; background: red;";
        document.documentElement.append(cover);
      });
      const box = await (await popup.frameElement()).boundingBox();
      const width = tab.viewportSize()?.width ?? 0;
      assert.ok(box && box.width === 240 && box.x + box.width <= width && box.x + box.width >= width - 20, `the popup sits at the top right: ${JSON.stringify(box)}`);
      // What the user sees at the popup's centre is the modal's host, not the site's overlay.
      const onTop = await tab.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.style.background, [box.x + box.width / 2, box.y + box.height / 2]);
      assert.equal(onTop, "transparent");
      await tab.close();
    });

    it("applies the page's CSS on a site whose CSP blocks inline styles", { skip: backend === "emulator" ? "the emulator's addElement doesn't get past a page's CSP" : false }, async () => {
      const tab = await open("/style-csp.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      await frameAttr(popup, "body", "data-load", "1");
      assert.equal(await popup.locator("body").evaluate((body) => getComputedStyle(body).width), "240px");
      assert.equal(await popup.locator("#title").evaluate((title) => getComputedStyle(title).color), "rgb(7, 8, 9)");
      await tab.close();
    });

    it("lets the popup write HTML on a site that enforces Trusted Types, and runs none of its inline handlers", async () => {
      const tab = await open("/trusted-types.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      await frameAttr(popup, "body", "data-load", "1");
      const body = popup.locator("body");
      assert.deepEqual([await body.getAttribute("data-sink"), await body.getAttribute("data-parsed"), await body.getAttribute("data-adjacent")], ["B", "I", "U"]);
      await sleep(500);
      assert.equal(await body.getAttribute("data-inline"), null);
      await tab.close();
    });

    it("moves from the popup to the options page, which shares localStorage and gives each module its own import.meta.url", async () => {
      const tab = await open("/page.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#title");
      await popup.locator("#options").click();
      const options = await modalFrame(tab, "#seen");
      await until(() => popup.isDetached(), "the popup to close");
      await until(async () => (await options.locator("#seen").textContent()) === "seen:popup", "the options page to read localStorage");
      await frameAttr(options, "body", "data-meta", /^chrome-extension:\/\/[a-p]{32}\/options\.js$/);
      // A page without an autofocus field has the focus too, so typing goes to it, not the site.
      assert.equal(await tab.evaluate(() => document.activeElement?.tagName), "DIV");
      await tab.close();
    });

    it("opens the popup from the background with action.openPopup", async () => {
      const tab = await open("/page.html");
      await tab.evaluate(() => document.dispatchEvent(new Event("x2u-open-popup")));
      await waitForAttr(tab, "data-open-popup", "opened");
      await modalFrame(tab, "#title");
      await tab.close();
    });

    it("opens the pages from their menu commands, on the emulator", { skip: backend !== "emulator" }, async () => {
      const tab = await open("/page.html");
      const emulator = session().emulator;
      assert.ok(emulator);
      await until(async () => (await emulator.menu(tab)).length === 2, "two menu commands");
      assert.deepEqual((await emulator.menu(tab)).map((caption) => caption.replace(/ \(\d+\)$/, "")).sort(), ["Open Pages", "Pages Sample options"]);
      assert.equal(await emulator.clickMenu(tab, "Pages Sample options"), true);
      await modalFrame(tab, "#seen");
      await tab.close();
    });
  });

  describe(`a popup without a background on ${backend}`, () => {
    const { open } = harness(backend, popupOnlyExtension);

    it("keeps the popup's badge on the leader, and its message for the background has no receiver", async () => {
      const tab = await open("/page.html");
      await tab.keyboard.press("Alt+Shift+P");
      const popup = await modalFrame(tab, "#out");
      await frameAttr(popup, "#out", "data-badge", "1");
      await frameAttr(popup, "#out", "data-send", NO_RECEIVER);
      await tab.close();
    });
  });
}
