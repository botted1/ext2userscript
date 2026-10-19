// Dark Reader themes any page dark: it adds its style elements and the html element gets data-darkreader-scheme.
import type { BrowserCase } from "../case.ts";

const PAGE = `<!doctype html><title>Light page</title><style>body { background: #fff; color: #000 }</style><h1>Light page</h1><p>Some text.</p>`;

export default {
  routes: { "https://light.x2u.test/**": { body: PAGE, type: "text/html" } },
  async run({ open }) {
    const page = await open("https://light.x2u.test/");
    await page.locator("html[data-darkreader-scheme='dark']").first().waitFor({ state: "attached" });
    await page.locator("style.darkreader").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
