// Store downloads (spec §7). Plan 1 needs only the Chrome Web Store; AMO and Edge come with the CLI.

/** Chrome version reported to the Web Store; some extensions are only served to recent versions. */
export const CWS_PRODVERSION = "153.0.0.0";

export function cwsCrxUrl(id: string): string {
  if (!/^[a-p]{32}$/.test(id)) throw new Error(`Not a Chrome Web Store extension ID: ${id}`);
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${CWS_PRODVERSION}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
}

export async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}
