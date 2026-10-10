// Spike S3 worker: unpack and bundle in a Web Worker with esbuild-wasm, then report a hash of the output.
import { bundleModule } from "../../../src/convert/esbuild.ts";
import { loadEsbuild } from "../../../src/convert/esbuild-browser.ts";
import { unpack } from "../../../src/convert/unpack.ts";

type Job = { url: string; entry: string };
const scope = self as unknown as { onmessage: ((event: MessageEvent<Job>) => void) | null; postMessage(message: unknown): void };

scope.onmessage = async (event) => {
  const started = performance.now();
  try {
    const esbuild = await loadEsbuild("/esbuild.wasm");
    const files = unpack(new Uint8Array(await (await fetch(event.data.url)).arrayBuffer()));
    const { code } = await bundleModule(esbuild, files, event.data.entry);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)));
    scope.postMessage({ sha256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""), ms: performance.now() - started, bytes: code.length });
  } catch (error) {
    scope.postMessage({ error: String(error) });
  }
};
