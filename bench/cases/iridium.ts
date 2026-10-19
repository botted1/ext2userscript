// Iridium applies its default settings to YouTube, among them full video titles.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://www.youtube.com/watch?v=jNQXAC9IVRw");
    await page.locator("html.iridium-full-titles").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
