// Modern for Hacker News replaces the site's header with its own.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://news.ycombinator.com/");
    await page.locator("#hn_header").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
