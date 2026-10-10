// esbuild-wasm for browser callers. Call it inside a Web Worker: with worker: false, esbuild runs on the calling thread.
import * as esbuild from "esbuild-wasm";
import type { EsbuildApi } from "./esbuild.ts";

let ready: Promise<void> | undefined;

export async function loadEsbuild(wasmURL: string): Promise<EsbuildApi> {
  ready ??= esbuild.initialize({ wasmURL, worker: false });
  await ready;
  return esbuild;
}
