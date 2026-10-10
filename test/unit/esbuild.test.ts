import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8 } from "fflate";
import { bundleModule } from "../../src/convert/esbuild.ts";
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
});
