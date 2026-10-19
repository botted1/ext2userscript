// Return YouTube Dislike fetches the video's dislikes and draws the like/dislike ratio bar.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://www.youtube.com/watch?v=jNQXAC9IVRw");
    await page.locator("#ryd-bar-container").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
