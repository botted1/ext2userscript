// The web app's conversion worker (spec §8): unpacks and converts off the page's thread, so the page stays responsive.
// esbuild-wasm (14 MB) loads only when a conversion needs it: a module background or page.
import { loadEsbuild } from "../src/convert/esbuild-browser.ts";
import { lazyEsbuild } from "../src/convert/esbuild.ts";
import { convert } from "../src/convert/index.ts";
import { unpack } from "../src/convert/unpack.ts";
import type { Job, WorkerMessage } from "./protocol.ts";

/** The built runtime, put in by web/build.ts. */
declare const __X2U_RUNTIME__: string;

const scope = self as unknown as { onmessage: ((event: MessageEvent<Job>) => void) | null; postMessage(message: WorkerMessage): void; location: Location };
let job = 0;
let esbuildLoaded = false;
const esbuild = lazyEsbuild(() => {
  if (!esbuildLoaded) scope.postMessage({ id: job, type: "progress", text: "Loading esbuild (once; 14 MB)…" });
  esbuildLoaded = true;
  return loadEsbuild(new URL("esbuild.wasm", scope.location.href).href);
});

scope.onmessage = async ({ data }) => {
  const id = (job = data.id);
  try {
    scope.postMessage({ id, type: "progress", text: "Reading the archive…" });
    const files = unpack(new Uint8Array(data.bytes));
    scope.postMessage({ id, type: "progress", text: "Converting…" });
    const { userscript, report } = await convert(files, { runtime: __X2U_RUNTIME__, esbuild });
    scope.postMessage({ id, type: "done", userscript, report });
  } catch (error) {
    scope.postMessage({ id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
