// Sample extensions for conversion tests, built in memory.
// - sampleExtension exercises content scripts (no background).
// - backgroundExtension has a classic service worker that answers content scripts: messages, a port, tabs.sendMessage,
//   onInstalled, importScripts.
// - moduleBackgroundExtension has an ES-module service worker.
// - networkExtension fetches from another origin, which sends no CORS headers, in the background and content scripts.
// - apiExtension uses alarms, context menus, the toolbar button, a shortcut, scripting, notifications, cookies,
//   permissions, windows and getBackgroundPage.
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
    // line uses an API this version doesn't implement; that call fails, and the rest of the background still runs. Its
    // second uses Chrome's enum constants, as MV3 backgrounds commonly do at top level.
    "sw.js": `chrome.bookmarks.create({ title: "x2u" }).catch(() => {});
chrome.storage.session.setAccessLevel({ accessLevel: chrome.storage.AccessLevel.TRUSTED_AND_UNTRUSTED_CONTEXTS });
importScripts("lib/helper.js");
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "hello") sendResponse({ text: shout(message.text), tab: typeof sender.tab.id, install: chrome.runtime.OnInstalledReason.INSTALL });
  if (message.type === "ping-me") chrome.tabs.sendMessage(sender.tab.id, { type: "pong", from: "background" });
});
chrome.runtime.onConnect.addListener((port) => port.onMessage.addListener((value) => port.postMessage(value * 2)));
chrome.runtime.onInstalled.addListener((details) => chrome.storage.local.set({ installedReason: details.reason }));
self.addEventListener("install", () => self.skipWaiting());
`,
    "lib/helper.js": "function shout(text) { return text.toUpperCase(); }",
    "content.js": `const html = document.documentElement;
chrome.runtime.sendMessage({ type: "hello", text: "x2u" }).then((reply) => {
  html.dataset.reply = reply.text + "@" + reply.tab;
  html.dataset.constant = reply.install;
});
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

/**
 * origin is where the test pages are served (http://127.0.0.1:<port>); the same server as http://localhost:<port> is
 * another origin, which the host permissions cover and whose /api.json sends no CORS headers.
 */
export function networkExtension(origin: string): ExtensionFiles {
  const other = origin.replace("127.0.0.1", "localhost");
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Network Sample",
      version: "1.0.0",
      background: { service_worker: "sw.js" },
      host_permissions: [`${other}/*`],
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"] }],
    }),
    "sw.js": `chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  Promise.all([fetch("${other}/api.json").then((r) => r.json()), fetch("data/config.json").then((r) => r.json())]).then(
    ([api, config]) => sendResponse(api.from + "|" + config.kind + "|" + typeof XMLHttpRequest),
    (error) => sendResponse("failed: " + error.message),
  );
  return true;
});`,
    "data/config.json": '{"kind":"config"}',
    "content.js": `const html = document.documentElement;
chrome.runtime.sendMessage("net").then((reply) => { html.dataset.background = reply; });
fetch("${other}/api.json").then((r) => r.json()).then((body) => { html.dataset.fetch = body.from; }, (error) => { html.dataset.fetch = "failed: " + error.message; });
const xhr = new XMLHttpRequest();
xhr.open("GET", "${other}/api.json");
xhr.responseType = "json";
xhr.onload = () => { html.dataset.xhr = xhr.response.from + ":" + xhr.status; };
xhr.onerror = () => { html.dataset.xhr = "failed"; };
xhr.send();
fetch("/same.json").then((r) => r.json()).then((body) => { html.dataset.same = body.from; });
`,
  });
}

/** origin is where the test pages are served; its page.html has a .x2u-box element and the title "x2u". */
export function apiExtension(origin: string): ExtensionFiles {
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "API Sample",
      version: "1.0.0",
      icons: { "48": "icon.png" },
      background: { service_worker: "sw.js" },
      permissions: ["alarms", "contextMenus", "notifications", "scripting", "cookies"],
      optional_permissions: ["bookmarks"],
      host_permissions: [`${origin}/*`],
      action: { default_title: "Click API Sample" },
      commands: { "run-it": { suggested_key: { default: "Alt+Shift+K" }, description: "Run it" } },
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"] }],
    }),
    "icon.png": PIXEL,
    "sw.js": `chrome.runtime.onInstalled.addListener(() => chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: "say", title: "Say hello" })));
chrome.alarms.create("soon", { delayInMinutes: 0.001 });
chrome.alarms.onAlarm.addListener((alarm) => chrome.storage.local.set({ alarm: alarm.name }));
chrome.contextMenus.onClicked.addListener((info, tab) => chrome.tabs.sendMessage(tab.id, { menu: info.menuItemId }));
chrome.action.onClicked.addListener((tab) => chrome.tabs.sendMessage(tab.id, { action: true }));
chrome.commands.onCommand.addListener((name, tab) => chrome.tabs.sendMessage(tab.id, { command: name }));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const target = { tabId: sender.tab.id };
  if (message === "inject") {
    chrome.scripting
      .executeScript({ target, func: (word) => { document.documentElement.dataset.injected = word; return document.title; }, args: ["yes"] })
      .then(([first]) => chrome.scripting.executeScript({ target, files: ["inject.js"] }).then(() => first.result))
      .then((title) => chrome.scripting.insertCSS({ target, css: ".x2u-box { border-top-color: rgb(4, 5, 6); }" }).then(() => sendResponse(title)));
    return true;
  }
  if (message === "apis") {
    Promise.all([
      // Granted, then removed again, so each run starts without it.
      chrome.permissions
        .request({ permissions: ["bookmarks"] })
        .then(() => chrome.permissions.contains({ permissions: ["bookmarks"] }))
        .then((granted) => chrome.permissions.remove({ permissions: ["bookmarks"] }).then(() => chrome.permissions.contains({ permissions: ["bookmarks"] })).then((kept) => granted + "/" + kept)),
      chrome.windows.getCurrent({ populate: true }).then((window) => window.id + ":" + (window.tabs.length > 0)),
      chrome.notifications.create("hello", { type: "basic", iconUrl: "icon.png", title: "Hi", message: "There" }),
      chrome.runtime.getBackgroundPage().then((page) => page === self),
      chrome.commands.getAll().then((all) => all.map((command) => command.name).join()),
    ]).then((values) => sendResponse(values.join("|")), (error) => sendResponse("failed: " + error.message));
    return true;
  }
  if (message === "cookie") {
    chrome.cookies
      .set({ url: "${origin}/", name: "x2u", value: "baked" })
      .then(() => chrome.cookies.get({ url: "${origin}/", name: "x2u" }))
      .then((cookie) => sendResponse(cookie && cookie.value), (error) => sendResponse("failed: " + error.message));
    return true;
  }
});`,
    "inject.js": "document.documentElement.dataset.file = typeof chrome.runtime.id;",
    "content.js": `const html = document.documentElement;
chrome.runtime.onMessage.addListener((message) => {
  if (message.menu) html.dataset.menu = message.menu;
  if (message.action) html.dataset.action = "clicked";
  if (message.command) html.dataset.command = message.command;
});
chrome.runtime.sendMessage("inject").then((title) => { html.dataset.injectTitle = title; });
chrome.runtime.sendMessage("apis").then((reply) => { html.dataset.apis = reply; });
chrome.runtime.sendMessage("cookie").then((reply) => { html.dataset.cookie = reply; });
const poll = () => chrome.storage.local.get("alarm").then(({ alarm }) => (alarm ? (html.dataset.alarm = alarm) : setTimeout(poll, 200)));
poll();
`,
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
