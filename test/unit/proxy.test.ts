// The optional download proxy (proxy/worker.ts), run in Node with the stores' fetch stubbed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import proxy, { MAX_BYTES } from "../../proxy/worker.ts";
import { cwsCrxUrl, edgeCrxUrl } from "../../src/download.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const ask = (src: string, env = {}, init?: RequestInit) => proxy.fetch(new Request(`https://proxy.test/?src=${encodeURIComponent(src)}`, init), env);

describe("download proxy", () => {
  it("fetches a store page's archive, readable by the configured site only", async (t) => {
    const asked: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      asked.push(String(url));
      return new Response(new Uint8Array([80, 75, 3, 4]));
    });
    const response = await ask(`https://chromewebstore.google.com/detail/some-name/${ID}`, { ALLOWED_ORIGIN: "https://site.test" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://site.test");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [80, 75, 3, 4]);
    assert.deepEqual(asked, [cwsCrxUrl(ID)]);
  });

  it("refuses anything but a store page, and anything but GET, saying why", async () => {
    for (const src of ["https://example.com/extension.crx", `https://clients2.google.com/service/update2/crx?x=id%3D${ID}`, "not a url", ""]) {
      const response = await ask(src);
      assert.equal(response.status, 400, src);
      assert.match(await response.text(), /Chrome Web Store, Firefox Add-ons or Edge Add-ons/);
    }
    assert.equal((await ask(`https://chromewebstore.google.com/detail/${ID}`, {}, { method: "POST" })).status, 405);
  });

  it("stops at 50 MB, and passes the store's failure on", async (t) => {
    assert.equal(MAX_BYTES, 50 * 1024 * 1024);
    t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(MAX_BYTES + 1)));
    const large = await ask(`https://microsoftedge.microsoft.com/addons/detail/some-name/${ID}`);
    assert.equal(large.status, 502);
    assert.match(await large.text(), /larger than 50 MiB/);
    t.mock.method(globalThis, "fetch", async () => new Response("gone", { status: 404, statusText: "Not Found" }));
    const missing = await ask(`https://microsoftedge.microsoft.com/addons/detail/${ID}`);
    assert.equal(missing.status, 502);
    assert.equal(await missing.text(), `Download failed (404 Not Found): ${edgeCrxUrl(ID)}`);
  });
});
