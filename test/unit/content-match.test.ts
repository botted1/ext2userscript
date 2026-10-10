import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterMatches, globToRegExp, urlMatches } from "../../src/runtime/match.ts";

describe("match patterns, Plan 2 additions", () => {
  it("compares the pattern's host lower-cased", () => {
    assert.equal(urlMatches("https://github.com/a", ["https://GitHub.com/*"]), true);
  });

  it("accepts IPv6 hosts", () => {
    assert.equal(urlMatches("http://[::1]:8080/a", ["http://[::1]/*"]), true);
    assert.equal(urlMatches("http://[::2]/a", ["http://[::1]/*"]), false);
  });

  it("treats a scheme's default port as no port", () => {
    assert.equal(urlMatches("https://example.com/x", ["https://example.com:443/*"]), true);
    assert.equal(urlMatches("http://example.com/x", ["http://example.com:80/*"]), true);
    assert.equal(urlMatches("https://example.com:8443/x", ["https://example.com:443/*"]), false);
  });
});

describe("globToRegExp", () => {
  it("matches * as any run and ? as one character, across the whole URL", () => {
    assert.equal(globToRegExp("*glob-yes*").test("http://a.test/glob-yes.html"), true);
    assert.equal(globToRegExp("http://a.test/?.html").test("http://a.test/x.html"), true);
    assert.equal(globToRegExp("http://a.test/?.html").test("http://a.test/xy.html"), false);
    assert.equal(globToRegExp("http://a.test/a+b(c).html").test("http://a.test/a+b(c).html"), true);
  });
});

describe("filterMatches", () => {
  const filter = { matches: ["https://a.test/*"], excludeMatches: ["https://a.test/private/*"], includeGlobs: [], excludeGlobs: [] };

  it("applies matches and exclude_matches", () => {
    assert.equal(filterMatches("https://a.test/x", filter), true);
    assert.equal(filterMatches("https://a.test/private/x", filter), false);
    assert.equal(filterMatches("https://b.test/x", filter), false);
  });

  it("narrows matches with include_globs", () => {
    const narrowed = { ...filter, includeGlobs: ["*/docs/*", "*/blog/*"] };
    assert.equal(filterMatches("https://a.test/docs/1", narrowed), true);
    assert.equal(filterMatches("https://a.test/blog/1", narrowed), true);
    assert.equal(filterMatches("https://a.test/x", narrowed), false);
  });

  it("subtracts exclude_globs, ignoring the fragment", () => {
    const excluded = { ...filter, excludeGlobs: ["*.pdf"] };
    assert.equal(filterMatches("https://a.test/file.pdf#page=2", excluded), false);
    assert.equal(filterMatches("https://a.test/file.html", excluded), true);
  });
});
