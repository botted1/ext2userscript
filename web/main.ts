// The web app's page (spec §8): takes an extension's archive (dropped, chosen, or from its store page through the
// download proxy), has the worker convert it, and shows the report with the userscript to download or copy. Text from
// the extension (its name, the report) goes in through textContent only, never as HTML.
import { slugify } from "../src/convert/metadata.ts";
import type { Report, Status, Verdict } from "../src/convert/report.ts";
import type { Job, JobRequest, WorkerMessage } from "./protocol.ts";

/** The download proxy's URL, put in by web/build.ts; empty when the site has none. */
declare const __X2U_PROXY__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drop = $<HTMLLabelElement>("drop");
const fileInput = $<HTMLInputElement>("file");
const store = $<HTMLFormElement>("store");
const link = $<HTMLInputElement>("link");
const status = $<HTMLParagraphElement>("status");
const error = $<HTMLParagraphElement>("error");
const result = $<HTMLElement>("result");

const ARCHIVE = /\.(crx|zip|xpi)$/i;
const VERDICTS: Record<Verdict, string> = { "likely-works": "Likely works", partial: "Partly works", unlikely: "Unlikely to work" };
const GROUPS: Array<[Status, string]> = [["unsupported", "Not supported"], ["partial", "Partly supported"], ["supported", "Supported"]];

let worker: Worker | undefined;
/** The latest job: answers for any earlier one are ignored. */
let latest = 0;
let converted: { userscript: string; fileName: string } | undefined;

function start(job: JobRequest, transfer: Transferable[] = []) {
  const id = ++latest;
  error.hidden = true;
  result.hidden = true;
  status.textContent = "Starting…";
  // The worker, and with it the converter, loads on the first conversion, not with the page.
  if (!worker) {
    worker = new Worker("worker.js");
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => answer(event.data);
    worker.onerror = (event) => fail(latest, `The converter couldn't start: ${event.message || "it failed to load"}`);
  }
  worker.postMessage({ ...job, id } as Job, transfer);
}

function fail(id: number, message: string) {
  if (id !== latest) return;
  status.textContent = "";
  error.textContent = message;
  error.hidden = false;
}

function answer(message: WorkerMessage) {
  if (message.id !== latest) return;
  if (message.type === "progress") status.textContent = message.text;
  else if (message.type === "error") fail(message.id, `Couldn't convert it: ${message.message}`);
  else show(message.report, message.userscript);
}

async function convertFile(file: File) {
  if (!ARCHIVE.test(file.name)) return fail(++latest, `${file.name} isn't an extension archive: choose a .crx, .zip or .xpi file (zip a folder first).`);
  const bytes = await file.arrayBuffer();
  start({ kind: "file", bytes }, [bytes]);
}

function show(report: Report, userscript: string) {
  const { name, version } = report.extension;
  converted = { userscript, fileName: `${slugify(name) || "extension"}.user.js` };
  // The result says it's done.
  status.textContent = "";
  $("result-title").textContent = `${name} ${version}`;
  const verdict = $("verdict");
  verdict.textContent = VERDICTS[report.verdict];
  verdict.className = `verdict ${report.verdict}`;
  $("warnings").replaceChildren(...report.warnings.map((warning) => element("li", warning)));
  const groups = GROUPS.flatMap(([kind, title]) => {
    const entries = report.entries.filter((entry) => entry.status === kind);
    if (entries.length === 0) return [];
    const details = document.createElement("details");
    details.className = kind;
    // What needs attention is open; the long list of what works isn't.
    details.open = kind !== "supported";
    const rows = entries.map((entry) => element("tr", "", apiName(entry.subject), element("td", entry.contexts.join(", ")), element("td", entry.reason ?? "")));
    const table = element("table", "", element("tr", "", ...["API or feature", "Where", "Why"].map((text) => element("th", text))), ...rows);
    details.append(element("summary", `${title} (${entries.length})`), element("div", "", table));
    (details.lastElementChild as HTMLElement).className = "table";
    return [details];
  });
  $("groups").replaceChildren(...groups);
  result.hidden = false;
}

function element(tag: string, text: string, ...children: Node[]) {
  const node = document.createElement(tag);
  node.textContent = text;
  node.append(...children);
  return node;
}

/** An API's name, which breaks only after a dot (manifest.content_scripts.run_at), never mid-word. */
function apiName(text: string) {
  const cell = document.createElement("td");
  for (const part of text.split(/(?<=\.)/)) cell.append(part, document.createElement("wbr"));
  return cell;
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) void convertFile(file);
});

// The whole page takes a drop, not just the drop zone.
addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.classList.add("over");
});
addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) drop.classList.remove("over");
});
addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("over");
  const file = event.dataTransfer?.files[0];
  if (file) void convertFile(file);
});

if (__X2U_PROXY__) {
  store.addEventListener("submit", (event) => {
    event.preventDefault();
    if (link.value.trim()) start({ kind: "store", link: link.value.trim() });
  });
} else {
  // Without a download proxy the field stays, disabled, saying why (spec §8).
  for (const control of store.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) control.disabled = true;
  $("store-hint").hidden = false;
}

$("download").addEventListener("click", () => {
  if (!converted) return;
  const url = URL.createObjectURL(new Blob([converted.userscript], { type: "text/javascript" }));
  const anchor = Object.assign(document.createElement("a"), { href: url, download: converted.fileName });
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url));
});

$("copy").addEventListener("click", async () => {
  if (!converted) return;
  try {
    await navigator.clipboard.writeText(converted.userscript);
    status.textContent = "Copied.";
  } catch {
    status.textContent = "The browser didn't allow copying. Use Download .user.js instead.";
  }
});
