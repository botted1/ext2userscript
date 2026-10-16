import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc, readManifest } from "../../src/convert/manifest.ts";
import { files } from "../support/extension.ts";

const read = (manifest: unknown, extra: Record<string, string> = {}, locale?: string) =>
  readManifest(files({ "manifest.json": typeof manifest === "string" ? manifest : JSON.stringify(manifest), ...extra }), { locale });

const mv3 = { manifest_version: 3, name: "Ext", version: "1.0" };

describe("parseJsonc", () => {
  it("accepts comments and a byte-order mark, and leaves comment-like text in strings alone", () => {
    assert.deepEqual(parseJsonc('﻿{ // note\n "a": "http://x/*", /* block */ "b": "/* no */" }'), { a: "http://x/*", b: "/* no */" });
  });

  it("handles escaped quotes inside strings", () => assert.deepEqual(parseJsonc('{"a": "say \\"hi\\" // still a string"}'), { a: 'say "hi" // still a string' }));
});

describe("readManifest", () => {
  it("normalises MV3 content scripts with Chrome's defaults", () => {
    const { model } = read({ ...mv3, content_scripts: [{ matches: ["https://a.test/*"], js: ["/js/a.js", "./b.js"] }] });
    assert.deepEqual(model.contentScripts, [
      { matches: ["https://a.test/*"], excludeMatches: [], includeGlobs: [], excludeGlobs: [], js: ["js/a.js", "b.js"], css: [], runAt: "document_idle", allFrames: false, matchAboutBlank: false, world: "ISOLATED" },
    ]);
  });

  it("reads every kind of background, popup and options page", () => {
    assert.deepEqual(read({ ...mv3, background: { service_worker: "sw.js", type: "module" } }).model.background, { kind: "worker", entry: "sw.js", module: true });
    assert.deepEqual(read({ ...mv3, manifest_version: 2, background: { scripts: ["a.js", "b.js"] } }).model.background, { kind: "scripts", files: ["a.js", "b.js"] });
    assert.deepEqual(read({ ...mv3, manifest_version: 2, background: { page: "bg.html" } }).model.background, { kind: "page", html: "bg.html" });
    assert.deepEqual(read({ ...mv3, action: { default_popup: "popup.html" } }).model.popup, { key: "action", page: "popup.html" });
    assert.deepEqual(read({ ...mv3, manifest_version: 2, browser_action: { default_popup: "p.html" } }).model.popup, { key: "browser_action", page: "p.html" });
    assert.deepEqual(read({ ...mv3, options_ui: { page: "o.html" } }).model.options, { key: "options_ui", page: "o.html" });
    assert.deepEqual(read({ ...mv3, options_page: "o.html" }).model.options, { key: "options_page", page: "o.html" });
  });

  it("splits permissions into API names and host patterns, from MV2 and MV3, required and optional", () => {
    const mv2 = read({ ...mv3, manifest_version: 2, permissions: ["storage", "https://a.test/*", "<all_urls>", { fileSystem: ["write"] }], optional_permissions: ["cookies", "*://b.test/*"] }).model;
    assert.deepEqual([mv2.permissions, mv2.hostPermissions, mv2.optionalPermissions, mv2.optionalHostPermissions], [["storage"], ["https://a.test/*", "<all_urls>"], ["cookies"], ["*://b.test/*"]]);
    const v3 = read({ ...mv3, permissions: ["alarms"], host_permissions: ["https://c.test/*"], optional_host_permissions: ["https://d.test/*"] }).model;
    assert.deepEqual([v3.permissions, v3.hostPermissions, v3.optionalPermissions, v3.optionalHostPermissions], [["alarms"], ["https://c.test/*"], [], ["https://d.test/*"]]);
  });

  it("reads keyboard shortcuts and the toolbar button, resolving __MSG_x__ in their text", () => {
    const { model } = read(
      {
        ...mv3,
        default_locale: "en",
        action: { default_title: "__MSG_title__" },
        commands: { "toggle": { suggested_key: { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" }, description: "__MSG_toggle__" }, "_execute_action": { suggested_key: "Alt+Shift+P" }, "bad": 1 },
      },
      { "_locales/en/messages.json": JSON.stringify({ title: { message: "Click me" }, toggle: { message: "Toggle it" } }) },
    );
    assert.deepEqual(model.action, { key: "action", title: "Click me" });
    assert.deepEqual(model.commands, { toggle: { description: "Toggle it", keys: { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" } }, _execute_action: { keys: { default: "Alt+Shift+P" } } });
    assert.deepEqual(read({ ...mv3, manifest_version: 2, page_action: {} }).model.action, { key: "page_action" });
    assert.equal(read(mv3).model.action, undefined);
  });

  it("flattens web_accessible_resources from MV2 and MV3", () => {
    assert.deepEqual(read({ ...mv3, web_accessible_resources: [{ resources: ["/img/*", "a.js"], matches: ["<all_urls>"] }] }).model.webAccessibleResources, ["img/*", "a.js"]);
    assert.deepEqual(read({ ...mv3, manifest_version: 2, web_accessible_resources: ["x.png"] }).model.webAccessibleResources, ["x.png"]);
  });

  it("resolves __MSG_x__ in the name and description, ignoring case, with the default locale", () => {
    const { model } = read({ ...mv3, name: "__MSG_appName__", description: "__MSG_DESC__ v2", default_locale: "en" }, {
      "_locales/en/messages.json": JSON.stringify({ AppName: { message: "My App" }, desc: { message: "Does things" } }),
      "_locales/de/messages.json": JSON.stringify({ appName: { message: "Meine App" } }),
    });
    assert.equal(model.name, "My App");
    assert.equal(model.description, "Does things v2");
    assert.equal(model.locale, "en");
    assert.deepEqual(Object.keys(model.locales).sort(), ["de", "en"]);
    assert.deepEqual(model.locales.en, { appname: { message: "My App" }, desc: { message: "Does things" } });
  });

  it("resolves against --locale, matching its base language, and falls back to the default per message", () => {
    const locales = {
      "_locales/en/messages.json": JSON.stringify({ appName: { message: "My App" }, desc: { message: "Does things" } }),
      "_locales/pt_BR/messages.json": JSON.stringify({ appName: { message: "Meu App" } }),
    };
    const { model, warnings } = read({ ...mv3, name: "__MSG_appName__", description: "__MSG_desc__", default_locale: "en" }, locales, "pt-br");
    assert.equal(model.name, "Meu App");
    assert.equal(model.description, "Does things");
    assert.equal(model.locale, "pt_BR");
    assert.deepEqual(warnings, []);
  });

  it("warns about an unknown --locale, a missing message and a broken messages.json", () => {
    const { model, warnings } = read({ ...mv3, name: "__MSG_nope__", default_locale: "en" }, {
      "_locales/en/messages.json": "{}",
      "_locales/fr/messages.json": "{ broken",
    }, "ja");
    assert.equal(model.name, "__MSG_nope__");
    assert.equal(warnings.length, 3);
    assert.match(warnings.join("\n"), /--locale ja: the extension has no such locale/);
    assert.match(warnings.join("\n"), /__MSG_nope__ isn't in _locales/);
    assert.match(warnings.join("\n"), /_locales\/fr\/messages\.json isn't valid JSON/);
  });

  it("ignores a gecko ID Firefox wouldn't accept, with a warning", () => {
    const { model, warnings } = read({ ...mv3, browser_specific_settings: { gecko: { id: "evil@x\n// @grant GM_xmlhttpRequest" } } });
    assert.equal(model.geckoId, undefined);
    assert.deepEqual(warnings, ["browser_specific_settings.gecko.id isn't a valid add-on ID, so it was ignored"]);
    const guid = "{12345678-1234-1234-1234-123456789abc}";
    assert.equal(read({ ...mv3, browser_specific_settings: { gecko: { id: guid } } }).model.geckoId, guid);
  });

  it("reads the gecko ID from browser_specific_settings or applications", () => {
    assert.equal(read({ ...mv3, browser_specific_settings: { gecko: { id: "x@y" } } }).model.geckoId, "x@y");
    assert.equal(read({ ...mv3, manifest_version: 2, applications: { gecko: { id: "a@b" } } }).model.geckoId, "a@b");
  });

  it("refuses a manifest Chrome would refuse, naming the key", () => {
    assert.throws(() => read("{ nope"), /^Error: Invalid manifest\.json: /);
    assert.throws(() => read({ ...mv3, manifest_version: 4 }), /manifest_version must be 2 or 3 \(got 4\)/);
    assert.throws(() => read({ manifest_version: 3, version: "1" }), /name is required/);
    assert.throws(() => read({ manifest_version: 3, name: "x" }), /version is required/);
    assert.throws(() => read({ ...mv3 }, { "_locales/en/messages.json": "{}" }), /default_locale is required/);
    assert.throws(() => read({ ...mv3, content_scripts: [{ js: ["a.js"] }] }), /content_scripts\[0\]\.matches is required/);
    assert.throws(
      () => read({ ...mv3, content_scripts: [{ matches: ["https://a.test/*"], exclude_matches: ["https://ok.test/*", "nope"] }] }),
      /content_scripts\[0\]\.exclude_matches\[1\]: Invalid match pattern: nope/,
    );
    assert.throws(() => read({ ...mv3, content_scripts: [{ matches: ["<all_urls>"], run_at: "document_soon" }] }), /content_scripts\[0\]\.run_at: unknown value "document_soon"/);
    assert.throws(() => read({ ...mv3, content_scripts: [{ matches: ["<all_urls>"], js: ["../x.js"] }] }), /content_scripts\[0\]\.js: \.\.\/x\.js points outside the extension/);
  });
});
