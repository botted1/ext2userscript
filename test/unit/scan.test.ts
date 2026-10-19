import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scan } from "../../src/convert/scan.ts";

describe("scan", () => {
  it("finds member chains rooted at chrome and browser, reporting browser as chrome", () => {
    const { chains } = scan("chrome.tabs.query({}); browser.storage.local.get('a'); chrome?.runtime?.sendMessage(1);");
    assert.deepEqual(chains, ["chrome.tabs.query", "chrome.storage.local.get", "chrome.runtime.sendMessage"]);
  });

  it("follows window.chrome, globalThis.browser and self.chrome, but not other objects' chrome property", () => {
    const { chains } = scan("window.chrome.i18n.getMessage('x'); globalThis.browser.runtime.id; self.chrome.storage.sync; foo.chrome.tabs.query();");
    assert.deepEqual(chains, ["chrome.i18n.getMessage", "chrome.runtime.id", "chrome.storage.sync"]);
  });

  it("ignores a bare chrome or browser without a member", () => {
    assert.deepEqual(scan("if (typeof chrome !== 'undefined' && browser) {}").chains, []);
  });

  it("skips comments, strings and regular expressions", () => {
    const code = [
      "// chrome.tabs.query()",
      "/* browser.cookies.getAll() */",
      "const a = 'chrome.history.search';",
      'const b = "browser.downloads.download";',
      "const c = /chrome\\.webRequest\\.x/g;",
      "const d = a / 2 / chrome.alarms.create;",
    ].join("\n");
    assert.deepEqual(scan(code).chains, ["chrome.alarms.create"]);
  });

  it("reads regular expressions that contain slashes in a character class", () => {
    assert.deepEqual(scan("const r = /[/]chrome.tabs/; chrome.runtime.id;").chains, ["chrome.runtime.id"]);
  });

  it("scans template substitutions, including nested braces and templates, but not template text", () => {
    const code = "const t = `chrome.tabs.query ${chrome.i18n.getMessage('a')} and ${ { x: `${browser.runtime.id}` }.x } done`; chrome.storage.local;";
    assert.deepEqual(scan(code).chains, ["chrome.i18n.getMessage", "chrome.runtime.id", "chrome.storage.local"]);
  });

  it("collects getURL string literals from runtime and extension", () => {
    const code = "chrome.runtime.getURL('img/a.png'); browser.extension.getURL(\"b.css\"); chrome.runtime.getURL(`c.js`); chrome.runtime.getURL(name); chrome.runtime.getURL('d' + x);";
    assert.deepEqual(scan(code).urls, ["img/a.png", "b.css", "c.js"]);
  });

  it("doesn't take a template with substitutions as a getURL literal", () => {
    assert.deepEqual(scan("chrome.runtime.getURL(`img/${name}.png`)").urls, []);
  });

  it("notices storage that belongs to the site, and custom elements, by bare name or on window", () => {
    assert.deepEqual(scan("indexedDB.open('db'); window.sessionStorage.getItem('x'); customElements.define('a-b', C); foo.indexedDB; indexedDB.x;").globals, ["indexedDB", "sessionStorage", "customElements"]);
  });

  it("lists the code's top-level declarations, as a background page's window holds them", () => {
    const { declarations } = scan("var a = 1, b; let c; const d = 2; function e() {} async function f() {} class G {} if (x) { var h; } const { i } = o; x = function j() {}; obj.k = function l() {};");
    assert.deepEqual(declarations, ["a", "c", "d", "e", "f", "G"]);
  });

  it("notices dynamic import()", () => {
    assert.equal(scan("import('./a.js')").dynamicImport, true);
    assert.equal(scan("loader.import('./a.js'); const s = 'import(x)';").dynamicImport, false);
  });

  it("survives unterminated strings, templates, comments and regular expressions", () => {
    for (const code of ["'abc", "`abc ${", "/* abc", "x = /abc", "chrome."]) assert.doesNotThrow(() => scan(code));
  });

  it("scans a 5 MB bundle in well under two seconds", () => {
    const chunk = "function f(a){ return chrome.storage.local.get(a).then((x) => x / 2) /* note */ + `t ${a}` + 're'; }\n";
    const code = chunk.repeat(Math.ceil((5 * 1024 * 1024) / chunk.length));
    const started = performance.now();
    const { chains } = scan(code);
    assert.ok(performance.now() - started < 2000, `took ${Math.round(performance.now() - started)} ms`);
    assert.equal(chains.length, Math.ceil((5 * 1024 * 1024) / chunk.length));
  });

  it("finds import() calls, with the file when the argument is runtime.getURL of a literal", () => {
    const code = 'void import(chrome.runtime.getURL("assets/a.js")); import(/* @vite-ignore */ browser.runtime.getURL("b.js")); import(x); import(chrome.runtime.getURL("c.js") + "?v=1");';
    const { imports } = scan(code);
    assert.deepEqual(imports.map((call) => call.path), ["assets/a.js", "b.js", undefined, undefined]);
    assert.equal(code.slice(imports[0].start, imports[0].end), 'import(chrome.runtime.getURL("assets/a.js"))');
  });

  it("finds string literals shaped like a relative file's path", () => {
    const { paths } = scan('x.open("GET", "../config/a.config"); load("data/b.json"); "icon.png"; "plain words"; "https://a.test/c.json"');
    assert.deepEqual(paths, ["../config/a.config", "data/b.json", "icon.png"]);
  });

  it("finds the hosts of http(s) URLs in strings and template heads, once each", () => {
    const { hosts } = scan('fetch("https://API.example.com/v1"); const u = `https://cdn.example.org/x/${path}`; "http://example.com"; "https://example.com/again"; "not https://inside.test"; "https://localhost/"');
    assert.deepEqual(hosts, ["api.example.com", "cdn.example.org", "example.com"]);
  });
});
