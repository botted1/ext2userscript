// chrome.scripting and MV2's tabs.executeScript / insertCSS / removeCSS (spec §5.2): the background sends the work to
// the target tab as a control request, and the tab runs it.
// - files: the converter bundled the extension files the background names, so they run like content scripts.
// - func (and MV2's code): its source runs through new Function (or eval), with this tab's chrome object. That is the
//   one place the runtime evaluates extension code, as a function's source is all there is to send. Where the page's
//   CSP forbids eval (Tampermonkey's sandbox follows it), the function runs in the page's world instead, through
//   gm.addElement, without chrome.*.
// - CSS goes in as a <style> through gm.addElement, and removeCSS takes out the same text.
// Ceilings: only the tab's top frame; a file's result is null (its completion value can't be read without eval); MV2
// code that can't be evaluated runs in the page's world with a null result.
import type { Assets } from "./assets.ts";
import { method, type Logger } from "./chrome.ts";
import type { InjectableCode } from "./config.ts";
import type { Gm } from "./gm.ts";
import type { Messaging } from "./messaging.ts";
import type { Network } from "./net.ts";

type Target = { tabId: number; frameIds?: number[]; allFrames?: boolean };
type ExecuteDetails = { target: Target; func?: (...args: unknown[]) => unknown; args?: unknown[]; files?: string[]; world?: "ISOLATED" | "MAIN" };
type CssDetails = { target: Target; css?: string; files?: string[] };
type ExecuteRequest = { files?: string[]; func?: string; args?: unknown[]; code?: string; world: "ISOLATED" | "MAIN" };

/** The background's side: chrome.scripting, and the MV2 members on chrome.tabs. */
export function createScripting(deps: { messaging: Messaging; assets: Pick<Assets, "text">; log: Logger; currentTab(): Promise<number | undefined> }) {
  const { messaging, log } = deps;
  const run = async (tabId: number, request: ExecuteRequest) => [{ frameId: 0, result: (await messaging.control(tabId, "execute", request)) ?? null }];
  const cssText = (details: { css?: string; files?: string[]; code?: string; file?: string }) =>
    [details.css ?? details.code ?? "", ...[...(details.files ?? []), ...(details.file ? [details.file] : [])].map((path) => deps.assets.text(path.replace(/^\/+/, "")) ?? "")].join("\n");
  const css = (tabId: number, text: string, remove: boolean) => messaging.control(tabId, "css", { css: text, remove });
  /** tabs.executeScript([tabId], details): the current tab when there is no id. */
  const tabArgs = async (args: unknown[]) => {
    const [tabId, details] = typeof args[0] === "number" ? [args[0], args[1]] : [await deps.currentTab(), args[0]];
    if (tabId === undefined) throw new Error("No tab to inject into");
    return [tabId, (details ?? {}) as { code?: string; file?: string }] as const;
  };

  return {
    scripting: {
      ExecutionWorld: { ISOLATED: "ISOLATED", MAIN: "MAIN" },
      StyleOrigin: { AUTHOR: "AUTHOR", USER: "USER" },
      executeScript: method(log, (details: ExecuteDetails) =>
        run(details.target.tabId, {
          ...(details.files ? { files: details.files } : {}),
          ...(details.func ? { func: details.func.toString(), args: details.args ?? [] } : {}),
          world: details.world ?? "ISOLATED",
        }),
      ),
      insertCSS: method(log, async (details: CssDetails) => void (await css(details.target.tabId, cssText(details), false))),
      removeCSS: method(log, async (details: CssDetails) => void (await css(details.target.tabId, cssText(details), true))),
    },
    tabs: {
      executeScript: method(log, async (...args: unknown[]) => {
        const [tabId, details] = await tabArgs(args);
        const result = await run(tabId, { ...(details.code !== undefined ? { code: details.code } : {}), ...(details.file ? { files: [details.file] } : {}), world: "ISOLATED" });
        return result.map((entry) => entry.result);
      }),
      insertCSS: method(log, async (...args: unknown[]) => {
        const [tabId, details] = await tabArgs(args);
        await css(tabId, cssText(details), false);
      }),
      removeCSS: method(log, async (...args: unknown[]) => {
        const [tabId, details] = await tabArgs(args);
        await css(tabId, cssText(details), true);
      }),
    },
  };
}

/** The tab's side: runs what the background sent. */
export function createInjector(deps: { gm: Gm; chrome: object; network: Network; injectables: InjectableCode; withGlobals<T>(chrome: object, run: () => T): T; log: Logger }) {
  const { gm, log } = deps;
  const root = () => document.head ?? document.documentElement;
  const styles = new Map<string, Element[]>();

  /** Runs source in the page's world through gm.addElement, which gets past the page's CSP; resolves with its result. */
  const inPage = async (expression: string): Promise<unknown> => {
    const source = `(function () {
  var script = document.currentScript;
  script.setAttribute("data-ran", "");
  function done(key, value) { script.setAttribute(key, JSON.stringify(value === undefined ? null : value)); script.dispatchEvent(new Event("x2u-done")); }
  try {
    var result = ${expression};
    if (result && typeof result.then === "function") result.then(function (value) { done("data-result", value); }, function (error) { done("data-error", String(error && error.message || error)); });
    else done("data-result", result);
  } catch (error) { done("data-error", String(error && error.message || error)); }
})();`;
    const element = await gm.addElement(root(), "script", { textContent: source });
    // The script runs as it goes in; one that didn't run was blocked, and one with a promise result finishes later.
    if (!element.hasAttribute("data-ran")) {
      element.remove();
      throw new Error("ext2userscript: the page blocked the script executeScript put in it");
    }
    if (!element.hasAttribute("data-result") && !element.hasAttribute("data-error")) await new Promise((resolve) => element.addEventListener("x2u-done", resolve, { once: true }));
    element.remove();
    const error = element.getAttribute("data-error");
    if (error !== null) throw new Error(JSON.parse(error) as string);
    return JSON.parse(element.getAttribute("data-result") ?? "null");
  };

  const isEvalBlocked = (error: unknown) => error instanceof EvalError || (error instanceof Error && /Content Security Policy|unsafe-eval/.test(error.message));

  const execute = async (request: ExecuteRequest): Promise<unknown> => {
    for (const path of request.files ?? []) {
      const factory = deps.injectables[path.replace(/^\/+/, "")];
      if (!factory) throw new Error(`Could not load file: '${path}'.`);
      if (request.world === "MAIN") await inPage(`(${factory.toString()})(undefined, undefined, window.fetch, window.XMLHttpRequest)()`);
      else deps.withGlobals(deps.chrome, factory(deps.chrome, deps.chrome, deps.network.fetch, deps.network.XMLHttpRequest));
    }
    if (request.func !== undefined) {
      const args = request.args ?? [];
      const inPageWorld = () => inPage(`(${request.func})(...${JSON.stringify(args)})`);
      if (request.world === "MAIN") return inPageWorld();
      let fn: (...args: unknown[]) => unknown;
      try {
        fn = new Function("chrome", "browser", "fetch", "XMLHttpRequest", `return (${request.func});`)(deps.chrome, deps.chrome, deps.network.fetch, deps.network.XMLHttpRequest);
      } catch (error) {
        if (!isEvalBlocked(error)) throw error;
        log.once("scripting-eval", "this page's CSP forbids eval, so executeScript's function runs in the page's world, without chrome.*");
        return inPageWorld();
      }
      return await deps.withGlobals(deps.chrome, () => fn(...args));
    }
    if (request.code !== undefined) {
      try {
        return deps.withGlobals(deps.chrome, () => (0, eval)(request.code as string));
      } catch (error) {
        if (!isEvalBlocked(error)) throw error;
        log.once("scripting-eval", "this page's CSP forbids eval, so executeScript's code runs in the page's world, without chrome.*");
        await gm.addElement(root(), "script", { textContent: request.code });
        return null;
      }
    }
    return null;
  };

  const css = async ({ css: text, remove }: { css: string; remove: boolean }) => {
    if (remove) {
      for (const element of styles.get(text) ?? []) element.remove();
      styles.delete(text);
      return null;
    }
    const element = await gm.addElement(root(), "style", { textContent: text });
    styles.set(text, [...(styles.get(text) ?? []), element]);
    return null;
  };

  return {
    /** A control request this injector answers, or undefined for one it doesn't. */
    run(op: string, args: unknown): Promise<unknown> | undefined {
      if (op === "execute") return execute(args as ExecuteRequest);
      if (op === "css") return css(args as { css: string; remove: boolean });
      return undefined;
    },
  };
}
