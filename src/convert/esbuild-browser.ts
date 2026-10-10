// esbuild-wasm for browser callers. Call it inside a Web Worker: with worker: false, esbuild runs on the calling thread.
import * as esbuild from "esbuild-wasm";
import type { EsbuildApi } from "./esbuild.ts";

let ready: Promise<void> | undefined;

export async function loadEsbuild(wasmURL: string): Promise<EsbuildApi> {
  if (!ready) {
    ready = esbuild.initialize({ wasmURL, worker: false });
    // A failed init (say, one failed fetch of the wasm) must not stick: clear it so the next call tries again.
    ready.catch(() => {
      ready = undefined;
    });
  }
  await ready;
  return esbuild;
}
