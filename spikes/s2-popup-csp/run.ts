// THROWAWAY spike S2 runner: installs the probe into each real manager and visits strict-CSP sites.
// Needs the release-tier profile (npm run bench:setup). Writes spikes/s2-popup-csp/results.json.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Response as PageResponse } from "playwright";
import { installUserscript } from "../../bench/real/install.ts";
import { launchReal } from "../../bench/real/launch.ts";
import type { ManagerName } from "../../bench/real/managers.ts";
import { GRANTS } from "../../src/runtime/gm.ts";
import { startServer } from "../../test/support/server.ts";
import { buildUserscript } from "../../test/support/userscript.ts";

const SITES = ["https://github.com/", "https://www.youtube.com/", "https://x.com/"];
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Geneva.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function readFont(): Promise<Uint8Array<ArrayBuffer>> {
  for (const path of FONT_CANDIDATES) {
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      // try the next one
    }
  }
  throw new Error(`No TrueType font found; add a path to FONT_CANDIDATES (tried ${FONT_CANDIDATES.join(", ")})`);
}

const font = await readFont();
const pixel = new Uint8Array(Buffer.from(PIXEL, "base64"));
const assets = await startServer({
  "/pixel.png": () => new Response(pixel, { headers: { "content-type": "image/png" } }),
  "/font.ttf": () => new Response(font, { headers: { "content-type": "font/ttf" } }),
});
const userscript = await buildUserscript(
  join(import.meta.dirname, "probe.ts"),
  {
    name: "ext2userscript S2 spike",
    match: SITES.map((site) => `${site}*`),
    grant: Object.values(GRANTS).flat(),
    connect: ["127.0.0.1"],
    runAt: "document-idle",
    isolated: true,
  },
  { __S2_ASSETS__: JSON.stringify(assets.origin) },
);

const results: Record<string, Record<string, unknown>> = {};
for (const manager of ["tm", "vm"] as ManagerName[]) {
  const { context, extensionId } = await launchReal(manager);
  try {
    await installUserscript(context, extensionId, userscript);
    for (const site of SITES) {
      const page = await context.newPage();
      // goto() throws on an error status (x.com answers headless Chromium that way), so take the main document's response from the event instead.
      let response: PageResponse | undefined;
      page.on("response", (r) => {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) response = r;
      });
      const gotoError = await page.goto(site, { waitUntil: "domcontentloaded" }).then(
        () => undefined,
        (error: unknown) => String(error).split("\n")[0],
      );
      const csp = response?.headers()["content-security-policy"] ?? "(none)";
      let probe: Record<string, unknown> = { error: gotoError ?? "timed out after 30s" };
      for (let i = 0; i < 60 && !gotoError; i++) {
        const raw = await page.locator("html").getAttribute("data-x2u-s2");
        if (raw) {
          probe = JSON.parse(raw) as Record<string, unknown>;
          if (probe.done || probe.error) break;
        }
        await page.waitForTimeout(500);
      }
      // What loaded, for the findings: status, title, and any CSP delivered by a <meta> tag instead of a header.
      const metaCsp = await page.locator('meta[http-equiv="Content-Security-Policy" i]').evaluateAll((metas) => metas.map((meta) => meta.getAttribute("content"))).catch(() => []);
      const title = await page.title().catch(() => "(no title)");
      results[`${manager} ${site}`] = { status: response?.status(), title, csp, metaCsp, ...probe };
      console.log(manager, site, JSON.stringify(probe));
      await page.close();
    }
  } finally {
    await context.close();
  }
}
await assets.close();
await writeFile(join(import.meta.dirname, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(`Wrote ${join(import.meta.dirname, "results.json")}`);
