// Store downloads (spec §7): Chrome Web Store, Firefox Add-ons (AMO) and Edge Add-ons, plus plain URLs.
// Works in Node, in a browser and in a Cloudflare Worker: the CLI, the web app and the download proxy share it.

/** Chrome version reported to the Web Store; some extensions are only served to recent versions. */
export const CWS_PRODVERSION = "153.0.0.0";

const ID = /^[a-p]{32}$/;

/** An extension in one of the three stores. */
export type StoreSource = { kind: "cws"; id: string } | { kind: "edge"; id: string } | { kind: "amo"; slug: string };

/** The store an extension's page URL belongs to, or undefined for any other URL. */
export function parseStoreUrl(url: URL): StoreSource | undefined {
  const segments = url.pathname.split("/").filter(Boolean);
  const host = url.hostname.toLowerCase();
  const id = segments.filter((segment) => ID.test(segment)).pop();
  if ((host === "chromewebstore.google.com" || (host === "chrome.google.com" && segments[0] === "webstore")) && id) return { kind: "cws", id };
  if (host === "microsoftedge.microsoft.com" && id) return { kind: "edge", id };
  const addon = segments.indexOf("addon");
  if (host === "addons.mozilla.org" && addon !== -1 && segments[addon + 1]) return { kind: "amo", slug: decodeURIComponent(segments[addon + 1]) };
  return undefined;
}

/** A store extension's archive: a .crx from the Chrome Web Store or Edge Add-ons, a .xpi from AMO. */
export async function storeArchive(store: StoreSource, limits: FetchLimits = {}): Promise<Uint8Array<ArrayBuffer>> {
  switch (store.kind) {
    case "cws":
      return fetchBytes(cwsCrxUrl(store.id), limits);
    case "edge":
      return fetchBytes(edgeCrxUrl(store.id), limits);
    case "amo":
      return fetchBytes(await amoXpiUrl(store.slug), limits);
  }
}

export function cwsCrxUrl(id: string): string {
  if (!ID.test(id)) throw new Error(`Not a Chrome Web Store extension ID: ${id}`);
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${CWS_PRODVERSION}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
}

export function edgeCrxUrl(id: string): string {
  if (!ID.test(id)) throw new Error(`Not an Edge Add-ons extension ID: ${id}`);
  return `https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=id%3D${id}%26installsource%3Dondemand%26uc`;
}

/** AMO API v5 for an add-on's slug, numeric ID or GUID. */
export const amoAddonUrl = (slug: string): string => `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(slug)}/`;

/** The current version's .xpi URL, from AMO API v5. */
export async function amoXpiUrl(slug: string): Promise<string> {
  const addon = JSON.parse(new TextDecoder().decode(await fetchBytes(amoAddonUrl(slug), { maxBytes: 5 * 1024 * 1024 }))) as {
    current_version?: { file?: { url?: unknown } };
  };
  const url = addon.current_version?.file?.url;
  if (typeof url !== "string") throw new Error(`AMO has no downloadable version of ${slug}`);
  return url;
}

export type FetchLimits = { timeoutMs?: number; maxBytes?: number };

/** Downloads a URL, failing after timeoutMs (default 60 s) or beyond maxBytes (default 100 MiB). */
export async function fetchBytes(url: string, { timeoutMs = 60_000, maxBytes = 100 * 1024 * 1024 }: FetchLimits = {}): Promise<Uint8Array<ArrayBuffer>> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal });
  } catch (error) {
    throw new Error(signal.aborted ? `Download timed out after ${timeoutMs / 1000} s: ${url}` : `Download failed (${(error as Error).message}): ${url}`, { cause: error });
  }
  if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  try {
    for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader?.read()) {
      length += chunk.value.length;
      if (length > maxBytes) throw new Error(`Download is larger than ${maxBytes / 1024 / 1024} MiB: ${url}`);
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader?.cancel().catch(() => {});
    if (signal.aborted) throw new Error(`Download timed out after ${timeoutMs / 1000} s: ${url}`, { cause: error });
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
