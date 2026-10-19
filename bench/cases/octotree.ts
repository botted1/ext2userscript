// Octotree adds its file tree sidebar to the repository page.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://github.com/refined-github/refined-github");
    await page.locator(".octotree-sidebar").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
