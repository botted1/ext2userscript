// The popup and options pages' modal (spec §6): a host in the top layer, with a closed shadow root holding a backdrop
// and a panel with a same-origin about:blank iframe. The page's DOM is built in the iframe from the converter's tree with
// createElement, its CSS goes in through gm.addElement, and its code (pages.ts) runs in the userscript with the iframe's
// globals. Every style the modal sets goes through the CSSOM (element.style), which a page's CSP doesn't block, unlike a
// style element or attribute.
import type { Assets } from "./assets.ts";
import type { PageConfig, PageKind, PageNode } from "./config.ts";
import type { Gm } from "./gm.ts";

/** Chrome's popup limits. */
const POPUP_MAX = { width: 800, height: 600 };
const NS = { svg: "http://www.w3.org/2000/svg", math: "http://www.w3.org/1998/Math/MathML" } as const;
const XLINK = "http://www.w3.org/1999/xlink";

export type Modal = { win: Window & typeof globalThis; doc: Document; close(): void };

/** Opens the modal and returns its iframe's window and document; onClose runs once, however it closes. */
export function openModal(kind: PageKind, title: string, onClose: () => void): Modal {
  const host = document.createElement("div");
  // Inline !important beats the site's own !important rules (html > * { display: none !important }).
  host.style.cssText =
    "all: initial !important; display: block !important; position: fixed !important; inset: 0 !important; width: auto !important; height: auto !important; z-index: 2147483647 !important; background: transparent !important; border: 0 !important; margin: 0 !important; padding: 0 !important; overflow: visible !important;";
  const root = host.attachShadow({ mode: "closed" });
  const backdrop = document.createElement("div");
  backdrop.style.cssText = `position: fixed; inset: 0; background: ${kind === "options" ? "rgba(0, 0, 0, 0.4)" : "transparent"};`;
  const panel = document.createElement("div");
  panel.style.cssText =
    "position: fixed; display: flex; flex-direction: column; overflow: hidden; background: #fff; color: #000; border-radius: 8px; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.35);" +
    (kind === "popup"
      ? "top: 8px; right: 8px;"
      : "top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(960px, calc(100vw - 32px)); height: calc(100vh - 64px);");
  const frame = document.createElement("iframe");
  frame.style.cssText = `display: block; border: 0; background: #fff; ${kind === "popup" ? "width: 25px; height: 25px;" : "flex: 1; width: 100%;"}`;
  if (kind === "options") {
    // Chrome's options dialog has a title bar with the extension's name and a close button; a popup has neither.
    const bar = document.createElement("div");
    bar.style.cssText = "display: flex; align-items: center; padding: 8px 12px; font: 14px system-ui, sans-serif; border-bottom: 1px solid #ddd;";
    const name = document.createElement("span");
    name.style.cssText = "flex: 1;";
    name.textContent = title;
    const button = document.createElement("button");
    button.style.cssText = "all: initial; cursor: pointer; font: 18px system-ui, sans-serif; padding: 0 4px;";
    button.textContent = "×";
    button.setAttribute("aria-label", "Close");
    button.addEventListener("click", () => close());
    bar.append(name, button);
    panel.append(bar);
  }
  panel.append(frame);
  root.append(backdrop, panel);
  document.documentElement.append(host);
  // The top layer puts the modal over everything the site shows, whatever its z-index, and out of reach of a transform
  // or filter on <html> that would otherwise move a fixed element.
  host.popover = "manual";
  host.showPopover?.();
  const win = frame.contentWindow as (Window & typeof globalThis) | null;
  const doc = frame.contentDocument;
  if (!win || !doc) {
    host.remove();
    throw new Error("the page's frame has no document");
  }

  // An extension page's CSP runs no inline script: the same here, so HTML its code writes can't run any in the site's
  // world. With that, HTML strings may pass Trusted Types in this frame, as an extension page has no such rule.
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = "script-src 'none'; object-src 'none'";
  doc.head.append(csp);
  try {
    (win as unknown as { trustedTypes?: { createPolicy(name: string, rules: object): unknown } }).trustedTypes?.createPolicy("default", { createHTML: (html: string) => html });
  } catch {
    // The site's CSP allows only named policies (trusted-types <names>): HTML strings throw where the site enforces them.
  }
  let open = true;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  function close() {
    if (!open) return;
    open = false;
    removeEventListener("keydown", onKey, true);
    // What a closing popup gets in Chrome, so code that saves its state on the way out runs.
    for (const type of ["pagehide", "unload"]) {
      try {
        win?.dispatchEvent(new (win as Window & typeof globalThis).Event(type));
      } catch {
        // The page's own listeners report their errors; nothing else can throw here.
      }
    }
    host.remove();
    onClose();
  }
  backdrop.addEventListener("click", () => close());
  addEventListener("keydown", onKey, true);
  win.addEventListener("keydown", onKey, true);
  if (kind === "popup") {
    // A popup is as big as its content, within Chrome's limits: the iframe's <html> shrinks to fit, and the frame follows it.
    doc.documentElement.style.width = "fit-content";
    const fit = () => {
      const box = doc.documentElement.getBoundingClientRect();
      frame.style.width = `${Math.min(POPUP_MAX.width, Math.max(25, Math.ceil(box.width)))}px`;
      frame.style.height = `${Math.min(POPUP_MAX.height, Math.max(25, Math.ceil(doc.documentElement.scrollHeight)))}px`;
    };
    frame.style.width = `${POPUP_MAX.width}px`;
    new win.ResizeObserver(fit).observe(doc.documentElement);
  }
  return { win, doc, close };
}

/** Builds the page's DOM in the iframe document, then adds its CSS; resolves once the CSS is in. */
export async function buildPage(doc: Document, page: PageConfig, deps: { gm: Gm; assets: Pick<Assets, "css" | "placeholders"> }): Promise<void> {
  const setAttributes = (element: Element, attributes: ReadonlyArray<[string, string]>) => {
    for (const [name, value] of attributes) {
      // Through the CSSOM, which the site's CSP doesn't block as it can block a style attribute.
      if (name === "style") (element as HTMLElement).style.cssText = deps.assets.placeholders(value);
      // SVG's xlink:href and the like belong in the XLink namespace, as the HTML parser puts them.
      else if (name.startsWith("xlink:")) element.setAttributeNS(XLINK, name, deps.assets.placeholders(value));
      else element.setAttribute(name, deps.assets.placeholders(value));
    }
  };
  const build = (nodes: readonly PageNode[], parent: Node, ns?: string) => {
    for (const node of nodes) {
      if (typeof node === "string") {
        parent.appendChild(doc.createTextNode(node));
        continue;
      }
      const [name, attributes, children] = node;
      const childNs = name === "svg" ? NS.svg : name === "math" ? NS.math : ns;
      const element = childNs ? doc.createElementNS(childNs, name) : doc.createElement(name);
      setAttributes(element, attributes);
      // A <template>'s children belong in its content fragment, as the HTML parser puts them.
      build(children, name === "template" && !childNs ? (element as HTMLTemplateElement).content : element, childNs === NS.svg && name === "foreignObject" ? undefined : childNs);
      parent.appendChild(element);
    }
  };
  setAttributes(doc.documentElement, page.htmlAttributes);
  setAttributes(doc.body, page.bodyAttributes);
  if (page.title !== undefined) doc.title = page.title;
  build(page.head.filter((node) => typeof node !== "string" && node[0] !== "title"), doc.head);
  build(page.body, doc.body);
  for (const css of page.css) await deps.gm.addElement(doc.head, "style", { textContent: deps.assets.css(css) });
}

/** Fires what a loaded page gets, once its code has run: DOMContentLoaded on the document, then load on the window. */
export function finishLoading(win: Window & typeof globalThis, doc: Document): void {
  doc.dispatchEvent(new win.Event("DOMContentLoaded", { bubbles: true }));
  setTimeout(() => win.dispatchEvent(new win.Event("load")));
}
