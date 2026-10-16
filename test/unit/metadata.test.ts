import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readManifest } from "../../src/convert/manifest.ts";
import { namespaceOf, renderMetadata, slugify } from "../../src/convert/metadata.ts";
import { grantsFor } from "../../src/runtime/gm.ts";
import { files, PIXEL } from "../support/extension.ts";

const extension = (manifest: Record<string, unknown>, extra: Record<string, string | Uint8Array> = {}) => {
  const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "My Ext", version: "2.0.1", ...manifest }), ...extra });
  return { model: readManifest(all).model, files: all };
};
const header = (manifest: Record<string, unknown>, extra?: Record<string, string | Uint8Array>) => {
  const { model, files: all } = extension(manifest, extra);
  return renderMetadata(model, all, namespaceOf(model), grantsFor([]));
};
const values = (text: string, key: string) => [...text.matchAll(new RegExp(`^// @${key}(?: +(.*))?$`, "gm"))].map((match) => match[1] ?? "");

describe("slugify and namespaceOf", () => {
  it("makes a lower-case slug", () => assert.equal(slugify("  Réfined GitHub!! v2 "), "r-fined-github-v2"));
  it("falls back to 'extension' for a name with no letters or digits", () => assert.equal(slugify("★★"), "extension"));
  it("prefers the gecko ID", () => {
    assert.equal(namespaceOf(extension({ browser_specific_settings: { gecko: { id: "a@b" } } }).model), "a@b");
    assert.equal(namespaceOf(extension({}).model), "x2u-my-ext");
  });
});

describe("renderMetadata", () => {
  it("writes the identity lines and the core grants", () => {
    const text = header({ description: "Line one\nline two" });
    assert.match(text, /^\/\/ ==UserScript==\n\/\/ @name {9}My Ext\n\/\/ @namespace {4}x2u-my-ext\n\/\/ @version {6}2\.0\.1\n\/\/ @description {2}Line one line two\n/);
    assert.match(text, /\n\/\/ ==\/UserScript==$/);
    assert.deepEqual(values(text, "grant"), ["GM_addElement", "GM_addValueChangeListener", "GM_deleteValue", "GM_getValue", "GM_listValues", "GM_removeValueChangeListener", "GM_setValue"]);
    assert.deepEqual(values(text, "sandbox"), ["DOM"]);
    assert.deepEqual(values(text, "inject-into"), ["content"]);
  });

  it("keeps every value on one line, so nothing it is given can add header lines", () => {
    const { model, files: all } = extension({});
    const text = renderMetadata(model, all, "ns\n// @grant GM_xmlhttpRequest\r\n// @require https://evil.test/x.js", grantsFor([]));
    assert.equal(values(text, "grant").includes("GM_xmlhttpRequest"), false);
    assert.deepEqual(values(text, "require"), []);
    assert.equal(text.split("\n").length, renderMetadata(model, all, "ns", grantsFor([])).split("\n").length, "no extra lines");
  });

  it("matches the union of the groups, maps <all_urls>, and runs everywhere when there are no content scripts", () => {
    const text = header({ content_scripts: [{ matches: ["https://a.test/*", "<all_urls>"] }, { matches: ["https://a.test/*", "https://b.test/*"] }] });
    assert.deepEqual(values(text, "match"), ["https://a.test/*", "*://*/*", "https://b.test/*"]);
    assert.deepEqual(values(header({}), "match"), ["*://*/*"]);
  });

  it("excludes only what every group excludes, and leaves globs to the runtime", () => {
    const text = header({
      content_scripts: [
        { matches: ["https://a.test/*"], exclude_matches: ["https://a.test/x/*", "https://a.test/y/*"], include_globs: ["*a*"] },
        { matches: ["https://b.test/*"], exclude_matches: ["https://a.test/y/*"], exclude_globs: ["*b*"] },
      ],
    });
    assert.deepEqual(values(text, "exclude-match"), ["https://a.test/y/*"]);
    assert.deepEqual([...values(text, "include"), ...values(text, "exclude")], []);
  });

  it("runs at the earliest group's run_at, and adds @noframes unless a group wants frames", () => {
    assert.deepEqual(values(header({ content_scripts: [{ matches: ["<all_urls>"], run_at: "document_end" }, { matches: ["<all_urls>"] }] }), "run-at"), ["document-end"]);
    assert.deepEqual(values(header({ content_scripts: [{ matches: ["<all_urls>"] }] }), "run-at"), ["document-idle"]);
    assert.equal(values(header({ content_scripts: [{ matches: ["<all_urls>"] }] }), "noframes").length, 1);
    assert.equal(values(header({ content_scripts: [{ matches: ["<all_urls>"], all_frames: true }] }), "noframes").length, 0);
  });

  it("adds @connect for each host permission's host, required and optional, and * when any host will do", () => {
    const text = header({ host_permissions: ["https://*.a.test/*", "http://localhost:8080/*", "file:///*"], optional_host_permissions: ["*://b.test/*"] });
    assert.deepEqual(values(text, "connect"), ["a.test", "localhost", "b.test"]);
    assert.deepEqual(values(header({ host_permissions: ["https://a.test/*", "<all_urls>"] }), "connect"), ["*"]);
    assert.deepEqual(values(header({ manifest_version: 2, permissions: ["*://*/*", "tabs"] }), "connect"), ["*"]);
    assert.deepEqual(values(header({}), "connect"), []);
  });

  it("uses the smallest icon of at least 32px, else the largest, as a data URL", () => {
    const icons = { icons: { "16": "i16.png", "48": "i48.png", "128": "i128.svg" } };
    assert.deepEqual(values(header(icons, { "i16.png": PIXEL, "i48.png": PIXEL, "i128.svg": "<svg/>" }), "icon"), [`data:image/png;base64,${btoa(String.fromCharCode(...PIXEL))}`]);
    assert.deepEqual(values(header({ icons: { "16": "i16.png" } }, { "i16.png": PIXEL }), "icon").length, 1);
    assert.deepEqual(values(header({ icons: { "48": "missing.png" } }), "icon"), []);
  });
});
