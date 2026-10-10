// GM value keys the runtime uses (spec §5.2–5.4). ns is the converted extension's namespace.
export function keys(ns: string) {
  return {
    tab: (id: number) => `x2u:${ns}:tab:${id}`,
    tabPrefix: `x2u:${ns}:tab:`,
    out: (id: number) => `x2u:${ns}:out:${id}`,
    roster: `x2u:${ns}:roster`,
    /** chrome.storage: one value per key. */
    storage: (area: string, key: string) => `x2u:${ns}:s:${area}:${key}`,
    storagePrefix: `x2u:${ns}:s:`,
    /** Rung when a storage key is created, so tabs watching storage.onChanged start listening to it. */
    storageDoorbell: `x2u:${ns}:storage-keys`,
  };
}
