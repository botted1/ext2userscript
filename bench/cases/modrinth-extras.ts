// Modrinth Extras adds its sidebars to a project page, among them the project's dependencies.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://modrinth.com/mod/sodium");
    await page.locator("#modrinth-extras-tools-sidebar").first().waitFor({ state: "attached" });
    await page.locator("#modrinth-extras-dependency-sidebar").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
