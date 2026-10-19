// What a corpus case's script (bench/cases/<id>.ts) is (spec §10.4): a browser case checks one or two effects the
// extension has on a page; a negative case checks what the report says. Also what a run of one gives.
import type { Page } from "playwright";
import type { CorpusEntry } from "./corpus.ts";

/** The two converters the benchmark compares (spec §10.5). */
export const TOOLS = ["ext2userscript", "baseline"] as const;
export type Tool = (typeof TOOLS)[number];

export type Outcome = { result: "pass" | "fail" | "n/a"; detail?: string };
/** One case on one backend: the original extension's outcome (the reference) and each tool's. */
export type CaseResult = { entry: CorpusEntry; version: string; drifted: boolean; reference: Outcome; outcomes: Record<Tool, Outcome> };

/** A page a case serves instead of the real site: a body with its type. */
export type RouteAnswer = { body: string; type: string };

export type CaseContext = {
  /** A new tab on url, where the case's routes answer for the real site. */
  open(url: string): Promise<Page>;
};

export type BrowserCase = {
  /** Requests the case answers itself, by URL glob (Playwright's route syntax), for sites that stop automated browsers. */
  routes?: Record<string, RouteAnswer>;
  /** Throws if the extension's effect isn't there. */
  run(context: CaseContext): Promise<void>;
};

/** A negative case passes when the report's verdict is unlikely and it names each of these subjects as unsupported. */
export type NegativeCase = { report: { verdict: "unlikely"; subjects: string[] } };

export type BenchCase = BrowserCase | NegativeCase;
