// GM value keys the runtime uses (spec §5.1–5.4). ns is the converted extension's namespace.
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
    /** The background's localStorage: one value per key. */
    localStorage: (key: string) => `x2u:${ns}:ls:${key}`,
    localStoragePrefix: `x2u:${ns}:ls:`,
    /** The extension version runtime.onInstalled last fired for. */
    installed: `x2u:${ns}:installed`,
    /** Written by the leader on every beat; missing or stale means the browser restarted (spec §5.4). */
    session: `x2u:${ns}:session`,
    /** The alarms' schedule (spec §5.2), which the leader's background keeps. */
    alarms: `x2u:${ns}:alarms`,
  };
}
