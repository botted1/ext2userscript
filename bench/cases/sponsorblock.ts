// SponsorBlock loads the video's segments and adds its bar over the player's progress bar.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://www.youtube.com/watch?v=jNQXAC9IVRw");
    await page.locator("#previewbar").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
