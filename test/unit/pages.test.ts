// Popup and options pages prepared at build time: DOM tree, CSS, code, assets.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assetPlaceholder } from "../../src/convert/assets.ts";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import { bundlePages } from "../../src/convert/pages.ts";
import { files } from "../support/extension.ts";

const extension = (manifest: Record<string, unknown>, extra: Record<string, string>) => {
  const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1.0", ...manifest }), ...extra });
  return { model: readManifest(all).model, files: all };
};

describe("bundlePages", () => {
  it("builds the popup's tree, CSS and code, and turns asset URLs into placeholders", async () => {
    const { model, files: all } = extension({ action: { default_popup: "popup/index.html" } }, {
      "popup/index.html": `<!doctype html><html lang="en"><head><title>Pop</title><link rel="stylesheet" href="pop.css"><style>b { background: url(../img/b.png) }</style>
        <script src="a.js"></script><script src="/lib/b.js"></script><script>inline()</script></head>
        <body class="dark"><img src="../img/a.png" srcset="../img/a.png 1x, ../img/b.png 2x"><a href="../img/a.png">x</a><div style="background:url('../img/b.png')"></div><img src="https://cdn.example/x.png"></body></html>`,
      "popup/pop.css": "i { background: url(i.png) }",
      "popup/i.png": "i", "img/a.png": "a", "img/b.png": "b",
      "popup/a.js": "var a = 1 // no newline",
      "lib/b.js": "b(a)",
    });
    const { pages, warnings } = await bundlePages(model, all);
    assert.equal(pages.length, 1);
    const [{ kind, config, code, assets }] = pages;
    assert.equal(kind, "popup");
    assert.equal(config.path, "popup/index.html");
    assert.equal(config.title, "Pop");
    assert.deepEqual(config.htmlAttributes, [["lang", "en"]]);
    assert.deepEqual(config.bodyAttributes, [["class", "dark"]]);
    assert.deepEqual(config.css, [`i { background: url("${assetPlaceholder("popup/i.png")}") }`, `b { background: url("${assetPlaceholder("img/b.png")}") }`]);
    assert.equal(code, "var a = 1 // no newline\n;\nb(a)");
    const [a, b] = [assetPlaceholder("img/a.png"), assetPlaceholder("img/b.png")];
    assert.deepEqual(config.body, [
      ["img", [["src", a], ["srcset", `${a} 1x, ${b} 2x`]], []],
      ["a", [["href", "../img/a.png"]], ["x"]],
      ["div", [["style", `background:url("${b}")`]], []],
      ["img", [["src", "https://cdn.example/x.png"]], []],
    ]);
    assert.deepEqual(config.head.filter((node) => typeof node !== "string"), [["title", [], ["Pop"]]]);
    assert.deepEqual(assets.sort(), ["img/a.png", "img/b.png", "popup/i.png"]);
    assert.deepEqual(warnings, [
      "popup/index.html: an inline <script> was left out, as an extension page's CSP never runs one",
      "popup/index.html: its images and fonts may not show under Tampermonkey on sites whose CSP limits img-src or font-src",
    ]);
  });

  it("splits a page without <head> or <body> at its first body element, and bundles a module script", async () => {
    const { model, files: all } = extension({ options_ui: { page: "options.html" } }, {
      "options.html": `<meta charset="utf-8"><title>Opts</title><script type="module" src="main.js"></script><h1>Hi</h1><p>there`,
      "main.js": `import { n } from "./n.js"; console.log(n, import.meta.url);`,
      "n.js": "export const n = 1;",
    });
    const { pages } = await bundlePages(model, all, await loadEsbuild());
    const [{ kind, config, code }] = pages;
    assert.equal(kind, "options");
    assert.deepEqual(config.head, [["meta", [["charset", "utf-8"]], []], ["title", [], ["Opts"]]]);
    assert.deepEqual(config.body, [["h1", [], ["Hi"]], ["p", [], ["there"]]]);
    assert.match(code, /__x2uImportMeta\.url/);
    assert.match(code, /\}\)\(\{ url: __x2uBase \+ "main\.js" \}\);$/);
    assert.doesNotMatch(code, /\bimport\b|\bexport\b/);
  });

  it("orders scripts as Chrome runs them, keeps data blocks, and drops inline handlers and links that aren't style sheets", async () => {
    const { model, files: all } = extension({ action: { default_popup: "p.html" } }, {
      "p.html": `<link rel="icon" href="i.png"><script type="module" src="m.js"></script><script defer src="d.js"></script><script src="c.js"></script>
<script type="text/x-template" id="t"><b>{{x}}</b></script><button onclick="go()" ONMOUSEOVER="x()" id="b">go</button>`,
      "i.png": "i", "m.js": "console.log('m')", "d.js": "d()", "c.js": "c()",
    });
    const { pages } = await bundlePages(model, all, await loadEsbuild());
    const [{ config, code, assets }] = pages;
    // Deferred classic scripts and modules run together, in document order, after the others.
    assert.match(code, /^c\(\)\n;\n\(function \(__x2uImportMeta\)[^]*\n;\nd\(\)$/);
    assert.deepEqual(config.head.filter((node) => typeof node !== "string"), [["script", [["type", "text/x-template"], ["id", "t"]], ["<b>{{x}}</b>"]]]);
    assert.deepEqual(config.body, [["button", [["id", "b"]], ["go"]]]);
    assert.deepEqual(assets, []);
  });

  it("puts what lies outside <head> and <body> where a browser does", async () => {
    const { model, files: all } = extension({ action: { default_popup: "p.html" } }, {
      "p.html": `<html><head><title>T</title></head><script src="early.js"></script><body><p>x</p></body>\n<script src="late.js"></script></html><script src="after.js"></script>`,
      "early.js": "early()", "late.js": "late()", "after.js": "after()",
    });
    const { pages, warnings } = await bundlePages(model, all);
    const [{ config, code }] = pages;
    assert.equal(code, "early()\n;\nlate()\n;\nafter()");
    assert.deepEqual(config.body.filter((node) => typeof node !== "string"), [["p", [], ["x"]]]);
    assert.deepEqual(warnings, []);
  });

  it("leaves out a page whose file is missing, and a script or style sheet that isn't in the extension", async () => {
    const { model, files: all } = extension({ action: { default_popup: "gone.html" }, options_page: "o.html" }, {
      "o.html": `<link rel="stylesheet" href="x.css"><script src="https://cdn.example/lib.js"></script><p>o</p>`,
    });
    const { pages, warnings } = await bundlePages(model, all);
    assert.deepEqual(pages.map((page) => page.kind), ["options"]);
    assert.deepEqual(warnings, [
      "manifest.action: gone.html isn't in the extension, so the popup was left out",
      "o.html links x.css, which isn't in the extension, so it was left out",
      "o.html loads https://cdn.example/lib.js, which isn't in the extension, so it was left out",
    ]);
  });
});
