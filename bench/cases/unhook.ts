// Unhook hides YouTube's recommendations, as its default settings say.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://www.youtube.com/watch?v=jNQXAC9IVRw");
    await page.locator("html[hide_feed='true']").first().waitFor({ state: "attached" });
    await page.locator("html[hide_recommended='true']").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
