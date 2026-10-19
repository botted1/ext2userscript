// React Developer Tools adds a developer tools panel, which a userscript can't do.
import type { NegativeCase } from "../case.ts";

export default { report: { verdict: "unlikely", subjects: ["manifest.devtools_page"] } } satisfies NegativeCase;
