// Sample extensions for conversion tests, built in memory.
// - sampleExtension exercises content scripts (no background).
// - backgroundExtension has a classic service worker that answers content scripts: messages, a port, tabs.sendMessage,
//   onInstalled, importScripts.
// - moduleBackgroundExtension has an ES-module service worker.
// - plainExtension is the smallest one that converts with no unsupported or partial entries.
import { strToU8, zipSync } from "fflate";
import type { ExtensionFiles } from "../../src/convert/unpack.ts";

/** A 1×1 PNG. */
export const PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

export const files = (entries: Record<string, string | Uint8Array>): ExtensionFiles =>
  new Map(Object.entries(entries).map(([path, content]) => [path, typeof content === "string" ? strToU8(content) : content]));

export const zipFiles = (extension: ExtensionFiles): Uint8Array<ArrayBuffer> => zipSync(Object.fromEntries(extension));

/** origin is where the test pages are served, e.g. http://127.0.0.1:4567. */
export function sampleExtension(origin: string): ExtensionFiles {
  const site = `${origin}/*`;
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "__MSG_extName__",
      version: "1.2.3",
      description: "__MSG_extDescription__",
      default_locale: "en",
      icons: { "16": "icons/16.png", "48": "icons/48.png" },
      web_accessible_resources: [{ resources: ["inject.js", "data/*"], matches: ["<all_urls>"] }],
      content_scripts: [
        { matches: [site], exclude_matches: [`${origin}/excluded*`], js: ["lib.js", "content.js"], css: ["style.css"], all_frames: true },
        { matches: [site], js: ["main-world.js"], world: "MAIN", run_at: "document_end" },
        { matches: [site], js: ["start.js"], run_at: "document_start" },
        { matches: [site], include_globs: ["*glob-yes*"], js: ["glob.js"] },
        { matches: [site], js: ["broken.js"] },
      ],
    }),
    "_locales/en/messages.json": JSON.stringify({
      extName: { message: "Sample Extension" },
      extDescription: { message: "Exercises content scripts" },
      greeting: { message: "Hello $WHO$", placeholders: { who: { content: "$1" } } },
    }),
    "_locales/fr/messages.json": JSON.stringify({ greeting: { message: "Bonjour $who$", placeholders: { who: { content: "$1" } } } }),
    // webextension-polyfill 0.10+ refuses to load unless globalThis.chrome looks like an extension's.
    // Sloppy code, as many content scripts are: assigning an undeclared name would throw if the group ran strict.
    "lib.js": 'if (!globalThis.chrome?.runtime?.id) throw new Error("not in an extension");\nsampleUndeclared = 1;\nvar sampleLib = { tag: "lib" }; // no newline at the end',
    "content.js": `const browser = chrome;
const html = document.documentElement;
html.dataset.content = sampleLib.tag;
html.dataset.greeting = browser.i18n.getMessage("greeting", ["x2u"]);
chrome.storage.local.get({ visits: 0 }).then(({ visits }) => chrome.storage.local.set({ visits: visits + 1 })).then(() => { html.dataset.stored = "1"; });
fetch(chrome.runtime.getURL("data/info.json")).then((r) => r.json()).then((info) => { html.dataset.info = info.kind; });
const script = document.createElement("script");
script.src = chrome.runtime.getURL("inject.js");
script.onload = () => { script.remove(); html.dataset.injectLoaded = "1"; };
(document.head || html).appendChild(script);
chrome.runtime.sendMessage({ hello: true }).catch((error) => { html.dataset.sendError = error.message; });
chrome.storage.onChanged.addListener((changes) => {
  const seen = new Set((html.dataset.changed || "").split(",").filter(Boolean));
  for (const key of Object.keys(changes)) seen.add(key);
  html.dataset.changed = [...seen].sort().join(",");
});
if (location.pathname === "/writer.html") setTimeout(() => chrome.storage.local.set({ fromWriter: Date.now() }), 500);
`,
    "style.css": ".x2u-box { color: rgb(1, 2, 3); background-image: url(img/dot.png); }",
    "inject.js": 'document.documentElement.dataset.injected = typeof chrome === "object" && chrome !== null && chrome.runtime && chrome.runtime.getURL ? "extension" : "page";',
    "main-world.js": "document.documentElement.dataset.main = String(window.pageValue);",
    "start.js": `const startState = document.readyState;
const markStart = () => document.documentElement.setAttribute("data-start", startState);
if (document.documentElement) markStart(); else document.addEventListener("DOMContentLoaded", markStart);`,
    "glob.js": 'document.documentElement.dataset.glob = "1";',
    "broken.js": 'throw new Error("this group fails on purpose");',
    "data/info.json": '{"kind":"sample"}',
    "img/dot.png": PIXEL,
    "icons/16.png": PIXEL,
    "icons/48.png": PIXEL,
    "unused.txt": "not referenced anywhere",
  });
}

/** origin is where the test pages are served. Content scripts run in frames too, so a frame's messages are answered. */
export function backgroundExtension(origin: string): ExtensionFiles {
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Background Sample",
      version: "3.0.0",
      background: { service_worker: "sw.js" },
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"], all_frames: true }],
    }),
    // A classic service worker: importScripts with string literals is inlined when the extension is converted. Its first
    // line uses an API this version doesn't implement; that call fails, and the rest of the background still runs.
    "sw.js": `chrome.alarms.create("tick", { periodInMinutes: 1 }).catch(() => {});
importScripts("lib/helper.js");
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "hello") sendResponse({ text: shout(message.text), tab: typeof sender.tab.id });
  if (message.type === "ping-me") chrome.tabs.sendMessage(sender.tab.id, { type: "pong", from: "background" });
});
chrome.runtime.onConnect.addListener((port) => port.onMessage.addListener((value) => port.postMessage(value * 2)));
chrome.runtime.onInstalled.addListener((details) => chrome.storage.local.set({ installedReason: details.reason }));
self.addEventListener("install", () => self.skipWaiting());
`,
    "lib/helper.js": "function shout(text) { return text.toUpperCase(); }",
    "content.js": `const html = document.documentElement;
chrome.runtime.sendMessage({ type: "hello", text: "x2u" }).then((reply) => { html.dataset.reply = reply.text + "@" + reply.tab; });
const port = chrome.runtime.connect({ name: "doubler" });
port.onMessage.addListener((value) => { html.dataset.port = String(value); });
port.postMessage(21);
chrome.runtime.onMessage.addListener((message) => { if (message.type === "pong") html.dataset.pong = message.from; });
chrome.runtime.sendMessage({ type: "ping-me" });
// onInstalled fires once per installed version; a real manager's profile keeps the stored reason from earlier runs.
const checkInstalled = () => chrome.storage.local.get("installedReason").then(({ installedReason }) => {
  if (installedReason) html.dataset.installed = installedReason;
  else setTimeout(checkInstalled, 200);
});
checkInstalled();
`,
  });
}

/** An ES-module service worker that imports a helper and reads import.meta.url. */
export function moduleBackgroundExtension(origin: string): ExtensionFiles {
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Module Background",
      version: "2.0.0",
      background: { service_worker: "bg/main.js", type: "module" },
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"] }],
    }),
    "bg/main.js": `import { label } from "./label.js";
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  sendResponse(label(new URL("icon.png", import.meta.url).pathname));
});`,
    "bg/label.js": 'export const label = (path) => "module:" + path;',
    "content.js": 'chrome.runtime.sendMessage("which").then((reply) => { document.documentElement.dataset.module = reply; });',
  });
}

/** Content scripts that use nothing unsupported or partial, so the report's verdict is likely-works. */
export function plainExtension(origin = "https://example.com"): ExtensionFiles {
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Plain Extension",
      version: "0.1.0",
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"] }],
    }),
    "content.js": 'chrome.storage.local.set({ seen: true }); document.documentElement.dataset.plain = "1";',
  });
}
