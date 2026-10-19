// Reddit Enhancement Suite tags the page with the subreddit it read from it and adds its account switcher to the header.
// Reddit stops automated browsers, so the case serves its own old Reddit listing.
import type { BrowserCase } from "../case.ts";
import { OLD_REDDIT } from "../fixtures.ts";

export default {
  routes: { "https://old.reddit.com/**": { body: OLD_REDDIT, type: "text/html" } },
  async run({ open }) {
    const page = await open("https://old.reddit.com/r/userscripts/");
    await page.locator("html.res-r-userscripts").first().waitFor({ state: "attached" });
    await page.locator("#RESAccountSwitcherIcon").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
