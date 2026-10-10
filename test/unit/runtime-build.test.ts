import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convert } from "../../src/convert/index.ts";
import { loadRuntime } from "../../src/convert/runtime-node.ts";
import { sampleExtension } from "../support/extension.ts";

describe("loadRuntime", () => {
  it("builds src/runtime into a minified IIFE named __x2uRuntime with a start() function", async () => {
    const runtime = await loadRuntime();
    const exported = new Function(`${runtime}\nreturn __x2uRuntime;`)() as { start?: unknown };
    assert.equal(typeof exported.start, "function");
    assert.equal(await loadRuntime(), runtime, "built once, then cached");
  });

  it("keeps its strict mode to itself, so the extension's code after it stays sloppy", async () => {
    const runtime = await loadRuntime();
    assert.match(runtime, /^var __x2uRuntime=\(\(\)=>\{"use strict";/);
    // Assigning an undeclared name throws in strict code and creates a global in sloppy code.
    const sloppy = new Function(`${runtime}\nx2uUndeclared = 1; const ok = globalThis.x2uUndeclared === 1; delete globalThis.x2uUndeclared; return ok;`);
    assert.equal(sloppy(), true);
  });

  it("gives a userscript that parses", async () => {
    const { userscript } = await convert(sampleExtension("http://127.0.0.1:4567"), { runtime: await loadRuntime() });
    assert.doesNotThrow(() => new Function(userscript));
  });
});
