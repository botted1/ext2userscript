// The gm.ts contract (spec §10.3) on each backend in X2U_BACKENDS (default: emulator).
// Release tier and spike S1: X2U_BACKENDS=tm,vm, with a profile from `npm run bench:setup`.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { backendsFromEnv, startSession } from "../../bench/session.ts";
import { GRANTS } from "../../src/runtime/gm.ts";
import { waitForJson } from "../support/dom.ts";
import { startServer, type Server } from "../support/server.ts";
import { buildUserscript } from "../support/userscript.ts";

const page = (head = "") => () =>
  new Response(`<!doctype html><html><head><title>x2u</title>${head}</head><body>x2u</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });

type SingleResult = {
  done?: boolean;
  error?: string;
  handler?: string;
  caps?: { valueListeners: boolean; menus: boolean; cookies: boolean };
  addElementSync?: boolean;
  addElementResolved?: boolean;
  addElementError?: string;
  pageSawSync?: string;
  pageGlobalVisible?: boolean;
  roundtrip?: boolean;
  listed?: boolean;
  deleted?: boolean;
  localListener?: { value: unknown; remote: boolean } | null;
  menu?: boolean;
  xhrJson?: boolean;
  xhrBytes?: boolean;
  openInTab?: boolean;
  notification?: boolean;
  cookieSet?: boolean;
  cookieDeleted?: boolean;
};

for (const backend of backendsFromEnv()) {
  describe(`gm.ts contract on ${backend}`, () => {
    let site: Server;
    let other: Server;
    let api: Server;
    let userscript: string;

    before(async () => {
      site = await startServer({
        "/conformance.html": page(
          `<script>document.documentElement.setAttribute("data-page-saw-sync", document.documentElement.getAttribute("data-x2u-sync") ?? "no"); window.pageGlobal = "page";</script>`,
        ),
        "/reader.html": page(),
        "/opened.html": page(),
      });
      other = await startServer({ "/writer.html": page() });
      api = await startServer({
        "/echo": async (request) =>
          new URL(request.url).searchParams.has("bytes")
            ? new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "application/octet-stream" } })
            : Response.json({ body: await request.text(), header: request.headers.get("x-x2u") }),
      });
      userscript = await buildUserscript(`${import.meta.dirname}/probes/conformance.ts`, {
        name: "ext2userscript conformance",
        match: [`${site.origin}/*`, `${other.origin}/*`],
        grant: Object.values(GRANTS).flat(),
        connect: ["127.0.0.1"],
        runAt: "document-start",
        isolated: true,
      });
    });

    after(async () => {
      await site.close();
      await other.close();
      await api.close();
    });

    it("passes the single-page contract", async () => {
      const session = await startSession(backend, userscript);
      try {
        const tab = await session.context.newPage();
        await tab.goto(`${site.origin}/conformance.html?token=t${Date.now()}&api=${api.port}`);
        const r = await waitForJson<SingleResult>(tab, "data-x2u-conformance", (x) => x.done === true, 30_000);
        console.log(`[${backend}] ${JSON.stringify(r)}`);
        assert.equal(r.error, undefined, `probe threw: ${r.error}`);
        assert.equal(r.caps?.valueListeners, true);
        assert.equal(r.caps?.menus, true);
        assert.equal(r.addElementSync, true, "gm.addElement must run a page-world script synchronously");
        assert.equal(r.addElementResolved, true, r.addElementError);
        assert.equal(r.pageSawSync, "1", "a script injected at document-start must run before the page's own scripts");
        assert.equal(r.pageGlobalVisible, backend === "emulator", "content scripts must not see page globals (the emulator runs in the page world)");
        assert.equal(r.roundtrip, true);
        assert.equal(r.listed, true);
        assert.equal(r.deleted, true);
        assert.deepEqual(r.localListener, { value: "local", remote: false });
        assert.equal(r.menu, true);
        assert.equal(r.xhrJson, true);
        assert.equal(r.xhrBytes, true);
        assert.equal(r.openInTab, true);
        assert.equal(r.notification, true);
        if (r.caps?.cookies) {
          assert.equal(r.cookieSet, true);
          assert.equal(r.cookieDeleted, true);
        }
      } finally {
        await session.close();
      }
    });

    it("delivers value changes from another tab with remote: true", async () => {
      const session = await startSession(backend, userscript);
      try {
        const token = `t${Date.now()}`;
        const reader = await session.context.newPage();
        await reader.goto(`${site.origin}/reader.html?token=${token}`);
        await waitForJson<{ readerReady?: boolean }>(reader, "data-x2u-conformance", (x) => x.readerReady === true);
        const writer = await session.context.newPage();
        await writer.goto(`${other.origin}/writer.html?token=${token}`);
        const r = await waitForJson<{ remote?: unknown }>(reader, "data-x2u-conformance", (x) => x.remote !== undefined);
        assert.deepEqual(r.remote, { value: "hello", remote: true, listed: true });
      } finally {
        await session.close();
      }
    });
  });
}
