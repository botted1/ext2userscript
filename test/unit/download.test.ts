import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { amoAddonUrl, CWS_PRODVERSION, cwsCrxUrl, edgeCrxUrl, fetchBytes } from "../../src/download.ts";
import { startServer, type Server } from "../support/server.ts";
import { sleep } from "../support/time.ts";

describe("cwsCrxUrl", () => {
  it("builds the Chrome Web Store download URL", () => {
    assert.equal(
      cwsCrxUrl("hlepfoohegkhhmjieoechaddaejaokhf"),
      `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${CWS_PRODVERSION}&acceptformat=crx2,crx3&x=id%3Dhlepfoohegkhhmjieoechaddaejaokhf%26uc`,
    );
  });

  it("rejects strings that are not extension IDs", () => {
    assert.throws(() => cwsCrxUrl("../etc"), /Not a Chrome Web Store extension ID/);
  });
});

describe("edgeCrxUrl and amoAddonUrl", () => {
  it("builds the Edge Add-ons download URL", () => {
    assert.equal(
      edgeCrxUrl("jbleklapnaakbjjeaojmpgajfgpnpnmf"),
      "https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=id%3Djbleklapnaakbjjeaojmpgajfgpnpnmf%26installsource%3Dondemand%26uc",
    );
    assert.throws(() => edgeCrxUrl("nope"), /Not an Edge Add-ons extension ID/);
  });

  it("builds the AMO API URL, escaping the slug", () => {
    assert.equal(amoAddonUrl("ublock-origin"), "https://addons.mozilla.org/api/v5/addons/addon/ublock-origin/");
    assert.equal(amoAddonUrl("{a b}"), "https://addons.mozilla.org/api/v5/addons/addon/%7Ba%20b%7D/");
  });
});

describe("fetchBytes", () => {
  let server: Server;

  before(async () => {
    server = await startServer({
      "/ok": () => new Response(new Uint8Array([1, 2, 3])),
      "/missing": () => new Response("no", { status: 404, statusText: "Not Found" }),
      "/big": () => new Response(new Uint8Array(2048)),
      "/slow": async () => {
        await sleep(500);
        return new Response("late");
      },
    });
  });

  after(() => server.close());

  it("returns the body", async () => assert.deepEqual(await fetchBytes(`${server.origin}/ok`), new Uint8Array([1, 2, 3])));

  it("fails with the status", async () => {
    await assert.rejects(fetchBytes(`${server.origin}/missing`), /Download failed \(404 Not Found\)/);
  });

  it("stops at maxBytes", async () => {
    await assert.rejects(fetchBytes(`${server.origin}/big`, { maxBytes: 1024 }), /Download is larger than/);
  });

  it("times out", async () => {
    await assert.rejects(fetchBytes(`${server.origin}/slow`, { timeoutMs: 100 }), /Download timed out after 0\.1 s/);
  });
});
