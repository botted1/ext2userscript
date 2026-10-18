// The optional download proxy (spec §8): a Cloudflare Worker that fetches an extension's archive from its store for
// the web app, which can't fetch it itself (the stores send no CORS headers). Off by default; see proxy/README.md.
import { parseStoreUrl, storeArchive } from "../src/download.ts";

export const MAX_BYTES = 50 * 1024 * 1024;

export type Env = { ALLOWED_ORIGIN?: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only the configured site may read the answers; without one, no site can.
    const headers = { "access-control-allow-origin": env.ALLOWED_ORIGIN ?? "", "cache-control": "no-store" };
    const text = (status: number, message: string) => new Response(message, { status, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
    if (request.method !== "GET") return text(405, "Only GET is allowed");
    let store;
    try {
      store = parseStoreUrl(new URL(new URL(request.url).searchParams.get("src") ?? ""));
    } catch {
      // Not a URL at all.
    }
    if (!store) return text(400, "src must be a Chrome Web Store, Firefox Add-ons or Edge Add-ons page");
    try {
      const archive = await storeArchive(store, { maxBytes: MAX_BYTES });
      return new Response(archive, { headers: { ...headers, "content-type": "application/octet-stream" } });
    } catch (error) {
      return text(502, error instanceof Error ? error.message : String(error));
    }
  },
};
