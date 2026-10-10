// Reads manifest.json into one model for MV2 and MV3 (spec §3.2), with __MSG_x__ resolved against _locales.
// A manifest Chrome would refuse is a hard error naming the key (spec §9); anything else odd becomes a warning.
import type { Messages, RunAt, UrlFilter, World } from "../runtime/config.ts";
import { pickLocale } from "../runtime/i18n.ts";
import { matchPatternToRegExp } from "../runtime/match.ts";
import { decodeText } from "./files.ts";
import { joinPath } from "./paths.ts";
import type { ExtensionFiles } from "./unpack.ts";

export type ContentGroup = UrlFilter & { js: string[]; css: string[]; runAt: RunAt; allFrames: boolean; matchAboutBlank: boolean; world: World };

export type Background = { kind: "worker"; entry: string; module: boolean } | { kind: "scripts"; files: string[] } | { kind: "page"; html: string };

export type Model = {
  manifestVersion: 2 | 3;
  name: string;
  description: string;
  version: string;
  geckoId?: string;
  /** The manifest's public key (base64), from which Chrome derives the extension ID. */
  key?: string;
  /** Icon size → path. */
  icons: Record<string, string>;
  background?: Background;
  contentScripts: ContentGroup[];
  /** The page and the manifest key it came from: action, browser_action or page_action. */
  popup?: { key: string; page: string };
  /** The page and the manifest key it came from: options_ui or options_page. */
  options?: { key: string; page: string };
  /** Paths and globs, flattened from the MV2 and MV3 forms. */
  webAccessibleResources: string[];
  defaultLocale?: string;
  /** Every _locales/<locale>/messages.json, keyed by folder name. */
  locales: Record<string, Messages>;
  /** The locale the manifest's __MSG_x__ strings were resolved against. */
  locale?: string;
  /** manifest.json as parsed, for runtime.getManifest(). */
  raw: Record<string, unknown>;
};

const RUN_AT: readonly string[] = ["document_start", "document_end", "document_idle"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (detail: string) => new Error(`Invalid manifest.json: ${detail}`);

/** JSON with comments, which Chrome accepts in manifest.json and messages.json. A leading byte-order mark is ignored. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      out += " ";
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/^﻿/, ""));
}

export function readManifest(files: ExtensionFiles, options: { locale?: string } = {}): { model: Model; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = parseJsonc(decodeText(files.get("manifest.json") ?? new Uint8Array()));
  } catch (error) {
    throw invalid((error as Error).message);
  }
  if (!isObject(raw)) throw invalid("expected an object");
  const manifestVersion = raw.manifest_version;
  if (manifestVersion !== 2 && manifestVersion !== 3) throw invalid(`manifest_version must be 2 or 3 (got ${JSON.stringify(manifestVersion)})`);

  const locales = readLocales(files, warnings);
  const defaultLocale = typeof raw.default_locale === "string" ? raw.default_locale : undefined;
  if (Object.keys(locales).length > 0 && defaultLocale === undefined) throw invalid("_locales exists, so default_locale is required");
  if (options.locale && pickLocale(Object.keys(locales), [options.locale]) === undefined) {
    warnings.push(`--locale ${options.locale}: the extension has no such locale, so ${defaultLocale ?? "its default"} is used`);
  }
  const locale = pickLocale(Object.keys(locales), options.locale ? [options.locale] : [], defaultLocale);
  const lookup = (name: string) => {
    for (const table of [locale, defaultLocale]) {
      const entry = table === undefined ? undefined : locales[table]?.[name.toLowerCase()];
      if (entry) return entry.message;
    }
    warnings.push(`__MSG_${name}__ isn't in _locales, so it stays as written`);
    return undefined;
  };
  const text = (value: unknown) => (typeof value === "string" ? value.replace(/__MSG_([\w@]+)__/g, (whole, name: string) => lookup(name) ?? whole) : "");

  const name = text(raw.name);
  if (!name) throw invalid("name is required");
  if (typeof raw.version !== "string" || raw.version === "") throw invalid("version is required");
  const gecko = isObject(raw.browser_specific_settings) ? raw.browser_specific_settings.gecko : isObject(raw.applications) ? raw.applications.gecko : undefined;

  return {
    model: {
      manifestVersion,
      name,
      description: text(raw.description),
      version: raw.version,
      geckoId: isObject(gecko) && typeof gecko.id === "string" ? gecko.id : undefined,
      key: typeof raw.key === "string" ? raw.key : undefined,
      icons: icons(raw.icons),
      background: background(raw.background),
      contentScripts: contentScripts(raw.content_scripts),
      popup: page(raw, ["action", "browser_action", "page_action"], "default_popup"),
      options: page(raw, ["options_ui"], "page") ?? (typeof raw.options_page === "string" ? { key: "options_page", page: filePath(raw.options_page, "options_page") } : undefined),
      webAccessibleResources: webAccessibleResources(raw.web_accessible_resources),
      defaultLocale,
      locales,
      locale,
      raw,
    },
    warnings,
  };
}

function readLocales(files: ExtensionFiles, warnings: string[]): Record<string, Messages> {
  const locales: Record<string, Messages> = {};
  for (const [path, bytes] of files) {
    const folder = /^_locales\/([^/]+)\/messages\.json$/.exec(path)?.[1];
    if (folder === undefined) continue;
    try {
      locales[folder] = messages(parseJsonc(decodeText(bytes)));
    } catch (error) {
      warnings.push(`${path} isn't valid JSON (${(error as Error).message}), so it was skipped`);
    }
  }
  return locales;
}

/** A messages.json with lower-cased message and placeholder names, keeping only well-formed entries. */
function messages(value: unknown): Messages {
  const out: Messages = {};
  if (!isObject(value)) return out;
  for (const [name, entry] of Object.entries(value)) {
    if (!isObject(entry) || typeof entry.message !== "string") continue;
    const placeholders: Record<string, { content: string }> = {};
    if (isObject(entry.placeholders)) {
      for (const [placeholder, spec] of Object.entries(entry.placeholders)) {
        if (isObject(spec) && typeof spec.content === "string") placeholders[placeholder.toLowerCase()] = { content: spec.content };
      }
    }
    out[name.toLowerCase()] = Object.keys(placeholders).length > 0 ? { message: entry.message, placeholders } : { message: entry.message };
  }
  return out;
}

function strings(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw invalid(`${key} must be a list of strings`);
  return value;
}

/** A path inside the extension, without a leading slash or ./, as unpack() keys files. */
function filePath(path: string, key: string): string {
  try {
    return joinPath("", path);
  } catch {
    throw invalid(`${key}: ${path} points outside the extension`);
  }
}

function icons(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObject(value)) for (const [size, path] of Object.entries(value)) if (typeof path === "string") out[size] = filePath(path, `icons.${size}`);
  return out;
}

function background(value: unknown): Background | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.service_worker === "string") return { kind: "worker", entry: filePath(value.service_worker, "background.service_worker"), module: value.type === "module" };
  if (value.scripts !== undefined) return { kind: "scripts", files: strings(value.scripts, "background.scripts").map((path) => filePath(path, "background.scripts")) };
  if (typeof value.page === "string") return { kind: "page", html: filePath(value.page, "background.page") };
  return undefined;
}

function contentScripts(value: unknown): ContentGroup[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("content_scripts must be a list");
  return value.map((entry: unknown, i) => {
    const key = `content_scripts[${i}]`;
    if (!isObject(entry)) throw invalid(`${key} must be an object`);
    const matches = strings(entry.matches, `${key}.matches`);
    if (matches.length === 0) throw invalid(`${key}.matches is required`);
    const excludeMatches = strings(entry.exclude_matches, `${key}.exclude_matches`);
    for (const [list, name] of [[matches, "matches"], [excludeMatches, "exclude_matches"]] as const) {
      list.forEach((pattern, j) => {
        try {
          matchPatternToRegExp(pattern);
        } catch (error) {
          throw invalid(`${key}.${name}[${j}]: ${(error as Error).message}`);
        }
      });
    }
    const runAt = entry.run_at ?? "document_idle";
    if (typeof runAt !== "string" || !RUN_AT.includes(runAt)) throw invalid(`${key}.run_at: unknown value ${JSON.stringify(entry.run_at)}`);
    const world = entry.world ?? "ISOLATED";
    if (world !== "ISOLATED" && world !== "MAIN") throw invalid(`${key}.world: unknown value ${JSON.stringify(entry.world)}`);
    return {
      matches,
      excludeMatches,
      includeGlobs: strings(entry.include_globs, `${key}.include_globs`),
      excludeGlobs: strings(entry.exclude_globs, `${key}.exclude_globs`),
      js: strings(entry.js, `${key}.js`).map((path) => filePath(path, `${key}.js`)),
      css: strings(entry.css, `${key}.css`).map((path) => filePath(path, `${key}.css`)),
      runAt: runAt as RunAt,
      allFrames: entry.all_frames === true,
      matchAboutBlank: entry.match_about_blank === true || entry.match_origin_as_fallback === true,
      world,
    };
  });
}

function page(raw: Record<string, unknown>, keys: readonly string[], field: string): { key: string; page: string } | undefined {
  for (const key of keys) {
    const section = raw[key];
    if (isObject(section) && typeof section[field] === "string") return { key, page: filePath(section[field], `${key}.${field}`) };
  }
  return undefined;
}

function webAccessibleResources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const resources = value.flatMap((entry: unknown) => (typeof entry === "string" ? [entry] : isObject(entry) ? strings(entry.resources, "web_accessible_resources[].resources") : []));
  return resources.map((resource) => resource.replace(/^\/+/, ""));
}
