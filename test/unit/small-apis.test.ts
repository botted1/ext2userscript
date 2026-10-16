// chrome.notifications, chrome.cookies, chrome.permissions and chrome.windows, over fake GM functions.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/runtime/chrome.ts";
import type { RuntimeConfig } from "../../src/runtime/config.ts";
import { createCookies } from "../../src/runtime/cookies.ts";
import { createGm, type CookieDetails, type GmCookie } from "../../src/runtime/gm.ts";
import { createNotifications } from "../../src/runtime/notifications.ts";
import { createPermissions } from "../../src/runtime/permissions.ts";
import { createWindows } from "../../src/runtime/windows.ts";
import { createHub } from "../support/gm-hub.ts";

type Api = Record<string, (...args: unknown[]) => Promise<unknown>>;
const log = createLogger("test");

describe("notifications", () => {
  it("shows a notification through GM_notification, with an extension icon as a data URL, and reports clicks and closes", async () => {
    const shown: Array<{ title?: string; text: string; image?: string; onclick?: () => void; ondone?: () => void }> = [];
    const gm = createGm({ GM_notification: (details) => void shown.push(details) });
    const notifications = createNotifications({ gm, log, dataUrl: (path) => (path === "icons/48.png" ? "data:image/png;base64,AAAA" : undefined) });
    const api = notifications as unknown as Api & { onClicked: { addListener(fn: (id: string) => void): void }; onClosed: { addListener(fn: (id: string, byUser: boolean) => void): void } };
    const events: unknown[] = [];
    api.onClicked.addListener((id) => events.push(["clicked", id]));
    api.onClosed.addListener((id, byUser) => events.push(["closed", id, byUser]));
    assert.equal(await api.create("n1", { type: "list", iconUrl: "icons/48.png", title: "Hi", message: "Body", items: [{ title: "A", message: "1" }] }), "n1");
    assert.deepEqual([shown[0].title, shown[0].text, shown[0].image], ["Hi", "Body\nA: 1", "data:image/png;base64,AAAA"]);
    assert.deepEqual(await api.getAll(), { n1: true });
    shown[0].onclick?.();
    shown[0].ondone?.();
    assert.deepEqual(events, [["clicked", "n1"], ["closed", "n1", true]]);
    assert.match(String(await api.create({ title: "No id", message: "m" })), /^[\da-f-]{36}$/);
    assert.equal(await api.clear("missing"), false);
  });
});

describe("cookies", () => {
  it("reads and writes cookies through GM_cookie in Chrome's shape, picking the longest path for get", async () => {
    const jar: GmCookie[] = [
      { name: "sid", value: "root", domain: "site.test", path: "/" },
      { name: "sid", value: "deep", domain: "site.test", path: "/app", secure: true, expirationDate: 2e9 },
    ];
    const calls: string[] = [];
    const gm = createGm({
      GM_cookie: {
        list: (details: CookieDetails, done) => done(jar.filter((cookie) => details.name === undefined || cookie.name === details.name)),
        set: (details: CookieDetails, done) => {
          calls.push(`set ${details.name}=${details.value}`);
          jar.push({ name: details.name ?? "", value: details.value ?? "", domain: "site.test", path: "/" });
          done();
        },
        delete: (details: CookieDetails, done) => {
          calls.push(`delete ${details.name}`);
          done();
        },
      },
    });
    const cookies = createCookies(gm, log) as unknown as Api;
    assert.deepEqual(await cookies.get({ url: "https://site.test/app/x", name: "sid" }), {
      name: "sid", value: "deep", domain: "site.test", hostOnly: true, path: "/app", secure: true, httpOnly: false, sameSite: "unspecified", session: false, expirationDate: 2e9, storeId: "0",
    });
    assert.deepEqual(((await cookies.getAll({ secure: false })) as Array<{ value: string }>).map((cookie) => cookie.value), ["root"]);
    assert.equal(((await cookies.set({ url: "https://site.test/", name: "new", value: "1" })) as { value: string }).value, "1");
    assert.deepEqual(await cookies.remove({ url: "https://site.test/", name: "new" }), { url: "https://site.test/", name: "new", storeId: "0" });
    assert.deepEqual(calls, ["set new=1", "delete new"]);
  });

  it("rejects naming GM_cookie when the manager has none", async () => {
    await assert.rejects((createCookies(createGm({}), log) as unknown as Api).getAll({}), /GM_cookie is not available/);
  });
});

describe("permissions", () => {
  const config = (): RuntimeConfig => ({
    name: "E", ns: "t", id: "i", manifest: {}, groups: [], assets: {}, locales: {},
    permissions: { api: ["storage"], optionalApi: ["cookies"], origins: ["https://*.site.test/*"], optionalOrigins: ["https://api.test/*"] },
  });

  it("answers from the manifest, and grants and removes optional permissions, keeping them in a GM value", async () => {
    const hub = createHub();
    const permissions = (await createPermissions(createGm(hub.tab()), "t", log, config())) as unknown as Api & { onAdded: { addListener(fn: (p: unknown) => void): void } };
    const added: unknown[] = [];
    permissions.onAdded.addListener((p) => added.push(p));
    assert.equal(await permissions.contains({ permissions: ["storage"], origins: ["https://www.site.test/*"] }), true);
    assert.equal(await permissions.contains({ permissions: ["cookies"] }), false);
    assert.equal(await permissions.request({ permissions: ["cookies"], origins: ["https://api.test/*"] }), true);
    assert.deepEqual(added, [{ permissions: ["cookies"], origins: ["https://api.test/*"] }]);
    // Another start of the background sees the grant.
    const again = (await createPermissions(createGm(hub.tab()), "t", log, config())) as unknown as Api;
    assert.deepEqual(await again.getAll(), { permissions: ["storage", "cookies"], origins: ["https://*.site.test/*", "https://api.test/*"] });
    assert.equal(await again.remove({ permissions: ["cookies"] }), true);
    assert.equal(await again.contains({ permissions: ["cookies"] }), false);
  });

  it("refuses permissions the manifest doesn't list, and removing required ones, as Chrome does", async () => {
    const permissions = (await createPermissions(createGm(createHub().tab()), "t", log, config())) as unknown as Api;
    await assert.rejects(permissions.request({ permissions: ["history"] }), /Only permissions specified in the manifest may be requested/);
    await assert.rejects(permissions.request({ origins: ["https://evil.test/*"] }), /Only permissions specified in the manifest may be requested/);
    await assert.rejects(permissions.remove({ permissions: ["storage"] }), /You cannot remove required permissions/);
  });
});

describe("windows", () => {
  it("reports one window holding every tab, and opens a new window's URLs as tabs", async () => {
    const opened: unknown[] = [];
    const windows = createWindows({ query: async () => [{ id: 1 }, { id: 2 }], create: async (properties) => void opened.push(properties) }, log) as unknown as Api;
    const current = (await windows.getCurrent({ populate: true })) as { id: number; tabs: unknown[]; type: string };
    assert.deepEqual([current.id, current.tabs, current.type], [1, [{ id: 1 }, { id: 2 }], "normal"]);
    assert.equal(((await windows.getAll()) as unknown[]).length, 1);
    await assert.rejects(windows.get(5), /No window with id: 5\./);
    await windows.create({ url: ["https://a.test/", "https://b.test/"], focused: false });
    assert.deepEqual(opened, [{ url: "https://a.test/", active: false }, { url: "https://b.test/", active: false }]);
  });
});
