import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../../src/convert/analyze.ts";
import { bundleBackground } from "../../src/convert/bundle.ts";
import { readManifest } from "../../src/convert/manifest.ts";
import { scan } from "../../src/convert/scan.ts";
import { files } from "../support/extension.ts";

const extension = (manifest: Record<string, unknown>, extra: Record<string, string>) => {
  const all = files({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Ext", version: "1.0", ...manifest }), ...extra });
  return { model: readManifest(all).model, files: all };
};

describe("analyze: the background", () => {
  it("reports background APIs: supported, partial, not converted yet, and never available", async () => {
    const { model, files: all } = extension({ background: { service_worker: "sw.js" } }, {
      "sw.js": "chrome.runtime.onMessage.addListener(f); chrome.tabs.query({}); chrome.tabs.create({}); chrome.bookmarks.create({}); chrome.webRequest.onBeforeRequest.addListener(f); chrome.storage.local.getKeys();",
    });
    const result = await bundleBackground(model, all);
    const { entries } = analyze(model, [], { scan: scan(result.background?.code ?? ""), bundle: result });
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status, entry.reason ?? ""]), [
      ["chrome.runtime.onMessage", "supported", ""],
      ["chrome.tabs.query", "supported", ""],
      ["chrome.tabs.create", "partial", "the new tab's id is known only if the userscript runs on its page"],
      ["chrome.bookmarks.create", "unsupported", "isn't converted yet"],
      ["chrome.webRequest.onBeforeRequest", "unsupported", "not available in userscripts"],
      ["chrome.storage.local.getKeys", "unsupported", "not implemented yet"],
    ]);
  });

  it("reports Chrome's enum constants and storage access levels as supported", () => {
    const { model } = extension({ background: { service_worker: "sw.js" } }, {});
    const code = [
      "chrome.storage.session.setAccessLevel({ accessLevel: chrome.storage.AccessLevel.TRUSTED_AND_UNTRUSTED_CONTEXTS });",
      "chrome.runtime.onInstalled.addListener((d) => d.reason === chrome.runtime.OnInstalledReason.INSTALL);",
      "chrome.runtime.getPlatformInfo().then((p) => p.os === chrome.runtime.PlatformOs.MAC);",
    ].join("\n");
    const { entries } = analyze(model, [], { scan: scan(code), bundle: { dynamicImportScripts: false, remoteImports: [] } });
    assert.deepEqual(entries.filter((entry) => entry.status !== "supported").map((entry) => entry.subject), []);
  });

  it("reports the APIs this version converts, with the GM grants they need", async () => {
    const { model, files: all } = extension({ background: { service_worker: "sw.js" } }, {
      "sw.js": [
        "chrome.alarms.create('a', { periodInMinutes: 1 }); chrome.commands.getAll(); chrome.permissions.request({});",
        "chrome.contextMenus.create({}); chrome.action.setBadgeText({}); chrome.action.setIcon({});",
        "chrome.notifications.create({}); chrome.cookies.get({}); chrome.windows.getAll(); chrome.scripting.executeScript({});",
      ].join("\n"),
    });
    const result = await bundleBackground(model, all);
    const { entries, methods } = analyze(model, [], { scan: scan(result.background?.code ?? ""), bundle: result });
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status]), [
      ["chrome.alarms.create", "supported"],
      ["chrome.commands.getAll", "supported"],
      ["chrome.permissions.request", "partial"],
      ["chrome.contextMenus.create", "partial"],
      ["chrome.action.setBadgeText", "partial"],
      ["chrome.action.setIcon", "partial"],
      ["chrome.notifications.create", "supported"],
      ["chrome.cookies.get", "partial"],
      ["chrome.windows.getAll", "partial"],
      ["chrome.scripting.executeScript", "partial"],
    ]);
    assert.deepEqual([...methods].sort(), ["cookie", "notification", "registerMenuCommand", "unregisterMenuCommand"]);
    // Where a function falls back to the page's world, the page can read what it was given: the report says so.
    assert.match(entries.find((entry) => entry.subject === "chrome.scripting.executeScript")?.reason ?? "", /the page can see its arguments and result/);
  });

  it("flags dynamic importScripts, remote imports, a background page and persistent: true", () => {
    const { model } = extension({ manifest_version: 2, background: { page: "bg.html", persistent: true } }, { "bg.html": "" });
    const { entries } = analyze(model, [], { scan: scan(""), bundle: { dynamicImportScripts: true, remoteImports: ["https://cdn.test/m.js"] } });
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status]), [
      ["importScripts()", "partial"],
      ["import https://cdn.test/m.js", "unsupported"],
      ["manifest.background.page", "partial"],
      ["manifest.background.persistent", "partial"],
    ]);
  });
});
