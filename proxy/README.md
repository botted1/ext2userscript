# Download proxy

The web app converts an extension's archive in the browser, but it can't download one from a store itself: the
Chrome Web Store, Firefox Add-ons and Edge Add-ons send no CORS headers, so a page may not read their downloads. This
Cloudflare Worker fetches the archive for it. It is off by default, and the web app works without it: people drop the
extension's file instead.

## What it does

- It answers `GET /?src=<store page URL>`, where the URL is an extension's page on the Chrome Web Store
  (`chromewebstore.google.com`), Firefox Add-ons (`addons.mozilla.org`) or Edge Add-ons (`microsoftedge.microsoft.com`).
  Anything else gets a 400; any method but GET, a 405.
- It downloads that extension's archive (`src/download.ts`, as the CLI does) and returns it, up to 50 MB. A larger or
  failed download gets a 502, with the reason as plain text, which the web app shows.
- Only the site in `ALLOWED_ORIGIN` may read its answers (`Access-Control-Allow-Origin`).

## Hosting it

1. In `wrangler.toml`, set `ALLOWED_ORIGIN` to the web app's origin, such as `https://<you>.github.io`.
2. From this folder, run `npx wrangler deploy` (it asks you to log in to Cloudflare the first time). It prints the
   proxy's URL, such as `https://ext2userscript-proxy.<account>.workers.dev`.
3. Build the web app with that URL: `X2U_PROXY_URL=https://ext2userscript-proxy.<account>.workers.dev npm run web`. For
   the GitHub Pages build, set the repository variable `X2U_PROXY_URL` instead.

The store-link field in the web app is enabled only when it was built with a proxy URL.
