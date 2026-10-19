// Node half of the CI emulator (spec §10.2): stands in for Tampermonkey/Violentmonkey behind gm.ts.
// Shared values live here. Each page keeps a local copy (page.ts) that reads synchronously, and writes reach
// the other pages asynchronously with remote: true, as with a real manager.
import { build } from "esbuild";
import type { BrowserContext, Page } from "playwright";
import { scopeStrictMode } from "../../src/convert/runtime-node.ts";
import { parseMeta } from "./meta.ts";
import type { Hooks } from "./page.ts";

export type Emulator = {
  /** The values as the "manager" has stored them. */
  store: Map<string, unknown>;
  clickMenu(page: Page, caption: string): Promise<boolean>;
  menu(page: Page): Promise<string[]>;
  notifications(page: Page): Promise<Array<{ text: string; title?: string }>>;
};

type HookWindow = { __x2uEmu?: Hooks };

/** Playwright's wording when the page, frame or context went away while a call to it was in flight. */
const TARGET_GONE = /target (page, context or browser )?(has been )?closed|frame (was|got) detached|execution context was destroyed/i;

/** For calls into pages that may be closing or navigating: that is expected, anything else is a bug worth seeing. */
const ignoreGone = (error: unknown): void => {
  if (!TARGET_GONE.test(String(error))) console.error("[x2u emulator]", error);
};

let pageBundle: Promise<string> | undefined;
function bundlePage(): Promise<string> {
  pageBundle ??= build({
    entryPoints: [`${import.meta.dirname}/page.ts`],
    bundle: true,
    format: "iife",
    globalName: "__x2uEmuPage",
    platform: "browser",
    target: "es2020",
    write: false,
  }).then((result) => scopeStrictMode(result.outputFiles[0].text)); // a manager runs userscripts sloppy, so this must not make them strict
  return pageBundle;
}

export async function installEmulator(context: BrowserContext, userscript: string): Promise<Emulator> {
  const meta = parseMeta(userscript);
  const store = new Map<string, unknown>();
  const tabs = new Map<number, Page>();
  let nextTabId = 1;
  // Counts the writes to the store. A snapshot carries the revision of the last write it includes, and every change sent
  // to a page carries its own, so a page can tell a change its snapshot already holds from a newer one.
  let rev = 0;

  await context.route("**/__x2u_emu__/snapshot", (route) => route.fulfill({ json: { rev, values: Object.fromEntries(store) } }));

  await context.exposeBinding("__x2uEmuSet", async ({ frame }, key: string, value: unknown) => {
    const written = ++rev;
    if (value === undefined) store.delete(key);
    else store.set(key, value);
    for (const page of context.pages()) {
      for (const other of page.frames()) {
        if (other === frame) continue;
        other.evaluate(([k, v, r]) => (window as unknown as HookWindow).__x2uEmu?.apply(k, v, r), [key, value, written] as const).catch(ignoreGone);
      }
    }
  });

  await context.exposeBinding("__x2uEmuXhr", async (_source, d: { method: string; url: string; headers: Record<string, string>; data?: string; timeout?: number }) => {
    try {
      // context.request shares the browser context's cookies, like a manager's background fetch.
      const response = await context.request.fetch(d.url, { method: d.method, headers: d.headers, data: d.data, timeout: d.timeout ?? 0, failOnStatusCode: false });
      return {
        status: response.status(),
        statusText: response.statusText(),
        finalUrl: response.url(),
        responseHeaders: response.headersArray().map((h) => `${h.name}: ${h.value}`).join("\r\n"),
        contentType: response.headers()["content-type"] ?? "",
        bodyBase64: (await response.body()).toString("base64"),
      };
    } catch (error) {
      return { error: /timeout/i.test(String(error)) ? "timeout" : String(error) };
    }
  });

  await context.exposeBinding("__x2uEmuOpen", async ({ frame }, url: string) => {
    const id = nextTabId++;
    const page = await context.newPage();
    tabs.set(id, page);
    page.on("close", () => {
      frame.evaluate((tabId) => (window as unknown as HookWindow).__x2uEmu?.tabClosed(tabId), id).catch(ignoreGone);
    });
    page.goto(url).catch(ignoreGone);
    return id;
  });

  await context.exposeBinding("__x2uEmuClose", async (_source, id: number) => {
    await tabs.get(id)?.close();
  });

  await context.exposeBinding("__x2uEmuCookie", async (_source, op: "list" | "set" | "delete", d: { url?: string; name?: string; value?: string; domain?: string }) => {
    const url = d.url ?? "";
    if (op === "list") {
      const cookies = await context.cookies(url ? [url] : []);
      return cookies
        .filter((c) => !d.name || c.name === d.name)
        .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expires > 0 ? c.expires : undefined }));
    }
    if (op === "set") {
      await context.addCookies([{ name: d.name ?? "", value: d.value ?? "", url }]);
      return undefined;
    }
    await context.clearCookies({ name: d.name, domain: d.domain ?? new URL(url).hostname });
    return undefined;
  });

  // Declared as locals of the wrapper function, like a manager's sandbox: only granted names exist.
  const names = ["GM_info", ...meta.grant.filter((name) => /^GM_\w+$/.test(name))];
  const declarations = names.map((name) => `${name} = __x2uApi.${name}`).join(", ");
  await context.addInitScript({
    // Named, as a manager names a userscript in its stack frames: the runtime tells its own frames from the page's by it.
    content: `${await bundlePage()}\n__x2uEmuPage.boot(${JSON.stringify(meta)}, function (__x2uApi) {\nvar ${declarations};\n${userscript}\n});\n//# sourceURL=x2u-emulator-userscript.js`,
  });

  return {
    store,
    clickMenu: (page, caption) => page.evaluate((c) => (window as unknown as HookWindow).__x2uEmu?.clickMenu(c) ?? false, caption),
    menu: (page) => page.evaluate(() => (window as unknown as HookWindow).__x2uEmu?.menu() ?? []),
    notifications: (page) => page.evaluate(() => (window as unknown as HookWindow).__x2uEmu?.notifications ?? []),
  };
}
