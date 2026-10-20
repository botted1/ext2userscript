// The compatibility report (spec §3.5): what the conversion supports, partly supports or can't, per context, and an
// overall verdict. The CLI prints it with formatReport and can write it as JSON.

export type Status = "supported" | "partial" | "unsupported";
export type Context = "background" | "content" | "popup" | "options" | "page";
export type Verdict = "likely-works" | "partial" | "unlikely";

export type ReportEntry = { subject: string; status: Status; reason?: string; contexts: Context[] };

export type Report = {
  extension: { name: string; version: string; manifestVersion: 2 | 3; id?: string };
  verdict: Verdict;
  entries: ReportEntry[];
  warnings: string[];
};

const STATUS_ORDER: readonly Status[] = ["unsupported", "partial", "supported"];

/**
 * Unlikely when the extension's core can't work: a manifest feature a userscript can't provide, or something unsupported
 * where the extension does its work, core (its content scripts or, without them, its background). Unsupported calls
 * elsewhere are usually side features (an update check, a welcome page, a sign-in), so they make it partial.
 */
export function verdictOf(entries: readonly ReportEntry[], core: Context): Verdict {
  if (entries.some((entry) => entry.status === "unsupported" && (entry.subject.startsWith("manifest.") || entry.contexts.includes(core)))) return "unlikely";
  return entries.some((entry) => entry.status !== "supported") ? "partial" : "likely-works";
}

/** Unsupported first, then partial, then supported; by subject within each. */
export function sortEntries(entries: readonly ReportEntry[]): ReportEntry[] {
  return [...entries].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.subject.localeCompare(b.subject));
}

/** Text from an extension, safe to print: control characters (escape sequences, carriage returns, line breaks) are dropped. */
export const printable = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

export function formatReport(report: Report): string {
  const { name, version, manifestVersion } = report.extension;
  const rows = report.entries.map((entry) => [entry.status, entry.subject, entry.contexts.join(", "), entry.reason ?? ""].map(printable));
  const widths = [0, 1, 2].map((column) => Math.max(0, ...rows.map((row) => row[column].length)));
  const lines = [`${printable(name)} ${printable(version)} (manifest v${manifestVersion}): ${report.verdict}`];
  for (const row of rows) lines.push(`  ${row.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell)).join("  ")}`.trimEnd());
  if (report.warnings.length > 0) lines.push("Warnings:", ...report.warnings.map((warning) => `  - ${printable(warning)}`));
  return lines.join("\n");
}
