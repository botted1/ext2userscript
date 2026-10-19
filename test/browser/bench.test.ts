// The benchmark's runner (bench/run.ts) on pages it serves itself: a case against the CI emulator, and against an
// original extension.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BrowserCase } from "../../bench/case.ts";
import { check, runReference } from "../../bench/run.ts";
import { startSession } from "../../bench/session.ts";
import { files, zipFiles } from "../support/extension.ts";
import { renderMeta } from "../support/userscript.ts";

// Every request to the site matches this route, the emulator's own included.
const routes = { "https://site.x2u.test/**": { body: "<!doctype html><title>t</title><p>page</p>", type: "text/html" } };
const tagged = (timeout: number): BrowserCase => ({
  routes,
  async run({ open }) {
    const page = await open("https://site.x2u.test/");
    await page.locator("html[data-tagged]").waitFor({ state: "attached", timeout });
  },
});
const userscript = (body: string) => `${renderMeta({ name: "t", match: ["https://site.x2u.test/*"], grant: ["GM_getValue"] })}\n${body}`;
const TAG = `document.documentElement.dataset.tagged = "1";`;

describe("bench runner", () => {
  it("passes a case whose effect shows, with the emulator working under the case's catch-all route", async () => {
    assert.deepEqual(await check(tagged(10_000), await startSession("emulator", userscript(TAG))), { result: "pass" });
  });

  it("fails a case whose effect doesn't show, naming the first error a page threw", async () => {
    const outcome = await check(tagged(2_000), await startSession("emulator", userscript(`throw new Error("boom");`)));
    assert.equal(outcome.result, "fail");
    assert.match(outcome.detail ?? "", /^locator\.waitFor: Timeout 2000ms exceeded\. \(first page error: boom\)$/);
  });

  it("runs a case against the original extension", async () => {
    const manifest = { manifest_version: 3, name: "T", version: "1", content_scripts: [{ matches: ["https://site.x2u.test/*"], js: ["c.js"] }] };
    const bytes = zipFiles(files({ "manifest.json": JSON.stringify(manifest), "c.js": TAG }));
    assert.deepEqual(await runReference({ path: "", bytes, version: "1", sha256: "", drifted: false }, tagged(10_000)), { result: "pass" });
  });
});
