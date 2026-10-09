// Conformance probe (spec §10.3). Exercises the gm.ts contract through the real gm.ts and reports on
// <html data-x2u-conformance>. Runs on the CI emulator and on real Tampermonkey/Violentmonkey.
import { createGm } from "../../../src/runtime/gm.ts";

const html = document.documentElement;
const params = new URLSearchParams(location.search);
const results: Record<string, unknown> = {};
const report = () => html.setAttribute("data-x2u-conformance", JSON.stringify(results));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const gm = createGm();

if (location.pathname === "/conformance.html") singlePage();
if (location.pathname === "/reader.html") void reader();
if (location.pathname === "/writer.html") void gm.setValue(`conf:${params.get("token")}:remote`, "hello");

function singlePage() {
  // Runs at document-start, before the page's own scripts (spec §5.1 and S1).
  const injected = gm.addElement(html, "script", {
    textContent: 'document.documentElement.setAttribute("data-x2u-sync", "1"); window.__x2uPageWorld = 1;',
  });
  results.addElementSync = html.getAttribute("data-x2u-sync") === "1";
  injected.then(
    () => { results.addElementResolved = true; },
    (error: unknown) => { results.addElementError = String(error); },
  );
  document.addEventListener("DOMContentLoaded", () => void afterParse(), { once: true });
}

async function afterParse() {
  try {
    const token = params.get("token") ?? "none";
    results.caps = gm.caps;
    results.handler = gm.handler;
    results.pageSawSync = html.getAttribute("data-page-saw-sync");
    results.pageGlobalVisible = "pageGlobal" in window;

    const key = `conf:${token}:value`;
    let roundtrip = true;
    for (const value of ["s", 42, true, null, { a: [1, "b"] }, [1, 2]]) {
      await gm.setValue(key, value);
      roundtrip &&= JSON.stringify(await gm.getValue(key)) === JSON.stringify(value);
    }
    results.roundtrip = roundtrip;
    results.listed = (await gm.listValues()).includes(key);
    await gm.deleteValue(key);
    results.deleted = (await gm.getValue(key, "fallback")) === "fallback";

    const seen: Array<{ value: unknown; remote: boolean }> = [];
    const listener = await gm.addValueChangeListener(key, (_key, _old, value, remote) => seen.push({ value, remote }));
    await gm.setValue(key, "local");
    await sleep(300);
    results.localListener = seen[0] ?? null;
    await gm.removeValueChangeListener(listener);
    await gm.deleteValue(key);

    const menuId = await gm.registerMenuCommand("ext2userscript conformance", () => {});
    await gm.unregisterMenuCommand(menuId);
    results.menu = true;

    const echo = `http://127.0.0.1:${params.get("api")}/echo`;
    const json = await gm.xmlHttpRequest({ url: echo, method: "POST", data: "ping", headers: { "x-x2u": "1" }, responseType: "json" });
    const body = json.response as { body?: string; header?: string } | undefined;
    results.xhrJson = json.status === 200 && body?.body === "ping" && body?.header === "1";
    const bytes = await gm.xmlHttpRequest({ url: `${echo}?bytes=1`, responseType: "arraybuffer" });
    results.xhrBytes = Object.prototype.toString.call(bytes.response) === "[object ArrayBuffer]" && (bytes.response as ArrayBuffer).byteLength === 4;

    const tab = await gm.openInTab(`${location.origin}/opened.html`, { active: false });
    await sleep(1_000);
    tab.close();
    for (let i = 0; i < 20 && !tab.closed; i++) await sleep(100);
    results.openInTab = tab.closed;

    await gm.notification({ title: "ext2userscript", text: "conformance check" });
    results.notification = true;

    if (gm.caps.cookies) {
      const url = location.href;
      await gm.cookie.set({ url, name: "x2u_conformance", value: token });
      results.cookieSet = (await gm.cookie.list({ url, name: "x2u_conformance" })).some((c) => c.value === token);
      await gm.cookie.delete({ url, name: "x2u_conformance" });
      results.cookieDeleted = !(await gm.cookie.list({ url, name: "x2u_conformance" })).some((c) => c.name === "x2u_conformance");
    }
  } catch (error) {
    results.error = String(error);
  }
  results.done = true;
  report();
}

async function reader() {
  const key = `conf:${params.get("token")}:remote`;
  await gm.addValueChangeListener(key, (_key, _old, value, remote) => {
    void gm.listValues().then((keys) => {
      results.remote = { value, remote, listed: keys.includes(key) };
      report();
    });
  });
  results.readerReady = true;
  report();
}
