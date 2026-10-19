// Augmented Steam adds its menu to the store's header.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://store.steampowered.com/app/620/Portal_2/");
    await page.locator("#as-menu").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
