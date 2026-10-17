// The build-time HTML parser for extension pages.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, parseHtml, type HtmlNode } from "../../src/convert/html.ts";

/** A compact form of a tree, for comparing: elements as [name, {attributes}, ...children], text as strings. */
const shape = (nodes: HtmlNode[]): unknown[] => nodes.map((node) => (node.type === "text" ? node.text : [node.name, Object.fromEntries(node.attributes), ...shape(node.children)]));

describe("parseHtml", () => {
  it("reads elements, attributes in every quoting style, text and character references, and skips a doctype and comments", () => {
    const html = `<!DOCTYPE html><html lang=en><head><meta charset="utf-8"><title>A &amp; B</title></head><!-- note --><body class='x'><p id=a data-n="1 &lt; 2">Hi&nbsp;there &#128512; &unknown;</p></body></html>`;
    assert.deepEqual(shape(parseHtml(html)), [
      ["html", { lang: "en" }, ["head", {}, ["meta", { charset: "utf-8" }], ["title", {}, "A & B"]], ["body", { class: "x" }, ["p", { id: "a", "data-n": "1 < 2" }, "Hi there 😀 &unknown;"]]],
    ]);
  });

  it("keeps script and style content as raw text, even with tags in it", () => {
    const html = `<script>if (a < b && c > d) document.write("<b>x</b>");</script><style>a > b { content: "</p>"; }</style><div>after</div>`;
    assert.deepEqual(shape(parseHtml(html)), [
      ["script", {}, 'if (a < b && c > d) document.write("<b>x</b>");'],
      ["style", {}, 'a > b { content: "</p>"; }'],
      ["div", {}, "after"],
    ]);
  });

  it("closes void and self-closing elements, and an open li, option or p when another starts", () => {
    const html = `<ul><li>one<li>two</ul><img src=a.png><br/><svg viewBox="0 0 1 1"><path d="M0 0"/></svg><p>a<p>b`;
    assert.deepEqual(shape(parseHtml(html)), [
      ["ul", {}, ["li", {}, "one"], ["li", {}, "two"]],
      ["img", { src: "a.png" }],
      ["br", {}],
      ["svg", { viewbox: "0 0 1 1" }, ["path", { d: "M0 0" }]],
      ["p", {}, "a"],
      ["p", {}, "b"],
    ]);
  });

  it("closes what an end tag's element left open, ignores a stray end tag, and keeps a lone < as text", () => {
    assert.deepEqual(shape(parseHtml("<div><span>a</div>b</span> 1 < 2")), [["div", {}, ["span", {}, "a"]], "b 1 < 2"]);
  });

  it("keeps the first of a repeated attribute, as browsers do", () => {
    assert.deepEqual(shape(parseHtml('<a href="1" href="2" disabled>x</a>')), [["a", { href: "1", disabled: "" }, "x"]]);
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references, and leaves unknown ones", () => {
    assert.equal(decodeEntities("&lt;&#65;&#x42;&quot;&hellip;&nope;&#0;"), '<AB"…&nope;�');
  });
});
