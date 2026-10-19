// Refined GitHub marks the page as handled and adds its own repository navigation.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://github.com/refined-github/refined-github");
    await page.locator("html[refined-github]").first().waitFor({ state: "attached" });
    await page.locator("#rgh-extensible-nav-code").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
