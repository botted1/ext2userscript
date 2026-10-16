// chrome.cookies (spec §5.2) through gm.cookie, which needs caps.cookies (spec §5.1): without it every call rejects with
// an error naming GM_cookie. One cookie store, "0".
// Ceilings: onChanged never fires; what the manager lets a script read decides what this sees (Violentmonkey shows
// httpOnly cookies only when the user allows it).
import { createEvent, method, type Logger } from "./chrome.ts";
import type { CookieDetails, Gm, GmCookie } from "./gm.ts";

type ChromeCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  session: boolean;
  expirationDate?: number;
  storeId: string;
};

const toChrome = (cookie: GmCookie & { hostOnly?: boolean; sameSite?: string; session?: boolean }, url?: string): ChromeCookie => ({
  name: cookie.name,
  value: cookie.value,
  domain: cookie.domain ?? (url ? new URL(url).hostname : ""),
  hostOnly: cookie.hostOnly ?? !cookie.domain?.startsWith("."),
  path: cookie.path ?? "/",
  secure: cookie.secure === true,
  httpOnly: cookie.httpOnly === true,
  sameSite: cookie.sameSite ?? "unspecified",
  session: cookie.session ?? cookie.expirationDate === undefined,
  ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
  storeId: "0",
});

export function createCookies(gm: Gm, log: Logger) {
  const onChanged = createEvent<(change: unknown) => void>(log);
  const list = (details: CookieDetails) => gm.cookie.list(details);

  return {
    OnChangedCause: { EVICTED: "evicted", EXPIRED: "expired", EXPLICIT: "explicit", EXPIRED_OVERWRITE: "expired_overwrite", OVERWRITE: "overwrite" },
    SameSiteStatus: { NO_RESTRICTION: "no_restriction", LAX: "lax", STRICT: "strict", UNSPECIFIED: "unspecified" },
    get: method(log, async (details: { url: string; name: string }) => {
      // The longest path first, as Chrome picks.
      const found = (await list({ url: details.url, name: details.name })).sort((a, b) => (b.path ?? "/").length - (a.path ?? "/").length)[0];
      return found ? toChrome(found, details.url) : null;
    }),
    getAll: method(log, async (details: CookieDetails & { secure?: boolean; session?: boolean } = {}) => {
      const { secure, session, ...query } = details;
      return (await list(query))
        .map((cookie) => toChrome(cookie, details.url))
        .filter((cookie) => (secure === undefined || cookie.secure === secure) && (session === undefined || cookie.session === session));
    }),
    set: method(log, async (details: CookieDetails & { url: string; sameSite?: string }) => {
      await gm.cookie.set(details);
      const [cookie] = await list({ url: details.url, name: details.name });
      return cookie ? toChrome(cookie, details.url) : null;
    }),
    remove: method(log, async (details: { url: string; name: string }) => {
      await gm.cookie.delete({ url: details.url, name: details.name });
      return { url: details.url, name: details.name, storeId: "0" };
    }),
    getAllCookieStores: method(log, async () => [{ id: "0", tabIds: [] }]),
    onChanged: onChanged.event,
  };
}
