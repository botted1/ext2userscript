// Conformance probe (spec §10.3). Exercises the gm.ts contract through the real gm.ts and reports on
// <html data-x2u-conformance>. Runs on the CI emulator and on real Tampermonkey/Violentmonkey.
import { createGm } from "../../../src/runtime/gm.ts";

const html = document.documentElement;
const params = new URLSearchParams(location.search);
const results: Record<string, unknown> = {};
const report = () => html.setAttribute("data-x2u-conformance", JSON.stringify(results));
/** Every result is reported as soon as it is known, so a probe that hangs leaves its partial results behind. */
const record = (name: string, value: unknown) => {
  results[name] = value;
  report();
};
const fail = (error: unknown) => record("error", String(error));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const gm = createGm();

if (location.pathname === "/conformance.html") singlePage();
if (location.pathname === "/conformance-csp.html") strictCspPage();
if (location.pathname === "/reader.html") void reader().catch(fail);
if (location.pathname === "/writer.html") void gm.setValue(`conf:${params.get("token")}:remote`, "hello").catch(fail);

/**
 * A manager may start a document-start userscript only after the page has been parsed (spike S1), when DOMContentLoaded
 * has already fired. Waiting for it then would hang the probe, so the probe runs at once and records what it saw.
 */
function whenParsed(callback: () => void) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", callback, { once: true });
  else callback();
}

/** Runs at document-start, before the page's own scripts (spec §5.1 and S1). */
function injectIntoPage() {
  record("startReadyState", document.readyState);
  const injected = gm.addElement(html, "script", {
    textContent: 'document.documentElement.setAttribute("data-x2u-sync", "1"); window.__x2uPageWorld = 1;',
  });
  record("addElementSync", html.getAttribute("data-x2u-sync") === "1");
  injected.then(
    () => record("addElementResolved", true),
    (error: unknown) => record("addElementError", String(error)),
  );
}

function singlePage() {
  injectIntoPage();
  whenParsed(() => void afterParse());
}

/** The page's CSP only allows its own nonce'd script. All this page checks is whether the injection still got in first. */
function strictCspPage() {
  injectIntoPage();
  whenParsed(() => {
    record("pageSawSync", html.getAttribute("data-page-saw-sync"));
    record("pageSawWorld", html.getAttribute("data-page-saw-world"));
    record("done", true);
  });
}

async function afterParse() {
  try {
    const token = params.get("token") ?? "none";
    record("caps", gm.caps);
    record("handler", gm.handler);
    record("pageSawSync", html.getAttribute("data-page-saw-sync"));
    record("pageSawWorld", html.getAttribute("data-page-saw-world"));
    record("pageGlobalVisible", "pageGlobal" in window);

    const key = `conf:${token}:value`;
    let roundtrip = true;
    for (const value of ["s", 42, true, null, { a: [1, "b"] }, [1, 2]]) {
      await gm.setValue(key, value);
      roundtrip &&= JSON.stringify(await gm.getValue(key)) === JSON.stringify(value);
    }
    record("roundtrip", roundtrip);
    record("listed", (await gm.listValues()).includes(key));
    await gm.deleteValue(key);
    record("deleted", (await gm.getValue(key, "fallback")) === "fallback");

    const seen: Array<{ value: unknown; remote: boolean }> = [];
    const listener = await gm.addValueChangeListener(key, (_key, _old, value, remote) => seen.push({ value, remote }));
    await gm.setValue(key, "local");
    for (let i = 0; i < 60 && seen.length === 0; i++) await sleep(50); // up to 3 s for the listener to fire
    record("localListener", seen[0] ?? null);
    await gm.removeValueChangeListener(listener);
    await gm.deleteValue(key);

    const menuId = await gm.registerMenuCommand("ext2userscript conformance", () => {});
    await gm.unregisterMenuCommand(menuId);
    record("menu", true);

    const echo = `http://127.0.0.1:${params.get("api")}/echo`;
    const json = await gm.xmlHttpRequest({ url: echo, method: "POST", data: "ping", headers: { "x-x2u": "1" }, responseType: "json" });
    const body = json.response as { body?: string; header?: string } | undefined;
    record("xhrJson", json.status === 200 && body?.body === "ping" && body?.header === "1");
    const bytes = await gm.xmlHttpRequest({ url: `${echo}?bytes=1`, responseType: "arraybuffer" });
    record("xhrBytes", Object.prototype.toString.call(bytes.response) === "[object ArrayBuffer]" && (bytes.response as ArrayBuffer).byteLength === 4);

    const tab = await gm.openInTab(`${location.origin}/opened.html`, { active: false });
    await sleep(1_000);
    tab.close();
    for (let i = 0; i < 20 && !tab.closed; i++) await sleep(100);
    record("openInTab", tab.closed);

    await gm.notification({ title: "ext2userscript", text: "conformance check" });
    record("notification", true);

    if (gm.caps.cookies) {
      const url = location.href;
      await gm.cookie.set({ url, name: "x2u_conformance", value: token });
      record("cookieSet", (await gm.cookie.list({ url, name: "x2u_conformance" })).some((c) => c.value === token));
      await gm.cookie.delete({ url, name: "x2u_conformance" });
      record("cookieDeleted", !(await gm.cookie.list({ url, name: "x2u_conformance" })).some((c) => c.name === "x2u_conformance"));
    }
  } catch (error) {
    fail(error);
  }
  record("done", true);
}

async function reader() {
  const key = `conf:${params.get("token")}:remote`;
  await gm.addValueChangeListener(key, (_key, _old, value, remote) => {
    gm.listValues()
      .then((keys) => record("remote", { value, remote, listed: keys.includes(key) }))
      .catch(fail);
  });
  record("readerReady", true);
}
