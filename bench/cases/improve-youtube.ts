// Improve YouTube! tags the page with its path and adds its buttons below the player.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://www.youtube.com/watch?v=jNQXAC9IVRw");
    await page.locator("html[it-pathname='/watch']").first().waitFor({ state: "attached" });
    await page.locator("#it-below-player-loop").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
