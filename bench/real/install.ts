// Installs a userscript into a real manager the way a user would: open the .user.js, then confirm the install.
import type { BrowserContext, Locator } from "playwright";
import { startServer } from "../../test/support/server.ts";

const INSTALL_BUTTON = /^(install|reinstall|update|overwrite|confirm installation|confirm re-installation)$/i;

/**
 * The install button on whichever page of the manager shows one. Every launch counts as a fresh install to
 * the manager, so it may have opened a welcome or options page of its own too, and those have no such button.
 */
async function findInstallButton(context: BrowserContext, extensionId: string, timeout: number): Promise<Locator | undefined> {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const page of context.pages()) {
      if (!page.url().startsWith(`chrome-extension://${extensionId}/`)) continue;
      const button = page.getByRole("button", { name: INSTALL_BUTTON }).first();
      if ((await button.count().catch(() => 0)) > 0) return button;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function installUserscript(context: BrowserContext, extensionId: string, code: string): Promise<void> {
  const server = await startServer({
    "/x2u-test.user.js": () => new Response(code, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
  });
  try {
    const opener = await context.newPage();
    void opener.goto(`${server.origin}/x2u-test.user.js`).catch(() => {}); // the manager takes over this navigation, so don't wait for it
    const button = await findInstallButton(context, extensionId, 20_000);
    if (!button) {
      const open = context.pages().map((page) => page.url()).join(", ");
      throw new Error(`The manager (${extensionId}) did not offer an install button for the userscript (open pages: ${open})`);
    }
    const installPage = button.page();
    // A manager may close its page the moment the install is confirmed, even before the click returns.
    await button.click({ timeout: 20_000 }).catch((error: unknown) => {
      if (!installPage.isClosed()) throw error;
    });
    // The close event has already fired if the page is closed, so waiting for it would only run out the timeout.
    if (!installPage.isClosed()) await installPage.waitForEvent("close", { timeout: 10_000 }).catch(() => installPage.close());
    if (!opener.isClosed()) await opener.close();
  } finally {
    await server.close();
  }
}
