// THROWAWAY spike S1 follow-up: document-start variant matrix (findings "S1 follow-up").
// Usage: npm run script -- spikes/s1-variants/matrix.ts <tm|vm> [csp:<id>,<id>]. Needs the bench profile (npm run bench:setup).
import { launchReal } from "../../bench/real/launch.ts";
import { installUserscript } from "../../bench/real/install.ts";
import { startServer } from "../../test/support/server.ts";
import { GRANTS } from "../../src/runtime/gm.ts";

const manager = process.argv[2] as "tm" | "vm";
const cspIds = (process.argv[3] ?? "").replace(/^csp:/, "").split(",").filter(Boolean);

type Cfg = { id: string; grant: "granted" | "none"; headers: string[] };
const iso = ["@sandbox DOM", "@inject-into content"]; // the S1 baseline, sent to both managers
const variants: Array<[string, string[]]> =
  manager === "tm"
    ? [["iso", iso], ["none", []], ["raw", ["@sandbox raw"]], ["js", ["@sandbox JavaScript"]]]
    : [["iso", iso], ["none", []], ["page", ["@inject-into page"]], ["auto", ["@inject-into auto"]]];
const configs: Cfg[] = (["granted", "none"] as const).flatMap((grant) => variants.map(([v, headers]) => ({ id: `${manager}-${grant === "granted" ? "g" : "n"}-${v}`, grant, headers })));

const ADD = 'document.documentElement.setAttribute("data-x2u-sync", "1"); window.__x2uPageWorld = 1;';
const PROBE = `(function () {
  var d = document, h = d.documentElement;
  var r = { rsAtStart: d.readyState, hasHtml: !!h, t: Math.round(performance.now()) };
  var report = function () { var e = d.documentElement; if (e) e.setAttribute("data-us-report", JSON.stringify(r)); };
  if (h) { r.pageFirstAlreadyRan = h.hasAttribute("data-page-first"); h.setAttribute("data-us-start", d.readyState); }
  try { window.__usGlobal = "us"; } catch (e) { r.setGlobalErr = String(e); }
  r.gmAddElementType = typeof GM_addElement;
  if (typeof GM_addElement === "function" && h) {
    try { GM_addElement(h, "script", { textContent: ${JSON.stringify(ADD)} }); r.addElementSync = h.getAttribute("data-x2u-sync") === "1"; }
    catch (e) { r.addElementError = String(e); }
  }
  report();
  var later = function () { r.seesPageGlobal = "pageGlobal" in window; r.rsLater = d.readyState; report(); };
  if (d.readyState === "complete") setTimeout(later, 300); else window.addEventListener("load", function () { setTimeout(later, 300); });
})();`;

const meta = (cfg: Cfg) =>
  [
    "// ==UserScript==",
    `// @name         x2u variant ${cfg.id}`,
    "// @namespace    x2u-variants",
    "// @version      1.0.0",
    `// @match        ${origin}/v/${cfg.id}*`,
    ...(cfg.grant === "none" ? ["// @grant        none"] : Object.values(GRANTS).flat().map((g) => `// @grant        ${g}`)),
    ...cfg.headers.map((h) => `// ${h}`),
    "// @run-at       document-start",
    "// ==/UserScript==",
  ].join("\n");

const PAGE_FIRST = `var h = document.documentElement;
h.setAttribute("data-page-first", "1");
h.setAttribute("data-page-first-t", String(Math.round(performance.now())));
h.setAttribute("data-page-saw-us", h.getAttribute("data-us-start") === null ? "no" : h.getAttribute("data-us-start"));
h.setAttribute("data-page-saw-sync", h.getAttribute("data-x2u-sync") === null ? "no" : h.getAttribute("data-x2u-sync"));
h.setAttribute("data-page-saw-world", String(window.__x2uPageWorld));
h.setAttribute("data-page-saw-usglobal", String(window.__usGlobal));
window.pageGlobal = "page";`;
const page = (csp: boolean, slow: boolean) => () =>
  new Response(
    `<!doctype html><html><head><title>x</title>${slow ? `<script${csp ? ' nonce="x2u"' : ""} src="/v/slow.js"></script>` : ""}<script${csp ? ' nonce="x2u"' : ""}>${PAGE_FIRST}</script></head><body>x2u</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", ...(csp ? { "content-security-policy": "script-src 'nonce-x2u'" } : {}) } },
  );

const routes: Record<string, () => Response | Promise<Response>> = {
  // a parser-blocking script that takes 600 ms keeps the document in "loading" and the page's own first inline script waiting
  "/v/slow.js": async () => {
    await sleep(600);
    return new Response("/* slow */", { headers: { "content-type": "text/javascript" } });
  },
};
for (const c of configs) {
  routes[`/v/${c.id}.html`] = page(false, false);
  routes[`/v/${c.id}-slow.html`] = page(false, true);
  routes[`/v/${c.id}-csp.html`] = page(true, false);
  routes[`/v/${c.id}-slow-csp.html`] = page(true, true);
}
const site = await startServer(routes);
// X2U_HOST=localhost serves the same pages under a host that the leftover "dbg5" scratch script (@match 127.0.0.1) does not match
const origin = process.env.X2U_HOST ? site.origin.replace("127.0.0.1", process.env.X2U_HOST) : site.origin;

const { context, extensionId } = await launchReal(manager);
const tab0 = context.pages()[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function snapshot(tab: import("playwright").Page) {
  const attrs = await tab.evaluate(() => {
    const h = document.documentElement;
    const get = (n: string) => h.getAttribute(n);
    return {
      us: JSON.parse(get("data-us-report") ?? "null"),
      pageSawUs: get("data-page-saw-us"),
      pageFirstT: get("data-page-first-t"),
      pageSawSync: get("data-page-saw-sync"),
      pageSawWorld: get("data-page-saw-world"),
      pageSawUsGlobal: get("data-page-saw-usglobal"),
      mainUsGlobal: String((window as unknown as Record<string, unknown>).__usGlobal),
      mainPageWorld: String((window as unknown as Record<string, unknown>).__x2uPageWorld),
    };
  });
  return attrs;
}

for (const cfg of configs) {
  if (process.env.ONLY && !process.env.ONLY.split(",").includes(cfg.id)) continue;
  const onlyCsp = cspIds.length > 0;
  if (onlyCsp && !cspIds.includes(cfg.id)) continue;
  const code = `${meta(cfg)}\n${PROBE}\n`;
  await installUserscript(context, extensionId, code);
  const tab = await context.newPage();
  const paths = onlyCsp ? [`/v/${cfg.id}-csp.html`, `/v/${cfg.id}-slow-csp.html`] : [`/v/${cfg.id}.html`, `/v/${cfg.id}-slow.html`];
  for (const path of paths) {
    for (const load of ["first", "reload"]) {
      if (load === "first") await tab.goto(`${origin}${path}`);
      else await tab.reload();
      await sleep(1500);
      console.log(JSON.stringify({ cfg: cfg.id, path, load, ...(await snapshot(tab)) }));
    }
  }
  await tab.close();
}
void tab0;
await context.close();
await site.close();
