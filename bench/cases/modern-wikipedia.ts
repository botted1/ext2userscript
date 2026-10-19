// Modern for Wikipedia replaces the article's header and adds a table of contents panel.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://en.wikipedia.org/wiki/Userscript");
    await page.locator("#wiki_header").first().waitFor({ state: "attached" });
    await page.locator("#wiki_contents").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
