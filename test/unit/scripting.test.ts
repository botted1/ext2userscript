// chrome.scripting and MV2's tabs.executeScript: the background's requests, and the tab running them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withGlobals } from "../../src/runtime/content.ts";
import { createLogger } from "../../src/runtime/chrome.ts";
import { createGm } from "../../src/runtime/gm.ts";
import type { Messaging } from "../../src/runtime/messaging.ts";
import type { Network } from "../../src/runtime/net.ts";
import { createInjector, createScripting, isEvalBlocked } from "../../src/runtime/scripting.ts";

type Api = Record<string, (...args: unknown[]) => Promise<unknown>>;
const log = createLogger("test");

/** The background's side, over a fake control channel that answers with `answer` and records what it was asked. */
function background(answer: unknown = "done") {
  const sent: unknown[][] = [];
  const messaging = { control: async (tabId: number, op: string, args: unknown) => (sent.push([tabId, op, args]), answer) } as unknown as Messaging;
  const scripting = createScripting({ messaging, assets: { text: (path) => (path === "css/a.css" ? "a { color: red }" : undefined) }, log, currentTab: async () => 9 });
  return { sent, scripting: scripting.scripting as unknown as Api, tabs: scripting.tabs as unknown as Api };
}

describe("createScripting", () => {
  it("sends a function's source and arguments to the target tab, and answers with Chrome's result list", async () => {
    const { sent, scripting } = background(42);
    const results = await scripting.executeScript({ target: { tabId: 3 }, func: (a: number, b: number) => a + b, args: [1, 2] });
    assert.deepEqual(results, [{ frameId: 0, result: 42 }]);
    // Node's type stripping leaves spaces where the annotations were, so the source is compared without them.
    const request = sent[0][2] as { func: string };
    assert.deepEqual([sent[0][0], sent[0][1], { ...request, func: request.func.replace(/\s+/g, "") }], [3, "execute", { func: "(a,b)=>a+b", args: [1, 2], world: "ISOLATED" }]);
    await scripting.executeScript({ target: { tabId: 3 }, files: ["inject.js"], world: "MAIN" });
    assert.deepEqual(sent[1], [3, "execute", { files: ["inject.js"], world: "MAIN" }]);
  });

  it("sends CSS text, reading files from the asset table", async () => {
    const { sent, scripting } = background();
    await scripting.insertCSS({ target: { tabId: 4 }, files: ["css/a.css"] });
    await scripting.removeCSS({ target: { tabId: 4 }, css: "b {}" });
    assert.deepEqual(sent, [[4, "css", { css: "\na { color: red }", remove: false }], [4, "css", { css: "b {}", remove: true }]]);
  });

  it("gives MV2's tabs.executeScript the current tab when no id is given, and a plain result list", async () => {
    const { sent, tabs } = background("title");
    assert.deepEqual(await tabs.executeScript({ code: "document.title" }), ["title"]);
    assert.deepEqual(sent, [[9, "execute", { code: "document.title", world: "ISOLATED" }]]);
  });
});

describe("isEvalBlocked", () => {
  it("knows Chrome's and Firefox's CSP refusals, and an EvalError from another realm, but not other errors", () => {
    assert.equal(isEvalBlocked(new EvalError("Evaluating a string as JavaScript violates the following Content Security Policy directive")), true);
    assert.equal(isEvalBlocked(new Error("call to Function() blocked by CSP")), true);
    assert.equal(isEvalBlocked({ name: "EvalError", message: "x" }), true);
    assert.equal(isEvalBlocked(new TypeError("x is not a function")), false);
  });
});

describe("createInjector", () => {
  const chrome = { runtime: { id: "ext" } };
  const network = { fetch: async () => new Response(""), XMLHttpRequest: class {} } as unknown as Network;
  const injector = (injectables = {}) => createInjector({ gm: createGm({}), chrome, network, injectables, withGlobals, log });

  it("runs a bundled file like a content script, with this tab's chrome object", async () => {
    const seen: unknown[] = [];
    const run = injector({ "inject.js": (c: unknown) => () => void seen.push(c, (globalThis as { chrome?: unknown }).chrome) }).run("execute", { files: ["/inject.js"], world: "ISOLATED" });
    assert.equal(await run, null);
    assert.deepEqual(seen, [chrome, chrome]);
    await assert.rejects(injector().run("execute", { files: ["missing.js"], world: "ISOLATED" }) as Promise<unknown>, /Could not load file: 'missing\.js'/);
  });

  it("finds a file named with ./ or a leading slash, as Chrome does", async () => {
    const seen: string[] = [];
    const run = injector({ "js/inject.js": () => () => void seen.push("ran") });
    await run.run("execute", { files: ["./js/inject.js"], world: "ISOLATED" });
    await run.run("execute", { files: ["/js/./inject.js"], world: "ISOLATED" });
    assert.deepEqual(seen, ["ran", "ran"]);
  });

  it("runs a function's source with its arguments and chrome, waiting for a promise", async () => {
    const run = injector().run("execute", { func: "async (n) => chrome.runtime.id + n", args: [1], world: "ISOLATED" });
    assert.equal(await run, "ext1");
  });

  it("evaluates MV2 code to its last value, with chrome as a global", async () => {
    assert.equal(await injector().run("execute", { code: "var x = 2; chrome.runtime.id + x", world: "ISOLATED" }), "ext2");
    assert.equal(injector().run("navigate", {}), undefined);
  });
});
