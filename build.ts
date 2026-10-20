// Builds the CLI into dist/cli.js for the npm package: one ES module with the built runtime inside. Its dependencies
// (esbuild, fflate) stay imports, which Node resolves from the installed package's node_modules.
// Usage: npm run build (npm pack and npm publish run it first).
import { build } from "esbuild";
import { loadRuntime } from "./src/convert/runtime-node.ts";

await build({
  entryPoints: [`${import.meta.dirname}/src/cli.ts`],
  outfile: `${import.meta.dirname}/dist/cli.js`,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  define: { __X2U_RUNTIME__: JSON.stringify(await loadRuntime()) },
  logLevel: "warning",
});
