import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { convert, inspect } from "../../src/convert/index.ts";
import { plainExtension, sampleExtension } from "../support/extension.ts";

const origin = "http://127.0.0.1:4567";
/** A stand-in for the built runtime: convert() only embeds it. */
const runtime = "var __x2uRuntime = { start() {} };";

describe("convert", () => {
  it("writes the header, the runtime and the content groups", async () => {
    const { userscript } = await convert(sampleExtension(origin), { runtime });
    const header = userscript.slice(0, userscript.indexOf("// ==/UserScript==") + "// ==/UserScript==".length);
    assert.match(header, /^\/\/ ==UserScript==\n\/\/ @name {9}Sample Extension\n/);
    assert.match(header, /\n\/\/ @match {8}http:\/\/127\.0\.0\.1:4567\/\*\n/);
    assert.match(header, /\n\/\/ @run-at {7}document-start\n/);
    assert.doesNotMatch(header, /@noframes/); // one group has all_frames
    assert.doesNotMatch(header, /@exclude-match/); // only one group excludes it
    assert.match(userscript, /__x2uRuntime\.start\(/);
    assert.match(userscript, /function \(chrome, browser\) \{\nreturn function \(\) \{\nif \(!globalThis\.chrome/);
    assert.match(userscript, /"document\.documentElement\.dataset\.main = String\(window\.pageValue\);"/); // the MAIN group, as text
    assert.doesNotThrow(() => new Function(userscript), "the userscript parses");
  });

  it("puts referenced files and web_accessible_resources in the asset table, and nothing else", async () => {
    const { userscript } = await convert(sampleExtension(origin), { runtime });
    const config = JSON.parse(/__x2uRuntime\.start\((\{.*?\}), \[\n/s.exec(userscript)?.[1] ?? "{}");
    assert.deepEqual(Object.keys(config.assets), ["data/info.json", "img/dot.png", "inject.js"]);
    assert.equal(config.assets["img/dot.png"][0], "image/png");
    assert.deepEqual(config.groups[0].css, ['.x2u-box { color: rgb(1, 2, 3); background-image: url("x2u-asset:img%2Fdot.png"); }']);
    assert.deepEqual(Object.keys(config.locales).sort(), ["en", "fr"]);
  });

  it("leaves --ignore-assets files out", async () => {
    const { userscript } = await convert(sampleExtension(origin), { runtime, ignoreAssets: ["data/*", "*.png"] });
    const config = JSON.parse(/__x2uRuntime\.start\((\{.*?\}), \[\n/s.exec(userscript)?.[1] ?? "{}");
    assert.deepEqual(Object.keys(config.assets), ["inject.js"]);
    assert.deepEqual(config.groups[0].css, [".x2u-box { color: rgb(1, 2, 3); background-image: url(img/dot.png); }"], "an ignored file's url() stays as written");
  });

  it("minifies with esbuild and keeps the header", async () => {
    const options = { runtime, esbuild: await loadEsbuild() };
    const plain = await convert(sampleExtension(origin), options);
    const minified = await convert(sampleExtension(origin), { ...options, minify: true });
    assert.match(minified.userscript, /^\/\/ ==UserScript==[\s\S]*\/\/ ==\/UserScript==\n/);
    assert.ok(minified.userscript.length < plain.userscript.length);
    assert.doesNotThrow(() => new Function(minified.userscript));
  });

  it("uses the store's ID, else one derived from the manifest key, else the gecko ID, for chrome.runtime.id", async () => {
    const withId = await convert(plainExtension(), { runtime, extensionId: "abcdefghijklmnopabcdefghijklmnop" });
    assert.equal(withId.report.extension.id, "abcdefghijklmnopabcdefghijklmnop");
    const derived = (await convert(plainExtension(), { runtime })).report.extension.id;
    assert.match(derived ?? "", /^[a-p]{32}$/);
    assert.equal((await convert(plainExtension(), { runtime })).report.extension.id, derived, "the same input gives the same ID");
  });
});

describe("inspect", () => {
  it("reports the sample as unlikely, naming what it uses", async () => {
    const report = await inspect(sampleExtension(origin));
    assert.equal(report.verdict, "unlikely");
    assert.deepEqual(report.extension, { name: "Sample Extension", version: "1.2.3", manifestVersion: 3, id: report.extension.id });
    const bySubject = Object.fromEntries(report.entries.map((entry) => [entry.subject, entry.status]));
    assert.deepEqual(bySubject, {
      "chrome.runtime.sendMessage": "unsupported",
      "manifest.content_scripts.run_at": "partial",
      "chrome.i18n.getMessage": "supported",
      "chrome.runtime.getURL": "supported",
      "chrome.runtime.id": "supported",
      "chrome.storage.local": "supported",
      "chrome.storage.onChanged": "supported",
    });
    assert.deepEqual(report.entries.map((entry) => entry.status), ["unsupported", "partial", "supported", "supported", "supported", "supported", "supported"]);
    assert.deepEqual(report.warnings, []);
  });

  it("reports a plain content-script extension as likely-works", async () => {
    assert.equal((await inspect(plainExtension())).verdict, "likely-works");
  });
});
