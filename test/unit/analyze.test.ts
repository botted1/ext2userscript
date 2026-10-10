import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../../src/convert/analyze.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import { formatReport, sortEntries, verdictOf, type Report, type ReportEntry } from "../../src/convert/report.ts";
import { scan } from "../../src/convert/scan.ts";
import { files } from "../support/extension.ts";

const model = (manifest: Record<string, unknown>) =>
  readManifest(files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1.0", ...manifest }) })).model;
const group = { matches: ["https://a.test/*"], js: ["a.js"] };

describe("analyze", () => {
  it("reports each content API once, with the support table's status, and skips namespaces content scripts don't have", () => {
    const code = "chrome.storage.local.get(); chrome.storage.local.set({}); browser.runtime.sendMessage(1); chrome.tabs.query({}); chrome.runtime.getPlatformInfo();";
    const { entries } = analyze(model({ content_scripts: [group] }), [scan(code)]);
    assert.deepEqual(entries, [
      { subject: "chrome.storage.local", status: "supported", contexts: ["content"] },
      { subject: "chrome.runtime.sendMessage", status: "unsupported", reason: "messaging with the background isn't converted yet", contexts: ["content"] },
    ]);
  });

  it("flags document_start, about:blank frames and dynamic import()", () => {
    const { entries } = analyze(model({ content_scripts: [{ ...group, run_at: "document_start", match_about_blank: true }] }), [scan("import('./x.js')")]);
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status]), [
      ["import()", "partial"],
      ["manifest.content_scripts.run_at", "partial"],
      ["manifest.content_scripts.match_about_blank", "partial"],
    ]);
  });

  it("reports the contexts and manifest features this version doesn't convert", () => {
    const { entries } = analyze(
      model({ background: { service_worker: "sw.js" }, action: { default_popup: "p.html" }, options_ui: { page: "o.html" }, chrome_url_overrides: { newtab: "n.html" }, commands: {} }),
      [],
    );
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status, entry.contexts]), [
      ["manifest.background", "unsupported", ["background"]],
      ["manifest.action.default_popup", "unsupported", ["popup"]],
      ["manifest.options_ui", "unsupported", ["options"]],
      ["manifest.chrome_url_overrides", "unsupported", ["background"]],
      ["manifest.commands", "unsupported", ["background"]],
    ]);
  });

  it("skips groups without a scan (no JS, or the MAIN world)", () => {
    assert.deepEqual(analyze(model({ content_scripts: [group, group] }), [undefined, undefined]).entries, []);
  });
});

describe("verdictOf", () => {
  const entry = (status: ReportEntry["status"], context: ReportEntry["contexts"][number]): ReportEntry => ({ subject: "x", status, contexts: [context] });

  it("is unlikely when something unsupported sits in the background or content scripts", () => {
    assert.equal(verdictOf([entry("unsupported", "content")]), "unlikely");
    assert.equal(verdictOf([entry("unsupported", "background")]), "unlikely");
  });

  it("is partial for partial entries, or unsupported ones elsewhere", () => {
    assert.equal(verdictOf([entry("partial", "content")]), "partial");
    assert.equal(verdictOf([entry("unsupported", "popup")]), "partial");
  });

  it("is likely-works otherwise", () => assert.equal(verdictOf([entry("supported", "content")]), "likely-works"));
});

describe("formatReport", () => {
  it("prints the verdict, then entries worst first in aligned columns, then warnings", () => {
    const report: Report = {
      extension: { name: "Ext", version: "1.0", manifestVersion: 3 },
      verdict: "unlikely",
      entries: sortEntries([
        { subject: "chrome.storage.local", status: "supported", contexts: ["content"] },
        { subject: "manifest.background", status: "unsupported", reason: "background scripts aren't converted yet", contexts: ["background"] },
        { subject: "chrome.storage.session", status: "partial", reason: "kept across browser restarts", contexts: ["content"] },
      ]),
      warnings: ["style.css refers to a.png, which isn't in the extension"],
    };
    assert.equal(
      formatReport(report),
      [
        "Ext 1.0 (manifest v3): unlikely",
        "  unsupported  manifest.background     background  background scripts aren't converted yet",
        "  partial      chrome.storage.session  content     kept across browser restarts",
        "  supported    chrome.storage.local    content",
        "Warnings:",
        "  - style.css refers to a.png, which isn't in the extension",
      ].join("\n"),
    );
  });
});
