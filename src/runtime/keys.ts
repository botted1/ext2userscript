// GM value keys the runtime uses (spec §5.3–5.4). ns is the converted extension's namespace.
export function keys(ns: string) {
  return {
    tab: (id: number) => `x2u:${ns}:tab:${id}`,
    tabPrefix: `x2u:${ns}:tab:`,
    out: (id: number) => `x2u:${ns}:out:${id}`,
    roster: `x2u:${ns}:roster`,
  };
}
