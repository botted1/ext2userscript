// Converted extensions end to end, on each backend in X2U_BACKENDS (default: the CI emulator): content scripts, and a
// background that runs on the leader tab. Release tier: X2U_BACKENDS=tm,vm with the bench profile from `npm run bench:setup`.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { backendsFromEnv, startSession, type Session } from "../../bench/session.ts";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { convert } from "../../src/convert/index.ts";
import { loadRuntime } from "../../src/convert/runtime-node.ts";
import type { ExtensionFiles } from "../../src/convert/unpack.ts";
import { readAttr, waitForAttr } from "../support/dom.ts";
import { apiExtension, backgroundExtension, moduleBackgroundExtension, networkExtension, sampleExtension } from "../support/extension.ts";
import { startServer, type Server } from "../support/server.ts";
import { sleep } from "../support/time.ts";

const html = (body: string, head = "") => () =>
  new Response(`<!doctype html><html><head><title>x2u</title>${head}</head><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
const page = html('<div class="x2u-box">box</div>', "<script>window.pageValue = 42;</script>");
/** A page whose CSP lets it connect only to its own origin, as GitHub's does to its own hosts. */
const connectStrictPage = async () => {
  const response = page();
  response.headers.set("content-security-policy", "connect-src 'self'");
  return response;
};
/** A page whose CSP forbids eval (and inline scripts), as many sites' do. */
const strictPage = async () => {
  const response = page();
  response.headers.set("content-security-policy", "script-src 'self'; object-src 'none'");
  return response;
};

/** Polls an attribute on any element (a frame's <html>, say) until it satisfies ok, for up to 10 s. */
async function attrUntil(element: Locator, name: string, ok: (value: string | null) => boolean): Promise<string | null> {
  let value = await element.getAttribute(name);
  for (let waited = 0; !ok(value) && waited < 10_000; waited += 100) {
    await sleep(100);
    value = await element.getAttribute(name);
  }
  return value;
}

/** One converted extension in one session, with the test pages served next to it. */
function harness(backend: (typeof backends)[number], extension: (origin: string) => ExtensionFiles) {
  const state: { site?: Server; session?: Session } = {};
  before(async () => {
    state.site = await startServer({
      "/page.html": page,
      "/writer.html": page,
      "/excluded.html": page,
      "/glob-yes.html": page,
      "/framed.html": html('<iframe src="/child.html"></iframe>'),
      "/child.html": html("child"),
      "/strict.html": strictPage,
      "/connect-strict.html": connectStrictPage,
      "/api.json": () => Response.json({ from: "api" }),
      "/same.json": () => Response.json({ from: "same" }),
      "/based.html": html("based", '<base href="/base/">'),
      "/relative.json": () => Response.json({ from: "root" }),
      "/base/relative.json": () => Response.json({ from: "base" }),
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
      return tab;
    },
  };
}

const backends = backendsFromEnv();
for (const backend of backends) {
  describe(`converted content scripts on ${backend}`, () => {
    const { open } = harness(backend, sampleExtension);

    it("runs isolated, MAIN-world and document_start groups with their chrome APIs, despite a failing group", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-content", "lib"); // lib.js passed webextension-polyfill's globalThis.chrome check
      assert.equal(await readAttr(tab, "data-greeting"), "Hello x2u");
      await waitForAttr(tab, "data-stored", "1");
      await waitForAttr(tab, "data-info", "sample");
      await waitForAttr(tab, "data-main", "42");
      assert.match((await readAttr(tab, "data-start")) ?? "", /^(loading|interactive|complete)$/);
      assert.equal(await readAttr(tab, "data-glob"), null);
      // This extension has no background, so a message to it fails at once, as in Chrome.
      await waitForAttr(tab, "data-send-error", "Could not establish connection. Receiving end does not exist.");
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

  describe(`background on ${backend}`, () => {
    const { session, open } = harness(backend, backgroundExtension);

    it("answers content scripts: replies, ports, tabs.sendMessage and onInstalled", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-reply", "X2U@number");
      await waitForAttr(tab, "data-port", "42");
      await waitForAttr(tab, "data-pong", "background");
      await waitForAttr(tab, "data-installed", "install");
      await waitForAttr(tab, "data-constant", "install");
    });

    it("answers a frame's content scripts", async () => {
      const child = (await open("/framed.html")).frameLocator("iframe").locator("html");
      assert.equal(await attrUntil(child, "data-reply", (value) => value !== null), "X2U@number");
    });

    it("moves the background to another tab when the leader closes", async () => {
      // Every earlier tab closes, so the oldest of these two leads, then hands over when it closes.
      for (const tab of session().context.pages()) await tab.close({ runBeforeUnload: true });
      const first = await open("/page.html");
      await waitForAttr(first, "data-reply", "X2U@number");
      const second = await open("/page.html");
      await waitForAttr(second, "data-reply", "X2U@number");
      await first.close({ runBeforeUnload: true });
      const third = await open("/page.html");
      await waitForAttr(third, "data-reply", "X2U@number", 15_000);
    });
  });

  describe(`module background on ${backend}`, () => {
    const { open } = harness(backend, moduleBackgroundExtension);

    it("bundles the service worker's imports and gives it import.meta.url", async () => {
      await waitForAttr(await open("/page.html"), "data-module", "module:/bg/icon.png");
    });
  });

  describe(`network on ${backend}`, () => {
    const { open, session } = harness(backend, networkExtension);

    it("fetches from another origin the host permissions cover, in the background and content scripts, and its own files", async () => {
      const tab = await open("/page.html");
      // A service worker has no XMLHttpRequest, as in Chrome.
      await waitForAttr(tab, "data-background", "api|config|undefined");
      await waitForAttr(tab, "data-fetch", "api");
      await waitForAttr(tab, "data-xhr", "api:200");
      await waitForAttr(tab, "data-same", "same");
    });

    it("reaches a permitted host from a page whose CSP allows connections only to itself", async () => {
      const tab = await open("/connect-strict.html");
      await waitForAttr(tab, "data-fetch", "api");
      await waitForAttr(tab, "data-xhr", "api:200");
      await waitForAttr(tab, "data-same", "same");
    });

    it("loads the background's own files when its tab's CSP allows connections only to itself", async () => {
      // Every earlier tab closes, so the background runs on this one.
      for (const tab of session().context.pages()) await tab.close({ runBeforeUnload: true });
      await waitForAttr(await open("/connect-strict.html"), "data-background", "api|config|undefined");
    });

    it("resolves a content script's relative URL against the page's <base href>, as the page's own requests do", async () => {
      await waitForAttr(await open("/based.html"), "data-relative", "base");
    });
  });

  describe(`extension APIs on ${backend}`, () => {
    const { open, session } = harness(backend, apiExtension);

    it("runs scripting, alarms, permissions, windows, notifications, cookies and getBackgroundPage", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-inject-title", "x2u");
      await waitForAttr(tab, "data-injected", "yes");
      await waitForAttr(tab, "data-file", "string");
      assert.equal(await tab.locator(".x2u-box").evaluate((box) => getComputedStyle(box).borderTopColor), "rgb(4, 5, 6)");
      await waitForAttr(tab, "data-apis", "true/false|1:true|hello|true|run-it");
      await waitForAttr(tab, "data-alarm", "soon");
      await waitForAttr(tab, "data-cookie", "baked");
    });

    // The emulator's addElement doesn't get past the page's CSP as the managers' does (spec §10.2), so this runs on them only.
    it("runs executeScript's function on a page whose CSP forbids eval, in the page's world if it must", { skip: backend === "emulator" }, async () => {
      const tab = await open("/strict.html");
      await waitForAttr(tab, "data-inject-title", "x2u");
      await waitForAttr(tab, "data-injected", "yes");
      await waitForAttr(tab, "data-file", "string");
    });

    it("hears the manifest's shortcut on the page", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-inject-title", "x2u");
      await tab.keyboard.press("Alt+Shift+K");
      await waitForAttr(tab, "data-command", "run-it");
    });

    it("shows context-menu items and the toolbar button as menu commands, and notifications, on the emulator", { skip: backend !== "emulator" }, async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-inject-title", "x2u");
      const emulator = session().emulator;
      assert.ok(emulator);
      for (let tries = 0; tries < 50 && (await emulator.menu(tab)).length < 2; tries++) await sleep(100);
      assert.deepEqual((await emulator.menu(tab)).sort(), ["Click API Sample", "Say hello"]);
      assert.equal(await emulator.clickMenu(tab, "Say hello"), true);
      await waitForAttr(tab, "data-menu", "say");
      assert.equal(await emulator.clickMenu(tab, "Click API Sample"), true);
      await waitForAttr(tab, "data-action", "clicked");
      const shown = (await Promise.all(session().context.pages().map((page) => emulator.notifications(page)))).flat();
      assert.ok(shown.some((notification) => notification.title === "Hi" && notification.text === "There"));
    });
  });
}
