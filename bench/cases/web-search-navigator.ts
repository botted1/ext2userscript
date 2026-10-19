// Web Search Navigator focuses the first search result, for keyboard navigation. Google answers automated browsers
// with a CAPTCHA, so the case serves its own results page.
import type { BrowserCase } from "../case.ts";
import { GOOGLE_RESULTS } from "../fixtures.ts";

export default {
  routes: { "https://www.google.com/search?**": { body: GOOGLE_RESULTS, type: "text/html" } },
  async run({ open }) {
    const page = await open("https://www.google.com/search?q=userscript");
    await page.locator("#search a.wsn-google-focused-link").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
