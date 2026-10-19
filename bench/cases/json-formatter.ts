// JSON Formatter turns a JSON response into a collapsible tree, and sets window.json in the page.
import type { BrowserCase } from "../case.ts";

const DATA = { name: "x2u", list: [1, 2, 3], nested: { ok: true } };

export default {
  routes: { "https://json.x2u.test/**": { body: JSON.stringify(DATA), type: "application/json" } },
  async run({ open }) {
    const page = await open("https://json.x2u.test/data.json");
    await page.locator("#jsonFormatterParsed").waitFor();
    await page.waitForFunction(() => (window as { json?: { name?: string } }).json?.name === "x2u");
  },
} satisfies BrowserCase;
