// A page's id in the registry (spec §5.3): a random 31-bit integer, kept in sessionStorage, so a tab keeps its id across
// same-origin navigations. A duplicated tab copies sessionStorage, so an id whose key another page is still beating
// with is given up for a new one.
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";
import { REGISTRY_TIMING } from "./registry.ts";

const randomId = (random: () => number) => 1 + Math.floor(random() * (2 ** 31 - 1));

export async function tabIdentity(
  gm: Gm,
  ns: string,
  frame: boolean,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.sessionStorage,
  random: () => number = Math.random,
): Promise<number> {
  // A frame shares its tab's sessionStorage only when same-origin, and isn't a tab anyway: it gets an id per page.
  if (frame || !storage) return randomId(random);
  const slot = `x2u:${ns}:tab-id`;
  try {
    const saved = Number(storage.getItem(slot));
    if (Number.isInteger(saved) && saved > 0) {
      const beat = (await gm.getValue(keys(ns).tab(saved))) as { ts?: number } | undefined;
      if (typeof beat?.ts !== "number" || Date.now() - beat.ts > REGISTRY_TIMING.staleMs) return saved;
    }
    const id = randomId(random);
    storage.setItem(slot, String(id));
    return id;
  } catch {
    return randomId(random); // sessionStorage can be blocked (sandboxed frames, storage settings)
  }
}
