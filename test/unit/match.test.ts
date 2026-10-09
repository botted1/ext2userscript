import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { urlMatches } from "../../src/runtime/match.ts";

const cases: Array<[pattern: string, url: string, expected: boolean]> = [
  ["<all_urls>", "https://example.com/a", true],
  ["<all_urls>", "chrome://extensions/", false],
  ["*://*/*", "http://example.com/", true],
  ["*://*/*", "https://example.com/x?y=1", true],
  ["*://*/*", "ftp://example.com/", false],
  ["https://*.github.com/*", "https://github.com/a", true],
  ["https://*.github.com/*", "https://gist.github.com/a", true],
  ["https://*.github.com/*", "https://notgithub.com/a", false],
  ["https://github.com/*/issues", "https://github.com/a/b/issues", true],
  ["https://github.com/*/issues", "https://github.com/a/issues/1", false],
  ["http://127.0.0.1/*", "http://127.0.0.1:8080/page", true],
  ["http://127.0.0.1:8080/*", "http://127.0.0.1:8080/page", true],
  ["http://127.0.0.1:8080/*", "http://127.0.0.1:9090/page", false],
  ["https://example.com/*", "https://example.com/page#fragment", true],
  ["https://example.com/page", "https://example.com/page?q=1", false],
  ["file:///*", "file:///Users/x/a.html", true],
];

describe("urlMatches", () => {
  for (const [pattern, url, expected] of cases) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${url}`, () => {
      assert.equal(urlMatches(url, [pattern]), expected);
    });
  }

  it("matches when any pattern matches", () => {
    assert.equal(urlMatches("https://b.example/", ["https://a.example/*", "https://b.example/*"]), true);
  });

  it("rejects invalid patterns", () => {
    assert.throws(() => urlMatches("https://example.com/", ["example.com/*"]), /Invalid match pattern/);
    assert.throws(() => urlMatches("https://example.com/", ["https://example.com"]), /Invalid match pattern/);
  });
});
