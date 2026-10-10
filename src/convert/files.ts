// Small helpers for extension files: text decoding, base64 and MIME types. Isomorphic (Node and browser).

/** UTF-8 text, without a leading byte-order mark. */
export const decodeText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
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
