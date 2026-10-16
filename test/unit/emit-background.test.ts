import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emit } from "../../src/convert/emit.ts";
import { convert } from "../../src/convert/index.ts";
import type { BackgroundCode, RuntimeConfig } from "../../src/runtime/config.ts";
import { backgroundExtension, files } from "../support/extension.ts";

describe("emit and convert: the background", () => {
  it("passes the background as a factory whose parameters shadow the background's globals", () => {
    const config = { name: "E", ns: "e", id: "i", manifest: {}, groups: [], assets: {}, locales: {} } satisfies RuntimeConfig;
    const userscript = emit("// h", "var __x2uRuntime = { start: (c, g, b) => __got(b) };", config, [], { code: "globalThis.__seen = [typeof window, self.tag, __x2uImportMeta.url];", worker: true, entry: "sw.js" });
    let factory: BackgroundCode | undefined;
    new Function("__got", userscript)((b: BackgroundCode) => (factory = b));
    // Inside the factory, globalThis is the parameter: the background's global object.
    const backgroundGlobal: { __seen?: unknown[] } = {};
    factory?.({}, {}, { tag: "shim" }, backgroundGlobal, undefined, undefined, () => {}, {}, () => {}, undefined, { url: "u" })();
    assert.deepEqual(backgroundGlobal.__seen, ["undefined", "shim", "u"]);
  });

  it("bundles the scripts the background names for executeScript, whether written with ./ or not", async () => {
    const extension = files({
      "manifest.json": JSON.stringify({ manifest_version: 3, name: "E", version: "1", background: { service_worker: "sw.js" } }),
      "sw.js": 'chrome.scripting.executeScript({ target: { tabId: 1 }, files: ["./js/a.js", "b.js"] });',
      "js/a.js": "window.a = 1;",
      "b.js": "window.b = 2;",
    });
    const { userscript } = await convert(extension, { runtime: "var __x2uRuntime = { start() {} };" });
    assert.match(userscript, /"js\/a\.js": function \(chrome, browser, fetch, XMLHttpRequest\)/);
    assert.match(userscript, /"b\.js": function \(chrome, browser, fetch, XMLHttpRequest\)/);
  });

  it("puts the background's kind and entry in the config", async () => {
    const { userscript } = await convert(backgroundExtension("http://127.0.0.1:4567"), { runtime: "var __x2uRuntime = { start() {} };" });
    const config = JSON.parse(/__x2uRuntime\.start\((\{.*?\}), \[\n/s.exec(userscript)?.[1] ?? "{}");
    assert.deepEqual(config.background, { worker: true, entry: "sw.js" });
    assert.match(userscript, /function \(chrome, browser, self, globalThis, window, document, importScripts, localStorage, fetch, XMLHttpRequest, __x2uImportMeta\) \{\nreturn function \(\) \{\nimportScripts|\/\* importScripts\("lib\/helper\.js"\) \*\//);
  });
});
