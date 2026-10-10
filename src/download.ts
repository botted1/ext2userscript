// Store downloads (spec §7): Chrome Web Store, Firefox Add-ons (AMO) and Edge Add-ons, plus plain URLs.
// Works in Node and in a browser (the proxy and web app will reuse it).

/** Chrome version reported to the Web Store; some extensions are only served to recent versions. */
export const CWS_PRODVERSION = "153.0.0.0";

const ID = /^[a-p]{32}$/;

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
export async function fetchBytes(url: string, { timeoutMs = 60_000, maxBytes = 100 * 1024 * 1024 }: FetchLimits = {}): Promise<Uint8Array> {
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
