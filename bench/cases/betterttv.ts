// BetterTTV adds its settings button to Twitch's top navigation.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://www.twitch.tv/directory");
    await page.locator("#bttv-top-nav-settings-button-container").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
