// Material Icons for GitHub swaps the file list's icons for its own, which it marks with the icon's name.
import type { BrowserCase } from "../case.ts";

export default {
  async run({ open }) {
    const page = await open("https://github.com/microsoft/vscode");
    await page.locator("[data-material-icons-extension-iconname='folder-github.svg']").first().waitFor({ state: "attached" });
  },
} satisfies BrowserCase;
