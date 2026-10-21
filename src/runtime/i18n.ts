// chrome.i18n (spec §5.2): messages from the extension's _locales, in the locale chosen from the browser's languages
// (or forced with --locale), falling back to default_locale. pickLocale is shared with manifest.ts.
import { method, type Logger } from "./chrome.ts";
import type { RuntimeConfig } from "./config.ts";

const normalize = (locale: string) => locale.replace(/-/g, "_").toLowerCase();

/** The first wanted locale the extension has, trying each one's base language (en_GB → en) too; otherwise the fallback. */
export function pickLocale(available: readonly string[], wanted: readonly string[], fallback?: string): string | undefined {
  const byName = new Map(available.map((locale) => [normalize(locale), locale]));
  for (const locale of wanted) {
    const found = byName.get(normalize(locale)) ?? byName.get(normalize(locale).split("_")[0]);
    if (found) return found;
  }
  return fallback === undefined ? undefined : (byName.get(normalize(fallback)) ?? fallback);
}

const RTL = /^(ar|dv|fa|he|ku|ps|sd|ug|ur|yi)(_|$)/i;

export function createI18n(
  config: Pick<RuntimeConfig, "id" | "locales" | "defaultLocale" | "locale">,
  log: Logger,
  languages: readonly string[] = navigator.languages,
) {
  const chosen = config.locale ?? pickLocale(Object.keys(config.locales), languages, config.defaultLocale);
  const tables = [...new Set([chosen, config.defaultLocale])].flatMap((locale) => (locale && config.locales[locale] ? [config.locales[locale]] : []));
  const rtl = RTL.test(chosen ?? "");
  const predefined: Record<string, string> = {
    "@@extension_id": config.id,
    "@@ui_locale": chosen ?? "en",
    "@@bidi_dir": rtl ? "rtl" : "ltr",
    "@@bidi_reversed_dir": rtl ? "ltr" : "rtl",
    "@@bidi_start_edge": rtl ? "right" : "left",
    "@@bidi_end_edge": rtl ? "left" : "right",
  };

  /** Chrome's getMessage: "" for an unknown name; $placeholder$ first, then $1–$9 and $$. */
  const getMessage = (name: string, substitutions?: unknown): string => {
    const key = String(name).toLowerCase();
    // Object.hasOwn: a message named like a prototype member ("constructor") isn't one.
    if (Object.hasOwn(predefined, key)) return predefined[key];
    const entry = tables.map((table) => (Object.hasOwn(table, key) ? table[key] : undefined)).find((found) => found !== undefined);
    if (!entry) return "";
    const values = (Array.isArray(substitutions) ? substitutions : substitutions === undefined ? [] : [substitutions]).map(String);
    const text = entry.message.replace(/\$([\w@]+)\$/g, (whole, placeholder: string) => entry.placeholders?.[placeholder.toLowerCase()]?.content ?? whole);
    return text.replace(/\$\$|\$([1-9])/g, (_whole, index?: string) => (index === undefined ? "$" : (values[Number(index) - 1] ?? "")));
  };

  return {
    getMessage,
    getUILanguage: () => languages[0] ?? "en",
    getAcceptLanguages: method(log, async () => [...languages]),
  };
}
