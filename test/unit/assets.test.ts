import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectAssets, pathGlob } from "../../src/convert/assets.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import { files } from "../support/extension.ts";

const extension = (manifest: Record<string, unknown>, extra: Record<string, string>) => {
  const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1.0", ...manifest }), ...extra });
  return { model: readManifest(all).model, files: all };
};

describe("pathGlob", () => {
  it("matches * across folders, from the extension root", () => {
    assert.equal(pathGlob("img/*").test("img/a/b.png"), true);
    assert.equal(pathGlob("/*.png").test("a.png"), true);
    assert.equal(pathGlob("a.js").test("xa.js"), false);
  });
});

describe("collectAssets", () => {
  it("collects getURL literals in any form, and web_accessible_resources globs", () => {
    const { model, files: all } = extension({ web_accessible_resources: [{ resources: ["fonts/*"], matches: ["<all_urls>"] }] }, {
      "img/a.png": "a", "b.json": "{}", "fonts/x.woff2": "f", "fonts/y.woff2": "f", "other.txt": "",
    });
    const { table, warnings } = collectAssets(model, all, ["/img/a.png", "./b.json?v=1", "missing.js", "../out.js"]);
    assert.deepEqual(Object.keys(table), ["b.json", "fonts/x.woff2", "fonts/y.woff2", "img/a.png"]);
    assert.deepEqual(table["img/a.png"], ["image/png", btoa("a")]);
    assert.equal(table["fonts/x.woff2"][0], "font/woff2");
    assert.deepEqual(warnings, ["runtime.getURL refers to missing.js, which isn't in the extension", 'runtime.getURL("../out.js") points outside the extension']);
  });

  it("rewrites url() in content CSS to placeholders, relative to the CSS file", () => {
    const css = [
      "a { background: url(../img/a.png) }",
      "b { background: url( '/img/b.svg' ) }",
      'c { background: url("chrome-extension://__MSG_@@extension_id__/img/c.gif") }',
      "@font-face { src: url(font.woff2) format('woff2'), url(data:font/woff2;base64,AAAA) }",
      "d { filter: url(#blur); background: url(https://cdn.test/x.png), url(//cdn.test/y.png) }",
      "e { background: url(missing.png) }",
    ].join("\n");
    const { model, files: all } = extension({ content_scripts: [{ matches: ["<all_urls>"], css: ["css/site.css"] }] }, {
      "css/site.css": css, "img/a.png": "", "img/b.svg": "", "img/c.gif": "", "css/font.woff2": "",
    });
    const result = collectAssets(model, all, []);
    assert.deepEqual(result.css, [[
      [
        'a { background: url("x2u-asset:img%2Fa.png") }',
        'b { background: url("x2u-asset:img%2Fb.svg") }',
        'c { background: url("x2u-asset:img%2Fc.gif") }',
        "@font-face { src: url(\"x2u-asset:css%2Ffont.woff2\") format('woff2'), url(data:font/woff2;base64,AAAA) }",
        "d { filter: url(#blur); background: url(https://cdn.test/x.png), url(//cdn.test/y.png) }",
        "e { background: url(missing.png) }",
      ].join("\n"),
    ]]);
    assert.deepEqual(Object.keys(result.table), ["css/font.woff2", "img/a.png", "img/b.svg", "img/c.gif"]);
    assert.deepEqual(result.warnings, ["css/site.css refers to css/missing.png, which isn't in the extension"]);
  });

  it("leaves out --ignore-assets globs, keeping their url() as written", () => {
    const { model, files: all } = extension({ content_scripts: [{ matches: ["<all_urls>"], css: ["a.css"] }], web_accessible_resources: ["big/*"] }, {
      "a.css": "x { background: url(big/huge.png) }", "big/huge.png": "", "big/other.png": "", "small.png": "",
    });
    const result = collectAssets(model, all, ["small.png"], ["big/*"]);
    assert.deepEqual(Object.keys(result.table), ["small.png"]);
    assert.deepEqual(result.css, [["x { background: url(big/huge.png) }"]]);
    assert.deepEqual(result.warnings, []);
  });

  it("warns about a CSS file the manifest lists but the extension lacks", () => {
    const { model, files: all } = extension({ content_scripts: [{ matches: ["<all_urls>"], css: ["gone.css"] }] }, {});
    const result = collectAssets(model, all, []);
    assert.deepEqual(result.css, [[]]);
    assert.deepEqual(result.warnings, ["content_scripts[0].css: gone.css isn't in the extension"]);
  });

  it("leaves source maps out of web_accessible_resources globs, saying so, but keeps one the code names", () => {
    const { model, files: all } = extension({ web_accessible_resources: [{ resources: ["js/*", "*.map"], matches: ["<all_urls>"] }] }, {
      "js/a.js": "a", "js/a.js.map": "{}", "b.js.map": "{}", "c.js.map": "{}",
    });
    const { table, warnings } = collectAssets(model, all, ["c.js.map"]);
    assert.deepEqual(Object.keys(table), ["c.js.map", "js/a.js"]);
    assert.deepEqual(warnings, ["2 source maps (*.map) in web_accessible_resources left out: only developer tools read them"]);
  });
});
