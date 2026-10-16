// chrome.contextMenus and the toolbar button, as menu commands every tab registers from the background's menu state.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger, readLastError } from "../../src/runtime/chrome.ts";
import type { RuntimeConfig } from "../../src/runtime/config.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { createMenus, showMenus, type MenuClick } from "../../src/runtime/menus.ts";
import { createHub, type Hub } from "../support/gm-hub.ts";
import { eventually } from "../support/time.ts";

// The page the tab's menu commands are for.
(globalThis as { location?: unknown }).location = new URL("https://page.test/app");

const config = (extra: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ name: "Ext", ns: "t", id: "id", manifest: {}, groups: [], assets: {}, locales: {}, ...extra });

/** A tab with menu commands: what it registered, and a way to click one. */
function tabWithMenu(hub: Hub) {
  const commands = new Map<number, [string, () => void]>();
  let next = 0;
  const gm = createGm({
    ...hub.tab(),
    GM_registerMenuCommand: (caption, onClick) => (commands.set(++next, [caption, onClick]), next),
    GM_unregisterMenuCommand: (id) => void commands.delete(Number(id)),
  });
  return {
    gm,
    captions: () => [...commands.values()].map(([caption]) => caption),
    click: (caption: string) => [...commands.values()].find(([text]) => text === caption)?.[1](),
  };
}

async function setup(extra: Partial<RuntimeConfig> = {}, persistent = false) {
  const hub = createHub();
  const background = await createMenus({ gm: createGm(hub.tab()), ns: "t", log: createLogger("test"), config: config(extra), persistent });
  const tab = tabWithMenu(hub);
  const tabInfo = { id: 7 };
  // The tab's clicks reach the background as the messaging layer would deliver them.
  await showMenus({
    gm: tab.gm,
    ns: "t",
    log: createLogger("test"),
    config: config(extra),
    emit: async (type, data) => (type === "menu-click" ? background.click(data as MenuClick, tabInfo) : background.actionClick(tabInfo)),
  });
  const menus = background.contextMenus as unknown as Record<string, (...args: unknown[]) => unknown> & { onClicked: { addListener(fn: (info: Record<string, unknown>, tab: unknown) => void): void } };
  const action = background.action as unknown as Record<string, (...args: unknown[]) => Promise<unknown>> & { onClicked: { addListener(fn: (tab: unknown) => void): void } };
  return { hub, menus, action, tab };
}

describe("context menus", () => {
  it("shows each item a page can show as a menu command, child under parent, checkboxes marked", async () => {
    const { menus, tab } = await setup();
    menus.create({ id: "root", title: "Tools" });
    menus.create({ id: "a", parentId: "root", title: "Search '%s'", contexts: ["selection"] });
    menus.create({ id: "b", title: "Dark mode", type: "checkbox", checked: true });
    menus.create({ id: "link", title: "Open link", contexts: ["link"] });
    menus.create({ id: "sep", type: "separator" });
    menus.create({ id: "off", title: "Off", enabled: false });
    menus.create({ id: "elsewhere", title: "Elsewhere", documentUrlPatterns: ["https://other.test/*"] });
    await eventually(() => tab.captions().length === 2, 1000);
    assert.deepEqual(tab.captions(), ["Tools › Search '…'", "☑ Dark mode"]);
  });

  it("fires onClicked with the page's URL, toggling a checkbox, and keeps up with updates and removals", async () => {
    const { menus, tab } = await setup();
    const clicks: Array<[Record<string, unknown>, unknown]> = [];
    menus.onClicked.addListener((info, clickedTab) => clicks.push([info, clickedTab]));
    menus.create({ id: "dark", title: "Dark mode", type: "checkbox" });
    await eventually(() => tab.captions().includes("☐ Dark mode"), 1000);
    tab.click("☐ Dark mode");
    await eventually(() => clicks.length === 1, 1000);
    assert.deepEqual(clicks[0], [{ menuItemId: "dark", pageUrl: location.href, editable: false, wasChecked: false, checked: true }, { id: 7 }]);
    await eventually(() => tab.captions().includes("☑ Dark mode"), 1000);
    await menus.update("dark", { title: "Night" });
    await eventually(() => tab.captions().includes("☑ Night"), 1000);
    await menus.remove("dark");
    await eventually(() => tab.captions().length === 0, 1000);
  });

  it("reports a duplicate or unknown id as lastError, and removes an item's children with it", async () => {
    const { hub, menus } = await setup();
    menus.create({ id: "x", title: "X" });
    menus.create({ id: "y", parentId: "x", title: "Y" });
    const error = await new Promise((resolve) => menus.create({ id: "x", title: "again" }, () => resolve(readLastError()?.message)));
    assert.equal(error, "Cannot create item with duplicate id x");
    await assert.rejects(menus.update("nope", {}) as Promise<unknown>, /Cannot find menu item with id nope/);
    await menus.remove("x");
    assert.deepEqual((hub.store.get("x2u:t:menus") as { items: unknown[] }).items, []);
    assert.equal((menus.ContextType as unknown as Record<string, string>).SELECTION, "selection");
  });

  it("keeps an event page's items from one start to the next, but not a persistent page's or ones without an id", async () => {
    const hub = createHub();
    hub.store.set("x2u:t:menus", { items: [{ id: "kept", title: "Kept", type: "normal", contexts: ["page"], checked: false, enabled: true, visible: true }, { id: "1", title: "Generated", type: "normal", contexts: ["page"], checked: false, enabled: true, visible: true, generated: true }], action: { enabled: true } });
    const eventPage = await createMenus({ gm: createGm(hub.tab()), ns: "t", log: createLogger("test"), config: config(), persistent: false });
    assert.equal(await new Promise((resolve) => (eventPage.contextMenus.create as (p: object, cb: () => void) => string)({ id: "kept" }, () => resolve(readLastError()?.message))), "Cannot create item with duplicate id kept");
    const persistentPage = await createMenus({ gm: createGm(hub.tab()), ns: "t", log: createLogger("test"), config: config(), persistent: true });
    assert.equal(typeof persistentPage.contextMenus.create({ id: "kept" }), "string");
  });
});

describe("toolbar button", () => {
  it("shows a button without a popup as a menu command, with its title and badge, and fires action.onClicked", async () => {
    const { action, tab } = await setup({ action: { key: "action", title: "Do it", popup: false } });
    const clicked: unknown[] = [];
    action.onClicked.addListener((clickedTab) => clicked.push(clickedTab));
    await eventually(() => tab.captions().includes("Do it"), 1000);
    await action.setBadgeText({ text: "3" });
    await eventually(() => tab.captions().includes("Do it (3)"), 1000);
    tab.click("Do it (3)");
    await eventually(() => clicked.length === 1, 1000);
    assert.deepEqual(clicked, [{ id: 7 }]);
    await action.disable();
    await eventually(() => tab.captions().length === 0, 1000);
    assert.equal(await action.isEnabled(), false);
    assert.equal(await action.getTitle({}), "Do it");
  });

  it("shows no command for a button with a popup, or for an extension without a button", async () => {
    assert.deepEqual((await setup({ action: { key: "action", popup: true } })).tab.captions(), []);
    assert.deepEqual((await setup()).tab.captions(), []);
  });
});
