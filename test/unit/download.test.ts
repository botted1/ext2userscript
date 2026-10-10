import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CWS_PRODVERSION, cwsCrxUrl } from "../../src/download.ts";

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
