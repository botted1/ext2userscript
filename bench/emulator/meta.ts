// Reads the userscript header keys the emulator acts on (spec §10.2).

export type Meta = {
  name: string;
  match: string[];
  excludeMatch: string[];
  grant: string[];
  connect: string[];
  runAt: "document-start" | "document-end" | "document-idle";
};

export function parseMeta(userscript: string): Meta {
  const block = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(userscript);
  if (!block) throw new Error("Userscript has no ==UserScript== block");
  const meta: Meta = { name: "", match: [], excludeMatch: [], grant: [], connect: [], runAt: "document-end" };
  for (const line of block[1].split("\n")) {
    const parts = /^\s*\/\/\s*@([\w-]+)(?:\s+(.*?))?\s*$/.exec(line);
    if (!parts) continue;
    const [, key, value = ""] = parts;
    if (key === "name") meta.name = value;
    else if (key === "match") meta.match.push(value);
    else if (key === "exclude-match") meta.excludeMatch.push(value);
    else if (key === "grant" && value !== "none") meta.grant.push(value);
    else if (key === "connect") meta.connect.push(value);
    else if (key === "run-at") {
      if (value !== "document-start" && value !== "document-end" && value !== "document-idle") throw new Error(`Unsupported @run-at ${value}`);
      meta.runAt = value;
    }
  }
  return meta;
}
