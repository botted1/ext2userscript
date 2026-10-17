// The popup and options pages' runtime pieces that run without a DOM.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEvent, createLogger, withFallback } from "../../src/runtime/chrome.ts";
import { createPageScope, scopeToPage } from "../../src/runtime/pages.ts";

describe("scopeToPage", () => {
  it("removes the listeners a page added and disconnects the ports it opened, and nothing else", () => {
    const log = createLogger("test");
    const onMessage = createEvent<() => void>(log);
    const onChanged = createEvent<() => void>(log);
    const disconnected: string[] = [];
    const chrome = {
      // A namespace with fallbacks answers every name, addListener included: it mustn't pass for an event.
      runtime: withFallback(log, "runtime", { onMessage: onMessage.event, connect: (info: { name: string }) => ({ name: info.name, onDisconnect: {}, disconnect: () => disconnected.push(info.name) }) }, "all"),
      storage: { local: { onChanged: onChanged.event } },
    };
    const scope = createPageScope();
    const page = scopeToPage(chrome, scope) as typeof chrome;
    const listener = () => {};
    const tabs = () => {};
    page.runtime.onMessage.addListener(listener);
    page.storage.local.onChanged.addListener(listener);
    page.runtime.connect({ name: "popup" });
    onMessage.event.addListener(tabs);
    assert.equal(page.storage.local, page.storage.local);
    scope.close();
    assert.deepEqual([onMessage.event.hasListener(listener), onMessage.event.hasListener(tabs), onChanged.event.hasListeners()], [false, true, false]);
    assert.deepEqual(disconnected, ["popup"]);
  });

  it("after the page has closed, adds none of its listeners and disconnects a port it opens at once", () => {
    const onMessage = createEvent<() => void>(createLogger("test"));
    const disconnected: string[] = [];
    const chrome = { runtime: { onMessage: onMessage.event, connect: (info: { name: string }) => ({ name: info.name, onDisconnect: {}, disconnect: () => disconnected.push(info.name) }) } };
    const scope = createPageScope();
    const page = scopeToPage(chrome, scope) as typeof chrome;
    scope.close();
    page.runtime.onMessage.addListener(() => {});
    page.runtime.connect({ name: "late" });
    assert.equal(onMessage.event.hasListeners(), false);
    assert.deepEqual(disconnected, ["late"]);
  });
});
