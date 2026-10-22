// Small helpers for extension files: text decoding, base64, deflating and MIME types. Isomorphic (Node and browser).
import { deflateSync } from "fflate";
import type { AssetTable, Deflated } from "../runtime/config.ts";

/** UTF-8 text, without a leading byte-order mark. */
export const decodeText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Below this, deflating isn't worth the runtime's inflate. */
const SMALL = 1024;
const deflated = (bytes: Uint8Array) => toBase64(deflateSync(bytes));

/** A file for the asset table: its bytes in base64, or deflated (flagged 1) when that is at least a tenth smaller. */
export function packFile(mime: string, bytes: Uint8Array): AssetTable[string] {
  const plain = toBase64(bytes);
  if (bytes.length < SMALL) return [mime, plain];
  const packed = deflated(bytes);
  return packed.length < 0.9 * plain.length ? [mime, packed, 1] : [mime, plain];
}

/** Text for the runtime config, or deflated (src/runtime/assets.ts textOf) when that is at least a tenth smaller. */
export function packText(text: string): string | Deflated {
  if (text.length < SMALL) return text;
  const packed = deflated(new TextEncoder().encode(text));
  return packed.length < 0.9 * text.length ? { deflated: packed } : text;
}

/** A value for the runtime config, or its JSON deflated likewise (src/runtime/assets.ts messagesOf). */
export function packJson<T>(value: T): T | Deflated {
  const packed = packText(JSON.stringify(value));
  return typeof packed === "string" ? value : packed;
}

const MIME: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", html: "text/html", htm: "text/html",
  txt: "text/plain", xml: "application/xml", wasm: "application/wasm",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm",
};

/** The MIME type for a file, from its extension; application/octet-stream when unknown. */
export const mimeOf = (path: string): string => MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
