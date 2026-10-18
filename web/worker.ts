// The web app's conversion worker (spec §8): unpacks and converts off the page's thread, so the page stays responsive.
// esbuild-wasm (14 MB) loads only when a conversion needs it: a module background or page.
import { loadEsbuild } from "../src/convert/esbuild-browser.ts";
import { lazyEsbuild } from "../src/convert/esbuild.ts";
import { convert } from "../src/convert/index.ts";
import { unpack } from "../src/convert/unpack.ts";
import { parseStoreUrl } from "../src/download.ts";
import type { Job, WorkerMessage } from "./protocol.ts";

/** The built runtime, and the download proxy's URL (empty without one), put in by web/build.ts. */
declare const __X2U_RUNTIME__: string;
declare const __X2U_PROXY__: string;

const scope = self as unknown as { onmessage: ((event: MessageEvent<Job>) => void) | null; postMessage(message: WorkerMessage): void; location: Location };
let job = 0;
let esbuildLoaded = false;
const esbuild = lazyEsbuild(() => {
  if (!esbuildLoaded) scope.postMessage({ id: job, type: "progress", text: "Loading esbuild (once; 14 MB)…" });
  esbuildLoaded = true;
  return loadEsbuild(new URL("esbuild.wasm", scope.location.href).href);
});

/** An extension's archive from its store page, through the download proxy. */
async function fromStore(link: string): Promise<{ bytes: Uint8Array; extensionId?: string }> {
  let store;
  try {
    store = parseStoreUrl(new URL(link));
  } catch {
    // Not a URL.
  }
  if (!store) throw new Error("That isn't a Chrome Web Store, Firefox Add-ons or Edge Add-ons page");
  const response = await fetch(`${__X2U_PROXY__}?src=${encodeURIComponent(link)}`);
  if (!response.ok) throw new Error((await response.text()) || `The download proxy answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // The store's ID is the extension's ID, as in the CLI (spec §7).
  return store.kind === "amo" ? { bytes } : { bytes, extensionId: store.id };
}

scope.onmessage = async ({ data }) => {
  const id = (job = data.id);
  try {
    scope.postMessage({ id, type: "progress", text: data.kind === "file" ? "Reading the archive…" : "Downloading from the store…" });
    const { bytes, extensionId } = data.kind === "file" ? { bytes: new Uint8Array(data.bytes), extensionId: undefined } : await fromStore(data.link);
    const files = unpack(bytes);
    scope.postMessage({ id, type: "progress", text: "Converting…" });
    const { userscript, report } = await convert(files, { runtime: __X2U_RUNTIME__, esbuild, ...(extensionId ? { extensionId } : {}) });
    scope.postMessage({ id, type: "done", userscript, report });
  } catch (error) {
    scope.postMessage({ id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
