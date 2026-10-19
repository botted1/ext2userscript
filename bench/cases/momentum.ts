// Momentum replaces the new tab page, which a userscript can't do.
import type { NegativeCase } from "../case.ts";

export default { report: { verdict: "unlikely", subjects: ["manifest.chrome_url_overrides"] } } satisfies NegativeCase;
