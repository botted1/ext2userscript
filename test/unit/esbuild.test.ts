import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8 } from "fflate";
import { bundleModule, lazyEsbuild } from "../../src/convert/esbuild.ts";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";
import { dirname, joinPath } from "../../src/convert/paths.ts";

const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([path, text]) => [path, strToU8(text)]));

describe("paths", () => {
  it("joins relative to a directory and drops query strings", () => {
    assert.equal(joinPath("js/lib", "../shared/a.js?v=2"), "js/shared/a.js");
    assert.equal(joinPath("", "/root.js"), "root.js");
    assert.equal(dirname("js/lib/a.js"), "js/lib");
    assert.equal(dirname("a.js"), "");
  });

  it("refuses to leave the extension root", () => {
    assert.throws(() => joinPath("js", "../../etc/passwd"), /escapes the extension root/);
  });
});

describe("lazyEsbuild", () => {
  it("loads esbuild when a conversion first uses it, not before", async () => {
    let loads = 0;
    const esbuild = lazyEsbuild(async () => {
      loads++;
      return loadEsbuild();
    });
    assert.equal(loads, 0);
    assert.equal((await esbuild.transform("let a = 1", { minify: true })).code, "let a=1;\n");
    assert.equal(loads, 1);
  });
});

describe("bundleModule", () => {
  it("bundles static, root-relative and dynamic imports from the extension's files", async () => {
    const { code, remoteImports } = await bundleModule(
      await loadEsbuild(),
      files({
        "bg/worker.js": 'import { a } from "./lib/a.js"; import shared from "/shared.js"; console.log(a, shared); import("./lazy.js").then((m) => console.log(m.lazy));',
        "bg/lib/a.js": 'export const a = "from-a";',
        "shared.js": 'export default "from-shared";',
        "bg/lazy.js": 'export const lazy = "from-lazy";',
      }),
      "bg/worker.js",
    );
    for (const text of ["from-a", "from-shared", "from-lazy"]) assert.ok(code.includes(text), `missing ${text}`);
    assert.deepEqual(remoteImports, []);
  });

  it("keeps remote imports external and lists them", async () => {
    const { code, remoteImports } = await bundleModule(await loadEsbuild(), files({ "w.js": 'import("https://cdn.example.com/x.js");' }), "w.js");
    assert.deepEqual(remoteImports, ["https://cdn.example.com/x.js"]);
    assert.ok(code.includes("https://cdn.example.com/x.js"));
  });

  it("names a missing file and who imported it", async () => {
    await assert.rejects(
      bundleModule(await loadEsbuild(), files({ "w.js": 'import "./missing.js";' }), "w.js"),
      /\.\/missing\.js \(imported from w\.js\) is not in the extension/,
    );
  });

  it("bundles an IIFE whose entry has a top-level await as an async function called at once", async () => {
    const esbuild = await loadEsbuild();
    const { code } = await bundleModule(esbuild, files({ "page.js": "import { two } from './two.js';\nglobalThis.__got = await Promise.resolve(two);", "two.js": "export const two = 2;" }), "page.js", { format: "iife" });
    await new Function("__x2uImportMeta", code)({ url: "u" });
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal((globalThis as { __got?: number }).__got, 2);
  });

  it("bundles a module as an async function of import.meta that resolves to its exports", async () => {
    const esbuild = await loadEsbuild();
    const { code } = await bundleModule(esbuild, files({ "m.js": "export const url = import.meta.url;\nexport default await Promise.resolve(7);\nexport { url as also };" }), "m.js", { format: "function", define: { "import.meta": "__x2uImportMeta" } });
    const namespace = await (0, eval)(`(${code})`)({ url: "chrome-extension://id/m.js" });
    assert.deepEqual({ ...namespace }, { url: "chrome-extension://id/m.js", default: 7, also: "chrome-extension://id/m.js" });
  });

  it("finds a module's exports when license comments follow them, as esbuild writes them at the end", async () => {
    const esbuild = await loadEsbuild();
    const { code } = await bundleModule(esbuild, files({ "m.js": "/*! Licensed under MIT */\nexport const answer = 42;" }), "m.js", { format: "function" });
    assert.match(code, /\/\*! Licensed under MIT \*\//);
    assert.deepEqual({ ...(await (0, eval)(`(${code})`)({ url: "u" })) }, { answer: 42 });
  });
});
