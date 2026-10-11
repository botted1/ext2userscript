// Content-script boot (spec §5.5). Each group whose URL filter matches this page (and this frame) gets:
// - its CSS, injected through gm.addElement as soon as there is a document element (Chrome injects content CSS early);
// - its JS at its run_at: isolated-world code called with this extension's chrome object, MAIN-world code put in the
//   page through gm.addElement. One failing group doesn't stop the others (spec §9).
// It also makes <script src=runtime.getURL(...)> work: such a script is swapped for gm.addElement with the file's text.
import type { Assets } from "./assets.ts";
import type { Logger } from "./chrome.ts";
import type { GroupCode, RunAt, RuntimeConfig } from "./config.ts";
import type { Gm } from "./gm.ts";
import { filterMatches } from "./match.ts";

type Deps = { gm: Gm; chrome: object; assets: Assets; log: Logger };

export function runContent(config: RuntimeConfig, code: readonly GroupCode[], deps: Deps): void {
  const inFrame = window.top !== window;
  const groups = config.groups
    .map((group, index) => ({ group, index, code: code[index] }))
    .filter(({ group }) => (!inFrame || group.allFrames) && filterMatches(location.href, group));
  if (groups.length === 0) return;
  if (groups.some(({ code: c }) => typeof c === "function")) interceptAssetScripts(deps);

  const root = () => document.head ?? document.documentElement;
  whenRoot(() => {
    for (const { group } of groups) {
      for (const css of group.css) deps.gm.addElement(root(), "style", { textContent: deps.assets.css(css) }).catch((error: unknown) => deps.log.error(error));
    }
  });

  for (const { group, index, code: c } of groups) {
    if (c === null || c === undefined) continue;
    const run = () => {
      try {
        if (typeof c === "string") deps.gm.addElement(root(), "script", { textContent: c }).catch((error: unknown) => deps.log.error(error));
        else withGlobals(deps.chrome, c(deps.chrome, deps.chrome));
      } catch (error) {
        deps.log.error(`content_scripts[${index}] failed:`, error);
      }
    };
    // MAIN-world code needs an element to go into; isolated-world code at document_start runs at once, as in Chrome.
    if (group.runAt === "document_start") (typeof c === "string" ? whenRoot : (fn: () => void) => fn())(run);
    else whenParsed(group.runAt, run);
  }
}

/** document_end runs at DOMContentLoaded; document_idle runs in a task after that, so after every document_end group. */
function whenParsed(runAt: Exclude<RunAt, "document_start">, fn: () => void): void {
  const run = runAt === "document_end" ? fn : () => setTimeout(fn, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
}

/** A userscript can start before <html> exists; this waits for it. */
function whenRoot(fn: () => void): void {
  if (document.documentElement) return fn();
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    fn();
  });
  observer.observe(document, { childList: true });
}

/**
 * Runs a group's code with globalThis.chrome and globalThis.browser set to this extension's object, then restores
 * them. webextension-polyfill 0.10+ checks globalThis.chrome?.runtime?.id while it loads; code that reads those globals
 * later, from a callback, sees the originals (a ceiling).
 */
function withGlobals(chrome: object, fn: () => void): void {
  // Reflect, not delete or defineProperty: a manager's sandbox global can be a proxy that reports a change as refused
  // (Violentmonkey's delete does, while removing the property), and strict mode would turn that report into an error
  // after the group's code has already run.
  const global = globalThis as unknown as Record<string, unknown>;
  const saved = (["chrome", "browser"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(global, name)] as const);
  for (const [name, descriptor] of saved) {
    if (!descriptor || descriptor.configurable) Reflect.defineProperty(global, name, { value: chrome, configurable: true, writable: true });
  }
  try {
    fn();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor && !descriptor.configurable) continue;
      if (descriptor) Reflect.defineProperty(global, name, descriptor);
      else Reflect.deleteProperty(global, name);
    }
  }
}

/**
 * Content scripts often run code in the page with <script src=runtime.getURL("inject.js")>. A blob: URL would meet the
 * page's CSP, so when such a script is inserted, gm.addElement inserts the file's text instead, and the original
 * element gets its load event. Patched: appendChild, insertBefore, append and prepend (spec §5.5); the script goes at
 * the end of the parent whatever position was asked for.
 */
function interceptAssetScripts({ gm, assets, log }: Deps): void {
  const assetPath = (node: unknown) =>
    node instanceof HTMLScriptElement && node.src && node.type !== "module" ? assets.pathOf(node.src) : undefined;
  // A script with a src runs after the current task, never during the call that inserted it; so does this one.
  const inject = (parent: Node, script: HTMLScriptElement, path: string) =>
    setTimeout(() =>
      gm.addElement(parent, "script", { textContent: assets.text(path) ?? "" }).then(
        () => script.dispatchEvent(new Event("load")),
        (error: unknown) => {
          log.error(error);
          script.dispatchEvent(new Event("error"));
        },
      ),
    );

  const appendChild = Node.prototype.appendChild;
  Node.prototype.appendChild = function <T extends Node>(this: Node, node: T): T {
    const path = assetPath(node);
    if (path === undefined) return appendChild.call(this, node) as T;
    inject(this, node as unknown as HTMLScriptElement, path);
    return node;
  };
  const insertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, child: Node | null): T {
    const path = assetPath(node);
    if (path === undefined) return insertBefore.call(this, node, child) as T;
    inject(this, node as unknown as HTMLScriptElement, path);
    return node;
  };
  for (const name of ["append", "prepend"] as const) {
    const original = Element.prototype[name];
    Element.prototype[name] = function (this: Element, ...nodes: Array<Node | string>) {
      if (!nodes.some((node) => assetPath(node) !== undefined)) return original.apply(this, nodes);
      for (const node of nodes) {
        const path = assetPath(node);
        if (path === undefined) original.call(this, node);
        else inject(this, node as HTMLScriptElement, path);
      }
    };
  }
}
