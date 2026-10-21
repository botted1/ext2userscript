// The benchmark's scorecard (spec §10.5) and v1's ship criteria (spec §1), from the corpus run's results.
import type { CaseResult, Outcome } from "./case.ts";

export type Criteria = {
  /** Cases the baseline passes that ext2userscript passes too, of all it passes (at least one, or it didn't run). */
  matched: [number, number];
  /** Modern cases the baseline fails that ext2userscript passes, of all it fails. */
  modern: [number, number];
  /** Negative cases whose report is accurate, of all of them. */
  negatives: [number, number];
  /** Cases the original extension failed: they can't judge a conversion, so they count for nothing. */
  inconclusive: string[];
  met: boolean;
};

const passes = (outcome: Outcome) => outcome.result === "pass";
/** Every case the baseline passes, ext2userscript passes too. A run where it passed none (it didn't run) can't say. */
const matchedAll = ([n, of]: [number, number]) => of > 0 && n === of;

export function criteria(results: readonly CaseResult[]): Criteria {
  const inconclusive = results.filter((result) => result.reference.result === "fail").map((result) => result.entry.id);
  const counted = results.filter((result) => result.reference.result !== "fail");
  const positive = counted.filter((result) => result.entry.kind !== "negative");
  const theirs = positive.filter((result) => passes(result.outcomes.baseline));
  const matched: [number, number] = [theirs.filter((result) => passes(result.outcomes.ext2userscript)).length, theirs.length];
  const failed = positive.filter((result) => result.entry.kind === "modern" && !passes(result.outcomes.baseline));
  const modern: [number, number] = [failed.filter((result) => passes(result.outcomes.ext2userscript)).length, failed.length];
  const negative = counted.filter((result) => result.entry.kind === "negative");
  const negatives: [number, number] = [negative.filter((result) => passes(result.outcomes.ext2userscript)).length, negative.length];
  const met = matchedAll(matched) && modern[0] >= 0.75 * modern[1] && negatives[0] === negatives[1] && inconclusive.length === 0;
  return { matched, modern, negatives, inconclusive, met };
}

const cell = (outcome: Outcome) => {
  const detail = (outcome.detail ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 200);
  return outcome.result === "fail" ? `fail: ${detail}` : detail ? `${outcome.result} (${detail})` : outcome.result;
};
const percent = ([n, of]: [number, number]) => (of === 0 ? "none to count" : `${n} of ${of}, ${Math.round((100 * n) / of)}%`);
const box = (ok: boolean) => (ok ? "[x]" : "[ ]");

export function scorecard(results: readonly CaseResult[], meta: { backend: string; baseline: string; commit: string; date: string }): string {
  const c = criteria(results);
  return [
    "# Benchmark scorecard",
    "",
    `${meta.date}, backend ${meta.backend}, ext2userscript ${meta.commit}, baseline ${meta.baseline}`,
    "",
    "| Case | Kind | Version | Original | ext2userscript | Baseline |",
    "|---|---|---|---|---|---|",
    ...results.map((result) => {
      const version = result.drifted ? `${result.version} (pinned ${result.entry.version})` : result.version;
      return `| ${result.entry.name} | ${result.entry.kind} | ${version} | ${cell(result.reference)} | ${cell(result.outcomes.ext2userscript)} | ${cell(result.outcomes.baseline)} |`;
    }),
    "",
    "## Ship criteria (spec §1)",
    "",
    `- ${box(matchedAll(c.matched))} Passes every case the baseline passes: ${percent(c.matched)}`,
    `- ${box(c.modern[0] >= 0.75 * c.modern[1])} Passes at least 75% of the modern cases the baseline fails: ${percent(c.modern)}`,
    `- ${box(c.negatives[0] === c.negatives[1])} An accurate report for every negative case: ${percent(c.negatives)}`,
    `- ${box(c.inconclusive.length === 0)} Every case conclusive (the original extension passes it): ${c.inconclusive.length === 0 ? "all" : `not ${c.inconclusive.join(", ")}`}`,
    "",
    c.met ? "**All met.**" : "**Not met yet.**",
    "",
  ].join("\n");
}
