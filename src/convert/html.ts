// A small HTML parser for extension pages (spec §6): the converter parses popup and options HTML at build time, and
// the runtime builds the page's DOM from the tree with createElement, so no HTML string is parsed in the browser (where
// Trusted Types can forbid it). Extension pages are short and usually made by bundlers, so this handles what they use:
// elements and attributes, void elements, raw text in script and style, comments, a doctype, character references.
// Names are lower-cased, as HTML does, except SVG's mixed-case ones (viewBox, foreignObject), which get their case back
// as the browser's tree builder gives it them: SVG is case-sensitive.
// Ceiling: of HTML's implied end tags, only a new li, option, p, dt/dd or table cell/row closing an open one of its
// kind; misnested tags and other implied structure come out as written.

export type HtmlAttribute = [name: string, value: string];
export type HtmlNode =
  | { type: "element"; name: string; attributes: HtmlAttribute[]; children: HtmlNode[] }
  | { type: "text"; text: string };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** Elements whose content is text up to their end tag; title and textarea's has character references decoded. */
const RAW = new Set(["script", "style", "title", "textarea"]);
/** A start tag that closes an open element of these names first, as HTML implies. */
const CLOSES: Readonly<Record<string, readonly string[]>> = {
  li: ["li"],
  option: ["option"],
  p: ["p"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
};
const NAMED: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»", middot: "·", bull: "•", times: "×",
};

/** Decodes character references; an unknown name stays as written, as browsers leave it. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] !== "#") return NAMED[name.toLowerCase()] ?? whole;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
  });
}

/** SVG's mixed-case names, by their lower-case form (the HTML standard's "adjust SVG" tables). */
const mixedCase = (names: string) => new Map(names.split(" ").map((name) => [name.toLowerCase(), name]));
const SVG_TAGS = mixedCase(
  "altGlyph altGlyphDef altGlyphItem animateColor animateMotion animateTransform clipPath feBlend feColorMatrix feComponentTransfer " +
    "feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG " +
    "feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile " +
    "feTurbulence foreignObject glyphRef linearGradient radialGradient textPath",
);
const SVG_ATTRIBUTES = mixedCase(
  "attributeName attributeType baseFrequency baseProfile calcMode clipPathUnits diffuseConstant edgeMode filterUnits glyphRef " +
    "gradientTransform gradientUnits kernelMatrix kernelUnitLength keyPoints keySplines keyTimes lengthAdjust limitingConeAngle " +
    "markerHeight markerUnits markerWidth maskContentUnits maskUnits numOctaves pathLength patternContentUnits patternTransform " +
    "patternUnits pointsAtX pointsAtY pointsAtZ preserveAlpha preserveAspectRatio primitiveUnits refX refY repeatCount repeatDur " +
    "requiredExtensions requiredFeatures specularConstant specularExponent spreadMethod startOffset stdDeviation stitchTiles " +
    "surfaceScale systemLanguage tableValues targetX targetY textLength viewBox viewTarget xChannelSelector yChannelSelector zoomAndPan",
);

const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attributes(source: string): HtmlAttribute[] {
  const out: HtmlAttribute[] = [];
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (!out.some(([existing]) => existing === name)) out.push([name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? "")]);
  }
  return out;
}

/** The page's top-level nodes (a doctype and comments are left out). */
export function parseHtml(html: string): HtmlNode[] {
  const root: HtmlNode[] = [];
  const open: Array<Extract<HtmlNode, { type: "element" }>> = [];
  const into = () => (open.length > 0 ? open[open.length - 1].children : root);
  /** Inside an <svg>, but not in a foreignObject's HTML. */
  const inSvg = () => {
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].name === "foreignObject") return false;
      if (open[i].name === "svg") return true;
    }
    return false;
  };
  const text = (value: string) => {
    if (!value) return;
    const nodes = into();
    const last = nodes[nodes.length - 1];
    if (last?.type === "text") last.text += decodeEntities(value);
    else nodes.push({ type: "text", text: decodeEntities(value) });
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const tag = /^<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(html.slice(lt));
    if (!tag) {
      // A "<" that starts no tag is text.
      text("<");
      i = lt + 1;
      continue;
    }
    i = lt + tag[0].length;
    const name = tag[2].toLowerCase();
    if (tag[1]) {
      // An end tag closes the nearest open element of its name, and anything opened inside it; a stray one is ignored.
      const at = open.map((element) => element.name.toLowerCase()).lastIndexOf(name);
      if (at !== -1) open.length = at;
      continue;
    }
    const closes = CLOSES[name];
    if (closes && open.length > 0 && closes.includes(open[open.length - 1].name)) open.pop();
    const selfClosing = /\/\s*$/.test(tag[3]);
    const element: Extract<HtmlNode, { type: "element" }> = { type: "element", name, attributes: attributes(tag[3].replace(/\/\s*$/, "")), children: [] };
    if (name === "svg" || inSvg()) {
      element.name = SVG_TAGS.get(name) ?? name;
      element.attributes = element.attributes.map(([key, value]) => [SVG_ATTRIBUTES.get(key) ?? key, value]);
    }
    into().push(element);
    if (RAW.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, i);
      const content = html.slice(i, end === -1 ? html.length : end);
      if (content) element.children.push({ type: "text", text: name === "title" || name === "textarea" ? decodeEntities(content) : content });
      const close = end === -1 ? -1 : html.indexOf(">", end);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    if (!VOID.has(name) && !selfClosing) open.push(element);
  }
  return root;
}
