// chrome.permissions (spec §5.2): answers come from the manifest. A userscript can't ask the user, so request grants
// any permission the manifest lists as optional; grants and removals of optional permissions persist in a GM value.
// Ceiling: the network shim reaches optional hosts whether or not they were granted.
import { createEvent, method, type Logger } from "./chrome.ts";
import type { RuntimeConfig } from "./config.ts";
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";
import { urlMatches } from "./match.ts";

type Set_ = { permissions?: string[]; origins?: string[] };
type Granted = { permissions: string[]; origins: string[] };

/** A URL a match pattern matches, to test whether other patterns cover it. */
const sample = (pattern: string) =>
  pattern === "<all_urls>" ? "https://a.example/" : pattern.replace(/^\*:/, "https:").replace(/:\/\/\*\./, "://").replace(/:\/\/\*(?=[/:])/, "://a.example").replace(/\*/g, "");

/** Whether the patterns cover a pattern: the same one, or one that matches it. */
function covers(patterns: readonly string[], pattern: string): boolean {
  if (patterns.includes(pattern) || patterns.includes("<all_urls>")) return true;
  try {
    return urlMatches(sample(pattern), patterns);
  } catch {
    return false;
  }
}

export async function createPermissions(gm: Gm, ns: string, log: Logger, config: RuntimeConfig) {
  const key = keys(ns).permissions;
  const declared = config.permissions ?? { api: [], optionalApi: [], origins: [], optionalOrigins: [] };
  const onAdded = createEvent<(permissions: Set_) => void>(log);
  const onRemoved = createEvent<(permissions: Set_) => void>(log);
  const stored = await gm.getValue<Granted>(key);
  const granted: Granted = { permissions: stored?.permissions ?? [], origins: stored?.origins ?? [] };
  const effective = () => ({ permissions: [...new Set([...declared.api, ...granted.permissions])], origins: [...new Set([...declared.origins, ...granted.origins])] });
  const save = () => gm.setValue(key, granted);

  const contains = async ({ permissions = [], origins = [] }: Set_ = {}) => {
    const now = effective();
    return permissions.every((name) => now.permissions.includes(name)) && origins.every((origin) => covers(now.origins, origin));
  };

  return {
    contains: method(log, contains),
    getAll: method(log, async () => effective()),
    request: method(log, async ({ permissions = [], origins = [] }: Set_ = {}) => {
      const allowed = permissions.every((name) => declared.api.includes(name) || declared.optionalApi.includes(name)) && origins.every((origin) => covers([...declared.origins, ...declared.optionalOrigins], origin));
      if (!allowed) throw new Error("Only permissions specified in the manifest may be requested.");
      const now = effective();
      const added = { permissions: permissions.filter((name) => !now.permissions.includes(name)), origins: origins.filter((origin) => !covers(now.origins, origin)) };
      if (added.permissions.length + added.origins.length > 0) {
        granted.permissions.push(...added.permissions);
        granted.origins.push(...added.origins);
        await save();
        onAdded.dispatch(added);
      }
      return true;
    }),
    remove: method(log, async ({ permissions = [], origins = [] }: Set_ = {}) => {
      if (permissions.some((name) => declared.api.includes(name)) || origins.some((origin) => declared.origins.includes(origin))) throw new Error("You cannot remove required permissions.");
      const removed = { permissions: permissions.filter((name) => granted.permissions.includes(name)), origins: origins.filter((origin) => granted.origins.includes(origin)) };
      if (removed.permissions.length + removed.origins.length === 0) return false;
      granted.permissions = granted.permissions.filter((name) => !removed.permissions.includes(name));
      granted.origins = granted.origins.filter((origin) => !removed.origins.includes(origin));
      await save();
      onRemoved.dispatch(removed);
      return true;
    }),
    onAdded: onAdded.event,
    onRemoved: onRemoved.event,
  };
}
