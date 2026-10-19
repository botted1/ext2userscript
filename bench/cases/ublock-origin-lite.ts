// uBlock Origin Lite blocks requests with declarativeNetRequest, which a userscript can't do.
import type { NegativeCase } from "../case.ts";

export default { report: { verdict: "unlikely", subjects: ["manifest.declarative_net_request"] } } satisfies NegativeCase;
