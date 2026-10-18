// Messages between the web app's page (main.ts) and its conversion worker (worker.ts). Each job has an id, and the page
// ignores answers for any job but its latest.
import type { Report } from "../src/convert/report.ts";

/** What to convert: an archive's bytes. */
export type JobRequest = { kind: "file"; bytes: ArrayBuffer };
export type Job = { id: number } & JobRequest;

export type WorkerMessage =
  | { id: number; type: "progress"; text: string }
  | { id: number; type: "done"; userscript: string; report: Report }
  | { id: number; type: "error"; message: string };
