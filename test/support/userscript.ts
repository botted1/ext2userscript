// Builds userscripts for tests: a metadata block plus a probe bundled with esbuild.
import { build } from "esbuild";

export type RunAt = "document-start" | "document-end" | "document-idle";

export type MetaInput = {
  name: string;
  match: string[];
  excludeMatch?: string[];
  grant: string[];
  connect?: string[];
  runAt?: RunAt;
  /** Ask both managers for the isolated world (spec §4): @sandbox DOM (TM), @inject-into content (VM). */
  isolated?: boolean;
};

export function renderMeta(meta: MetaInput): string {
  const lines = ["// ==UserScript==", `// @name         ${meta.name}`, "// @namespace    x2u-tests", "// @version      1.0.0"];
  for (const pattern of meta.match) lines.push(`// @match        ${pattern}`);
  for (const pattern of meta.excludeMatch ?? []) lines.push(`// @exclude-match ${pattern}`);
  for (const grant of meta.grant.length > 0 ? meta.grant : ["none"]) lines.push(`// @grant        ${grant}`);
  for (const host of meta.connect ?? []) lines.push(`// @connect      ${host}`);
  if (meta.isolated) lines.push("// @sandbox      DOM", "// @inject-into  content");
  lines.push(`// @run-at       ${meta.runAt ?? "document-end"}`, "// ==/UserScript==");
  return lines.join("\n");
}

export async function buildUserscript(entry: string, meta: MetaInput, define: Record<string, string> = {}): Promise<string> {
  const result = await build({ entryPoints: [entry], bundle: true, format: "iife", platform: "browser", target: "es2020", write: false, define });
  return `${renderMeta(meta)}\n${result.outputFiles[0].text}`;
}
