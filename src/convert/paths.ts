// POSIX path helpers for extension files. They also run in the browser, where node:path isn't available.

export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Resolves rel against base inside the extension root. Query strings and fragments are dropped. */
export function joinPath(base: string, rel: string): string {
  const parts: string[] = [];
  for (const part of `${base}/${rel.replace(/[?#].*$/, "")}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error(`Path escapes the extension root: ${rel}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}
