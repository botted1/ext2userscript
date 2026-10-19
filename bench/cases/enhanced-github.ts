// Enhanced GitHub adds a download link with the size of each file in the repository's file list.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://github.com/refined-github/refined-github");
    await page.locator(".eg-download").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
