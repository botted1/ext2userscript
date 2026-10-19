// LeetCode Enhancer (WXT) turns on autocomplete in the problem's code editor: its content
// script injects patchMonaco.js into the page, which sets the options on every Monaco editor. leetcode.com stops
// automated browsers with a challenge, so the case serves a problem page with a stand-in editor.
import type { BrowserCase } from "../case.ts";

const PAGE = `<!doctype html><title>Two Sum - LeetCode</title>
<div class="monaco-editor"></div>
<script>
  window.monaco = { editor: { getEditors: () => [{ updateOptions(options) { window.editorOptions = options }, onDidChangeConfiguration() {} }] } };
</script>`;

export default {
  routes: { "https://leetcode.com/**": { body: PAGE, type: "text/html" } },
  async run({ open }) {
    const page = await open("https://leetcode.com/problems/two-sum/");
    await page.waitForFunction(() => (window as { editorOptions?: { wordBasedSuggestions?: string } }).editorOptions?.wordBasedSuggestions === "allDocuments");
  },
} satisfies BrowserCase;
