// THROWAWAY spike S2 (spec §11): does the popup approach (§6) work on strict-CSP sites?
// - A modal with an about:blank iframe, filled from the userscript.
// - Styles go through gm.addElement; images and fonts load from blob: and data: URLs.
// Results go on <html data-x2u-s2>.
import { createGm } from "../../src/runtime/gm.ts";

declare const __S2_ASSETS__: string; // origin of run.ts's asset server, injected with esbuild define

const gm = createGm();
const results: Record<string, unknown> = {};
const report = () => document.documentElement.setAttribute("data-x2u-s2", JSON.stringify(results));

main().catch((error: unknown) => {
  results.error = String(error);
  report();
});

async function main() {
  const png = await fetchBytes(`${__S2_ASSETS__}/pixel.png`);
  const font = await fetchBytes(`${__S2_ASSETS__}/font.ttf`);
  const pngBlob = URL.createObjectURL(new Blob([png], { type: "image/png" }));
  const fontBlob = URL.createObjectURL(new Blob([font], { type: "font/ttf" }));
  const pngData = `data:image/png;base64,${toBase64(png)}`;
  const fontData = `data:font/ttf;base64,${toBase64(font)}`;

  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const frame = document.createElement("iframe");
  frame.style.cssText = "width: 400px; height: 300px; border: 0";
  root.append(frame);
  document.body.append(host);
  const doc = frame.contentDocument;
  const win = frame.contentWindow as unknown as (typeof globalThis & Window) | null;
  if (!doc || !win) throw new Error("the about:blank iframe has no document");

  try {
    doc.body.innerHTML = "<b>x</b>";
    results.innerHtml = true;
  } catch (error) {
    results.innerHtml = String(error); // Trusted Types sites block this
  }
  try {
    new DOMParser().parseFromString("<b>x</b>", "text/html");
    results.domParser = true;
  } catch (error) {
    results.domParser = String(error);
  }
  doc.body.replaceChildren();

  await gm.addElement(doc.head, "style", {
    textContent: `#t { color: rgb(1, 2, 3); } @font-face { font-family: x2uBlob; src: url(${fontBlob}); } @font-face { font-family: x2uData; src: url(${fontData}); }`,
  });
  const plain = doc.createElement("style");
  plain.textContent = "#t { background-color: rgb(4, 5, 6); }";
  doc.head.append(plain);

  const text = doc.createElement("div");
  text.id = "t";
  text.textContent = "before";
  doc.body.append(text);
  text.textContent = "js-ran"; // JS running in the userscript, driving the iframe's DOM
  results.jsRan = doc.getElementById("t")?.textContent === "js-ran";
  let clicks = 0;
  win.addEventListener("click", () => clicks++);
  text.click();
  results.eventsWork = clicks === 1;
  const style = win.getComputedStyle(text);
  results.gmStyleApplied = style.color === "rgb(1, 2, 3)";
  results.plainStyleApplied = style.backgroundColor === "rgb(4, 5, 6)";

  results.imgBlob = await imageLoads(doc, pngBlob);
  results.imgData = await imageLoads(doc, pngData);
  results.imgIframeBlob = await imageLoads(doc, win.URL.createObjectURL(new win.Blob([png], { type: "image/png" })));
  results.fontBlob = await fontLoads(doc, "x2uBlob");
  results.fontData = await fontLoads(doc, "x2uData");
  results.done = true;
  report();
}

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await gm.xmlHttpRequest({ url, responseType: "arraybuffer" });
  return new Uint8Array(response.response as ArrayBuffer);
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function imageLoads(doc: Document, src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = doc.createElement("img");
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 5_000);
    img.src = src;
    doc.body.append(img);
  });
}

async function fontLoads(doc: Document, family: string): Promise<boolean> {
  try {
    await Promise.race([doc.fonts.load(`16px ${family}`), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  } catch {
    return false;
  }
  return [...doc.fonts].some((face) => face.family.replace(/["']/g, "") === family && face.status === "loaded");
}
