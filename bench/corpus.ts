// The benchmark corpus (spec §10.4): bench/corpus.json pins each case's extension (store, ID, version, SHA-256), and
// the archives are downloaded once into bench/.cache/archives. Third-party archives are never committed.
// The stores serve only an extension's latest version, so a pinned version can't be fetched again once it moves on: a
// case then runs on the store's current archive, which both tools convert alike, and the scorecard says so.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unpack } from "../src/convert/unpack.ts";
import { storeArchive, type StoreSource } from "../src/download.ts";

export type CaseKind = "legacy" | "modern" | "negative";

export type CorpusEntry = {
  id: string;
  name: string;
  store: "cws" | "edge" | "amo";
  /** The store's ID, or the AMO slug. */
  extensionId: string;
  version: string;
  sha256: string;
  kind: CaseKind;
  /** A case that stands in for one the spec lists, and why. */
  swap?: { replaces: string; reason: string };
};

export type Archive = { path: string; bytes: Uint8Array; version: string; sha256: string; drifted: boolean };

export const CACHE = join(import.meta.dirname, ".cache");

export async function loadCorpus(path = join(import.meta.dirname, "corpus.json")): Promise<CorpusEntry[]> {
  return (JSON.parse(await readFile(path, "utf8")) as { cases: CorpusEntry[] }).cases;
}

/**
 * The cases a command runs: all of them, or those `--case id[,id…]` names. An id the corpus doesn't have is an error,
 * as is `--gate` on part of the corpus, so a typo can't pass the gate on no cases.
 */
export function selectCases(corpus: readonly CorpusEntry[], args: readonly string[]): CorpusEntry[] {
  if (!args.includes("--case")) return [...corpus];
  const ids = (args[args.indexOf("--case") + 1] ?? "").split(",").filter(Boolean);
  if (ids.length === 0) throw new Error("--case needs case ids, like --case json-formatter,dark-reader");
  const unknown = ids.filter((id) => !corpus.some((entry) => entry.id === id));
  if (unknown.length > 0) throw new Error(`No case ${unknown.join(", ")} in bench/corpus.json`);
  if (args.includes("--gate")) throw new Error("--gate judges the whole corpus: leave out --case");
  return corpus.filter((entry) => ids.includes(entry.id));
}

export const storeOf =(entry: CorpusEntry): StoreSource =>
  entry.store === "amo" ? { kind: "amo", slug: entry.extensionId } : { kind: entry.store, id: entry.extensionId };

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The manifest's version, as the archive says it. */
export function versionOf(bytes: Uint8Array): string {
  const manifest = JSON.parse(new TextDecoder().decode(unpack(bytes).get("manifest.json")).replace(/^﻿/, "")) as { version?: unknown };
  return String(manifest.version ?? "");
}

/** The case's archive: the pinned one from the cache, or the store's current one, downloaded and cached by its hash. */
export async function archiveOf(
  entry: CorpusEntry,
  options: { dir?: string; download?: (store: StoreSource) => Promise<Uint8Array> } = {},
): Promise<Archive> {
  const dir = options.dir ?? join(CACHE, "archives");
  const file = (hash: string) => join(dir, `${entry.id}-${hash.slice(0, 12)}.${entry.store === "amo" ? "xpi" : "crx"}`);
  const pinned = await readFile(file(entry.sha256)).catch(() => undefined);
  if (pinned && sha256(pinned) === entry.sha256) return { path: file(entry.sha256), bytes: new Uint8Array(pinned), version: entry.version, sha256: entry.sha256, drifted: false };
  const bytes = await (options.download ?? storeArchive)(storeOf(entry));
  const hash = sha256(bytes);
  await mkdir(dir, { recursive: true });
  await writeFile(file(hash), bytes);
  return { path: file(hash), bytes, version: versionOf(bytes), sha256: hash, drifted: hash !== entry.sha256 };
}
