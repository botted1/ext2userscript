// trustExtensionStrings over a stub DOM whose HTML sinks refuse plain strings, as a page that requires Trusted Types
// makes them. The runtime runs minified, as it ships, in scripts named like userscripts, so its stack frames are real.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInThisContext } from "node:vm";
import { loadEsbuild } from "../../src/convert/esbuild-node.ts";

class TrustedHTML {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

const refuse = (value: unknown) => {
  if (typeof value === "string") throw new TypeError("This document requires 'TrustedHTML' assignment.");
};

/** Fresh DOM classes on globalThis, so each test's runtimes wrap their own sinks. */
function installDom() {
  class Element {
    html: unknown;
    get innerHTML() {
      return String(this.html);
    }
    set innerHTML(value: unknown) {
      refuse(value);
      this.html = value;
    }
    get outerHTML() {
      return "";
    }
    set outerHTML(value: unknown) {
      refuse(value);
    }
    insertAdjacentHTML(_position: string, value: unknown) {
      refuse(value);
      this.html = value;
    }
  }
  class ShadowRoot {
    get innerHTML() {
      return "";
    }
    set innerHTML(value: unknown) {
      refuse(value);
    }
  }
  class HTMLScriptElement extends Element {
    get src() {
      return "";
    }
    set src(value: unknown) {
      refuse(value);
    }
  }
  class DOMParser {
    parseFromString(value: unknown) {
      refuse(value);
      return {};
    }
  }
  const trustedTypes = { createPolicy: (_name: string, rules: { createHTML(text: string): string }) => ({ createHTML: (text: string) => new TrustedHTML(rules.createHTML(text)), createScriptURL: (url: string) => url }) };
  Object.assign(globalThis, { Element, ShadowRoot, HTMLScriptElement, DOMParser, trustedTypes, document: { createElement: () => new Element() } });
  return Element;
}

const esbuild = await loadEsbuild();
const runtime = (await esbuild.build({ entryPoints: [new URL("../../src/runtime/trusted.ts", import.meta.url).pathname], bundle: true, format: "iife", globalName: "__x2uTrusted", minify: true, write: false })).outputFiles[0].text;

type Extension = { write(element: object, html: string): void; assign(element: object, html: string): void };
/** A converted userscript: the runtime, then the extension's code, in one script named as a manager names it. */
const userscript = (name: string): Extension =>
  runInThisContext(`${runtime}\n__x2uTrusted.trustExtensionStrings();\n({ write(element, html) { element.innerHTML = html; }, assign(element, html) { Object.assign(element, { innerHTML: html }); } })`, { filename: `${name}.user.js` });

describe("trustExtensionStrings", () => {
  let Element: ReturnType<typeof installDom>;
  beforeEach(() => {
    Element = installDom();
  });

  it("trusts the userscript's own strings, through a built-in such as Object.assign too, and leaves the page's refused", () => {
    const extension = userscript("a");
    const element = new Element();
    extension.write(element, "<b>written</b>");
    assert.equal((element.html as TrustedHTML).text, "<b>written</b>");
    extension.assign(element, "<b>assigned</b>");
    assert.equal((element.html as TrustedHTML).text, "<b>assigned</b>");
    assert.throws(() => (element.innerHTML = "<i>page</i>"), /TrustedHTML/);
  });

  it("keeps each converted userscript's strings trusted when two wrap the same sinks", () => {
    const first = userscript("first");
    const second = userscript("second");
    const element = new Element();
    first.write(element, "<b>first</b>");
    assert.equal((element.html as TrustedHTML).text, "<b>first</b>");
    second.write(element, "<b>second</b>");
    assert.equal((element.html as TrustedHTML).text, "<b>second</b>");
    first.assign(element, "<b>again</b>");
    assert.equal((element.html as TrustedHTML).text, "<b>again</b>");
    assert.throws(() => (element.innerHTML = "<i>page</i>"), /TrustedHTML/);
  });
});
