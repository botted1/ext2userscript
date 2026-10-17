// Final assembly (spec §3, §5): the header, then one function holding the runtime and a start() call with the config,
// each content group's code and the background's code.
// - Isolated-world code becomes a factory: function (chrome, browser, fetch, XMLHttpRequest) { return function () { <code> }; }.
//   The outer parameters give the code its chrome and browser and the network shim (spec §5.2), and the inner function
//   is a scope of its own, so the code may still declare `const browser = …` itself.
// - MAIN-world code stays text: the runtime puts it in the page with gm.addElement.
// - The background is a factory too, whose parameters shadow the globals a background reaches (spec §3.3).
// - Files the background may inject with scripting.executeScript({ files }) are content-script factories, by path.
// - The popup and options pages' code are factories too, by kind, with the iframe's globals as parameters (spec §6).
import type { PageKind, RuntimeConfig } from "../runtime/config.ts";
import type { BackgroundBundle, ContentCode } from "./bundle.ts";

/**
 * A background page's code with a function that hands its top-level declarations to the runtime, live (getters and
 * setters), as its window's properties, for getBackgroundPage. It goes first, so it exists even if the code throws, but
 * after a "use strict" directive, which must stay first.
 */
function withExports(background: BackgroundBundle): string {
  if (!background.exports?.length) return background.code;
  const members = background.exports.map((name) => `get ${name}() { return ${name}; }, set ${name}(value) { ${name} = value; }`);
  const directive = /^\s*(["'])use strict\1;?/.exec(background.code)?.[0] ?? "";
  return `${directive}\n__x2uImportMeta.exports = () => ({ ${members.join(", ")} });\n${background.code.slice(directive.length)}`;
}

const factory = (code: string) => `function (chrome, browser, fetch, XMLHttpRequest) {\nreturn function () {\n${code}\n};\n}`;

export function emit(
  header: string,
  runtime: string,
  config: RuntimeConfig,
  code: readonly ContentCode[],
  background: BackgroundBundle | null = null,
  injectables: Readonly<Record<string, string>> = {},
  pages: Readonly<Partial<Record<PageKind, string>>> = {},
): string {
  const groups = code.map((group) => {
    if (group === null) return "null";
    if (group.world === "MAIN") return JSON.stringify(group.code);
    return factory(group.code);
  });
  const files = Object.entries(injectables).map(([path, text]) => `${JSON.stringify(path)}: ${factory(text)}`);
  const backgroundFactory = background
    ? `function (chrome, browser, self, globalThis, window, document, importScripts, localStorage, fetch, XMLHttpRequest, __x2uImportMeta) {\nreturn function () {\n${withExports(background)}\n};\n}`
    : "null";
  const pageFactories = Object.entries(pages).map(
    ([kind, text]) =>
      `${kind}: function (chrome, browser, window, self, globalThis, document, location, history, localStorage, fetch, XMLHttpRequest, setTimeout, setInterval, clearTimeout, clearInterval, DOMParser, __x2uBase) {\nreturn function () {\n${text}\n};\n}`,
  );
  return `${header}\n\n(function () {\n${runtime}\n__x2uRuntime.start(${JSON.stringify(config)}, [\n${groups.join(",\n")}\n], ${backgroundFactory}, {\n${files.join(",\n")}\n}, {\n${pageFactories.join(",\n")}\n});\n})();\n`;
}
