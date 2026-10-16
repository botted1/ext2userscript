// chrome.commands: the manifest's shortcuts, heard on each page and fired in the background.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/runtime/chrome.ts";
import { commandPlatform, createCommands, listenForCommands, parseShortcut } from "../../src/runtime/commands.ts";
import type { RuntimeConfig } from "../../src/runtime/config.ts";

const config: RuntimeConfig = {
  name: "Ext", ns: "t", id: "id", manifest: {}, groups: [], assets: {}, locales: {},
  commands: {
    toggle: { description: "Toggle", keys: { default: "Ctrl+Shift+Y", mac: "MacCtrl+Shift+Y" } },
    next: { keys: { default: "Alt+Period" } },
    unbound: { keys: {} },
  },
};

const key = (code: string, modifiers: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean; repeat?: boolean } = {}) =>
  Object.assign(new Event("keydown", { cancelable: true }), { code, ...modifiers });

describe("parseShortcut", () => {
  it("reads Chrome's key names, with Ctrl meaning Command on a Mac", () => {
    assert.deepEqual(parseShortcut("Ctrl+Shift+Y", "linux"), { code: "KeyY", ctrl: true, alt: false, shift: true, meta: false });
    assert.deepEqual(parseShortcut("Ctrl+Shift+Y", "mac"), { code: "KeyY", ctrl: false, alt: false, shift: true, meta: true });
    assert.deepEqual(parseShortcut("MacCtrl+Command+3", "mac"), { code: "Digit3", ctrl: true, alt: false, shift: false, meta: true });
    assert.equal(parseShortcut("Alt+Up", "windows")?.code, "ArrowUp");
    assert.equal(parseShortcut("Alt+Comma", "windows")?.code, "Comma");
    assert.equal(parseShortcut("Ctrl+Shift+Banana", "linux"), undefined);
    assert.equal(parseShortcut("Ctrl+Shift", "linux"), undefined);
  });

  it("names this platform the way manifests do", () => {
    assert.deepEqual(["MacIntel", "Win32", "Linux x86_64", "CrOS x86_64"].map((platform) => commandPlatform(platform)), ["mac", "windows", "linux", "chromeos"]);
  });
});

describe("listenForCommands", () => {
  it("tells the background about a shortcut, using this platform's key, and keeps it from the page", async () => {
    const page = new EventTarget();
    const sent: unknown[] = [];
    // Events made here aren't trusted, so the test counts them as the user's.
    listenForCommands(page, config, async (type, data) => void sent.push([type, data]), createLogger("test"), "mac", () => true);
    const pageSaw: string[] = [];
    page.addEventListener("keydown", (event) => pageSaw.push((event as Event & { code: string }).code));
    const matching = key("KeyY", { ctrlKey: true, shiftKey: true });
    page.dispatchEvent(matching);
    page.dispatchEvent(key("KeyY", { metaKey: true, shiftKey: true })); // Ctrl+Shift+Y, which the Mac key replaces
    page.dispatchEvent(key("Period", { altKey: true }));
    page.dispatchEvent(key("Period", { altKey: true, repeat: true }));
    assert.deepEqual(sent, [["command", { name: "toggle" }], ["command", { name: "next" }]]);
    assert.equal(matching.defaultPrevented, true);
    assert.deepEqual(pageSaw, ["KeyY"]);
  });
});

describe("listenForCommands and the page", () => {
  it("ignores a key event the page made up, so only the user can fire a shortcut", () => {
    const page = new EventTarget();
    const sent: unknown[] = [];
    listenForCommands(page, config, async (type, data) => void sent.push([type, data]), createLogger("test"), "mac");
    const forged = key("KeyY", { ctrlKey: true, shiftKey: true });
    page.dispatchEvent(forged);
    assert.deepEqual([sent, forged.defaultPrevented], [[], false]);
  });
});

describe("createCommands", () => {
  it("lists the shortcuts for this platform and fires onCommand with the tab", async () => {
    const commands = createCommands(config, createLogger("test"), "windows");
    assert.deepEqual(await (commands.api.getAll as () => Promise<unknown>)(), [
      { name: "toggle", description: "Toggle", shortcut: "Ctrl+Shift+Y" },
      { name: "next", description: "", shortcut: "Alt+Period" },
      { name: "unbound", description: "", shortcut: "" },
    ]);
    const fired: unknown[] = [];
    commands.api.onCommand.addListener((name: string, tab: unknown) => fired.push([name, tab]));
    commands.fire("toggle", { id: 3 });
    assert.deepEqual(fired, [["toggle", { id: 3 }]]);
  });
});
