// Final assembly (spec §3, §5): the header, then one function holding the runtime and a start() call with the config
// and each content group's code.
// - Isolated-world code becomes a factory: function (chrome, browser) { return function () { <code> }; }. The outer
//   parameters give the code its chrome and browser, and the inner function is a scope of its own, so the code may
//   still declare `const browser = …` itself.
// - MAIN-world code stays text: the runtime puts it in the page with gm.addElement.
import type { RuntimeConfig } from "../runtime/config.ts";
import type { ContentCode } from "./bundle.ts";

export function emit(header: string, runtime: string, config: RuntimeConfig, code: readonly ContentCode[]): string {
  const groups = code.map((group) => {
    if (group === null) return "null";
    if (group.world === "MAIN") return JSON.stringify(group.code);
    return `function (chrome, browser) {\nreturn function () {\n${group.code}\n};\n}`;
  });
  return `${header}\n\n(function () {\n${runtime}\n__x2uRuntime.start(${JSON.stringify(config)}, [\n${groups.join(",\n")}\n]);\n})();\n`;
}
