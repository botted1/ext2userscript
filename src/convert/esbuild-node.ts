// Native esbuild for Node callers (the CLI and tests).
import * as esbuild from "esbuild";
import type { EsbuildApi } from "./esbuild.ts";

export async function loadEsbuild(): Promise<EsbuildApi> {
  return esbuild;
}
