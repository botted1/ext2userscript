// The CLI's <source> (spec §7): a Chrome Web Store, AMO or Edge Add-ons URL or ID, a direct archive URL, a local
// archive or a directory. Node only.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { unpack, type ExtensionFiles } from "./convert/unpack.ts";
import { fetchBytes, parseStoreUrl, storeArchive, type StoreSource } from "./download.ts";

export type Source =
  | StoreSource
  | { kind: "url"; url: string }
  | { kind: "file"; path: string }
  | { kind: "dir"; path: string };

const ID = /^[a-p]{32}$/;

/** Works out what a <source> argument names. A local path wins over everything but a URL. */
export async function parseSource(input: string): Promise<Source> {
  if (/^https?:\/\//i.test(input)) return parseUrl(new URL(input));
  const found = await stat(input).catch(() => undefined);
  if (found) return found.isDirectory() ? { kind: "dir", path: input } : { kind: "file", path: input };
  if (ID.test(input)) return { kind: "cws", id: input };
  if (/[/\\]/.test(input) || /\.(crx|xpi|zip)$/i.test(input)) throw new Error(`No such file or directory: ${input}`);
  if (/^[\w.@{}-]+$/.test(input)) return { kind: "amo", slug: input };
  throw new Error(`Not a store URL, extension ID, AMO slug, file or directory: ${input}`);
}

const parseUrl = (url: URL): Source => parseStoreUrl(url) ?? { kind: "url", url: url.href };

/** The archive's bytes, for every source but a directory. */
export async function readArchive(source: Exclude<Source, { kind: "dir" }>): Promise<Uint8Array> {
  if (source.kind === "url") return fetchBytes(source.url);
  if (source.kind === "file") return new Uint8Array(await readFile(source.path));
  return storeArchive(source);
}

/** The extension's files, and its store ID when the store has one Chrome would use for chrome.runtime.id. */
export async function readSource(source: Source): Promise<{ files: ExtensionFiles; extensionId?: string }> {
  if (source.kind === "dir") return { files: await readDirectory(source.path) };
  const files = unpack(await readArchive(source));
  return source.kind === "cws" || source.kind === "edge" ? { files, extensionId: source.id } : { files };
}

/** A short name for output files: the store ID or slug, or the file or URL's base name without its extension. */
export function sourceName(source: Source): string {
  switch (source.kind) {
    case "cws":
    case "edge":
      return source.id;
    case "amo":
      return source.slug;
    case "url":
      return basename(new URL(source.url).pathname).replace(/\.[^.]*$/, "") || "extension";
    case "file":
    case "dir":
      return basename(source.path).replace(/\.(crx|xpi|zip)$/i, "") || "extension";
  }
}

/** Reads an unpacked extension. Hidden files and folders (.git and the like) and symbolic links are skipped. */
async function readDirectory(root: string): Promise<ExtensionFiles> {
  const files: ExtensionFiles = new Map();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (path.split("/").some((part) => part.startsWith("."))) continue;
    files.set(path, new Uint8Array(await readFile(join(entry.parentPath, entry.name))));
  }
  if (!files.has("manifest.json")) throw new Error(`Not an extension: ${root} has no manifest.json`);
  return files;
}
