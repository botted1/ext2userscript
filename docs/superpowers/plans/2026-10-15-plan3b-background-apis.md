# ext2userscript Plan 3b: Background APIs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the converted background, and content scripts, the rest of spec §5.2: cross-origin requests, alarms, context menus and the toolbar button, keyboard shortcuts, notifications, cookies, permissions, windows, scripting and getBackgroundPage.

**Architecture:**
- **Network shim (`net.ts`):** `fetch` and `XMLHttpRequest`, passed to content scripts and the background as wrapper parameters.
  - A cross-origin request for a host the manifest's host permissions cover goes through `gm.xmlHttpRequest`.
  - An extension URL is served from the asset table.
  - Anything else stays native.
  - The header gets `@connect` per host.
- **New background APIs:** each is a small module, and `background.ts` assembles them into the background's `chrome`. They keep shared state in GM values: the alarm schedule, the context menu and the toolbar button's state, and granted optional permissions.
- **UI that has to live in every tab:**
  - Menu commands for context-menu items and the toolbar button.
  - Keydown listeners for the manifest's shortcuts.
  - Each tab's clicks and shortcuts reach the leader's background through a new `evt` message, which is held and resent like a background message.
- **`scripting`:** the background sends work to the target tab as a control request.
  - `files` were bundled by the converter.
  - A `func`'s source runs through `new Function`, or in the page's world where the page's CSP forbids eval.

**Tech Stack:**
- TypeScript, run directly by Node 22.16 with `--experimental-strip-types`.
- `node:test`.
- Playwright 1.64, on the emulator and the release tier.
- esbuild 0.28.2 and fflate 0.8.3.
- No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`

**Scope:** Plan 3b of 6. It completes spec §5.2 for the background and content scripts, as split off from Plan 3 on 2026-10-11.
- **Plan 4:** popup and options pages, so also `action.openPopup`, the "Open <name>" command, `runtime.openOptionsPage`, and `getBackgroundPage` from a popup.
- **Unconverted:** `scripting.registerContentScripts` and the other dynamic content-script APIs aren't in spec §5.2. They stay "isn't converted yet".

**Prototype:** every code block below was run before the plan was written, on 2026-10-15.

| Check | Result |
|---|---|
| Unit tests | 334 of 334; `tsc` clean |
| Replay | Task by task on a clean copy: every task type-checks and keeps the unit suite green on its own, and the result equals the prototype exactly |
| End-to-end on the emulator | 14 of 14, three runs; 1 skipped, which needs a real manager |
| End-to-end on Tampermonkey 5.5.1 and Violentmonkey 2.49.0 | 14 of 14 each; 1 emulator-only test skipped. Includes requests on a page whose CSP allows connections only to itself, and `executeScript` on a page whose CSP forbids eval |
| Emulator browser suite | Passes, apart from the known Firefox S3 failure on macOS 27 |
| S4 on both real managers | 1,050 of 1,050 messages, one leader at every check |
| GM conformance on both real managers | 6 of 6 |

What the prototype found:
1. **Eval in content-script sandboxes**, on a page whose CSP forbids it:
   - Tampermonkey's sandbox follows the page's CSP and refuses `new Function` and `eval`.
   - Violentmonkey allows them.
   - On a page without such a CSP, both allow them.

   So `executeScript`'s `func` runs through `new Function` where it can, and in the page's world through `gm.addElement` (which gets past the CSP) where it can't.
2. **Tampermonkey checks `@connect`** for `GM_xmlhttpRequest` to `localhost` too. With the host permissions' `@connect` lines, cross-origin requests worked on both managers, on a page whose CSP allows connections only to itself.
3. **`GM_cookie`** worked on both managers for the page's own origin.

**Spec corrections (Task 1 applies them; they need the human's OK along with this plan):**
1. **§1:** no runtime `eval` of extension code, except the function or code string that `scripting.executeScript` and `tabs.executeScript` send to a tab. A function's source is all there is to send.
2. **§3.3:** background and content scripts get `fetch` and `XMLHttpRequest` as wrapper parameters. A service worker's `XMLHttpRequest` is `undefined`, as in Chrome.
3. **§3.6:** with a background, the asset table also gets:
   - the manifest's icons (for notifications);
   - files the background fetches by relative URL;
   - style sheets it names (for `insertCSS`).

   Scripts it names are bundled like content scripts, for `executeScript({ files })`.
4. **§4:** `@connect` covers optional host permissions too, and becomes `*` when any host will do.
5. **§5.2:**
   - **`scripting`:** partial. Top frame only; a function runs in the page's world where the page's CSP forbids eval.
   - **`tabs.executeScript`:** partial, for the same reasons.
   - **`commands`:** partial. A shortcut works only while a page the userscript runs on has focus.
   - **`notifications`:** `update` and `clear` are partial. A shown notification can't be changed or taken back.
   - **`contextMenus`:** `onClicked` gets any selected text; items only for links, images, media or editable fields don't show.
   - **The toolbar button:** a menu command named after its title when it has no popup, with the badge in the caption.
   - **Network:** extension URLs, cookies for permitted hosts, and the network shim's ceilings.

## Global Constraints

- **Node:** Node ≥ 22.16. TypeScript runs directly with `--experimental-strip-types --disable-warning=ExperimentalWarning`. No tsx, no build step.
- **Running things:**
  - One test file: `npm run test:file -- <path>`.
  - One script: `npm run script -- <path>`.
- **TypeScript:**
  - Erasable syntax only (no `enum`, `namespace` or parameter properties).
  - Relative imports end in `.ts`.
  - Type-only imports use `import type` or inline `type`.
  - The `lib` is `es2022` plus DOM.
- **Exact versions:**
  - `esbuild` and `esbuild-wasm` 0.28.2.
  - `fflate` 0.8.3.
  - Dev: `playwright` 1.64.0, `typescript` 7.0.2, `@types/node` 22.20.5.
  - No other dependencies.
- **Tests:** `node:test` with `node:assert/strict`. Browser tests use the `playwright` library.
- **Isomorphic core:**
  - `src/convert/*` and `src/runtime/*` import no `node:` module and use no Node-only global.
  - Exceptions: `src/convert/esbuild-node.ts` and `src/convert/runtime-node.ts`.
  - `src/source.ts` and `src/cli.ts` are Node-only.
- **The GM layer:**
  - Every GM call goes through `src/runtime/gm.ts`.
  - `@grant` lines come from its `GRANTS` table, for the methods `support.ts` lists against each API the analyzer finds.
  - `@connect` lines come from the host permissions.
- **GM value keys (`x2u:<ns>:…`):**
  - Plan 3's keys: `tab:<id>`, `out:<id>`, `roster`, `s:<area>:<key>`, `storage-keys`, `ls:<key>`, `installed`, `session`.
  - New in this plan: `alarms` (the schedule), `menus` (context-menu items and the toolbar button's state), `permissions` (granted optional permissions).
- **Production timings:** Plan 3's, unchanged:
  - heartbeat every 2 s; stale after 90 s;
  - ghost check 1.5 s after a ring;
  - election grace 300 ms;
  - a background message held up to 5 s;
  - a reply times out after 30 s.

  A page event (a menu click, a shortcut) is held and resent like a background message.
- **Errors (spec §9):**
  - An unavailable API fails with `ext2userscript: chrome.<api> is not available in userscripts`, logged once.
  - A missing GM function fails with `ext2userscript: GM_<name> is not available (not granted, or not supported by this userscript manager)`.
- **Extension code stays in sloppy mode.** The runtime's own `"use strict"` stays inside its IIFE.
- **Real managers:** one browser at a time on `bench/.cache/profile`; leave no Chrome for Testing process running.
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, passed as a second `-m`.

## Review Focus

1. **A content script on a site whose CSP allows connections only to the site itself**, as GitHub's does. A request to a host the extension has permission for must still succeed. Pinned in Task 3 (`content-runtime.test.ts`, "reaches a permitted host from a page whose CSP allows connections only to itself").
2. **A menu click or a shortcut while the leader is changing** (its tab closed, or it was a ghost) must reach the new leader's background, not vanish. Pinned in Task 4 (`messaging.test.ts`, "sends a page's event again to the new leader when the page it went to goes away unanswered").
3. **`executeScript`'s function on a page whose CSP forbids eval, under Tampermonkey**, must still run, in the page's world. Pinned in Task 9 (`content-runtime.test.ts`, "runs executeScript's function on a page whose CSP forbids eval, in the page's world if it must", on the real managers).
4. **A binary response through `gm.xmlHttpRequest`** (an image, protobuf) must arrive byte for byte, with its content type. Pinned in Task 2 (`net.test.ts`, "passes a binary body through byte for byte").
5. **An MV2 persistent background page that creates its context menu every time it starts** must not pile up duplicate commands as the leader changes. Pinned in Task 5 (`menus.test.ts`, "keeps an event page's items from one start to the next, but not a persistent page's or ones without an id").

---

### Task 1: Permissions, shortcuts and the toolbar button from the manifest, and @connect

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-ext2userscript-design.md` (the spec corrections)
- Modify: `src/convert/manifest.ts`, `src/runtime/config.ts`, `src/convert/index.ts`, `src/convert/metadata.ts`, `src/convert/analyze.ts`
- Test: `test/unit/manifest.test.ts`, `test/unit/metadata.test.ts`, `test/unit/analyze.test.ts`

**Interfaces:**
- Produces:
  - **`manifest.ts`:**
    - `type Command = { description?; keys: Record<string, string> }`;
    - `Model` gains `action?: { key; title? }`, `permissions`, `optionalPermissions`, `hostPermissions`, `optionalHostPermissions` and `commands: Record<string, Command>`.
  - **`config.ts`:** `RuntimeConfig` gains:
    - `permissions?: { api; optionalApi; origins; optionalOrigins }`;
    - `commands?: Record<string, { description?; keys }>`;
    - `action?: { key; title?; popup: boolean }`.
  - **`metadata.ts`:** `connectHosts(patterns): string[]`. The header has `@connect` per host.
  - **`analyze.ts`:** reports `manifest.host_permissions` as supported, needing the `xmlHttpRequest` method.

- [ ] **Step 1: Write the failing tests.**

In `test/unit/manifest.test.ts`:

Replace:

```ts
  it("flattens web_accessible_resources from MV2 and MV3", () => {
```

with:

```ts
  it("splits permissions into API names and host patterns, from MV2 and MV3, required and optional", () => {
    const mv2 = read({ ...mv3, manifest_version: 2, permissions: ["storage", "https://a.test/*", "<all_urls>", { fileSystem: ["write"] }], optional_permissions: ["cookies", "*://b.test/*"] }).model;
    assert.deepEqual([mv2.permissions, mv2.hostPermissions, mv2.optionalPermissions, mv2.optionalHostPermissions], [["storage"], ["https://a.test/*", "<all_urls>"], ["cookies"], ["*://b.test/*"]]);
    const v3 = read({ ...mv3, permissions: ["alarms"], host_permissions: ["https://c.test/*"], optional_host_permissions: ["https://d.test/*"] }).model;
    assert.deepEqual([v3.permissions, v3.hostPermissions, v3.optionalPermissions, v3.optionalHostPermissions], [["alarms"], ["https://c.test/*"], [], ["https://d.test/*"]]);
  });

  it("reads keyboard shortcuts and the toolbar button, resolving __MSG_x__ in their text", () => {
    const { model } = read(
      {
        ...mv3,
        default_locale: "en",
        action: { default_title: "__MSG_title__" },
        commands: { "toggle": { suggested_key: { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" }, description: "__MSG_toggle__" }, "_execute_action": { suggested_key: "Alt+Shift+P" }, "bad": 1 },
      },
      { "_locales/en/messages.json": JSON.stringify({ title: { message: "Click me" }, toggle: { message: "Toggle it" } }) },
    );
    assert.deepEqual(model.action, { key: "action", title: "Click me" });
    assert.deepEqual(model.commands, { toggle: { description: "Toggle it", keys: { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" } }, _execute_action: { keys: { default: "Alt+Shift+P" } } });
    assert.deepEqual(read({ ...mv3, manifest_version: 2, page_action: {} }).model.action, { key: "page_action" });
    assert.equal(read(mv3).model.action, undefined);
  });

  it("flattens web_accessible_resources from MV2 and MV3", () => {
```

In `test/unit/metadata.test.ts`:

Replace:

```ts
  it("uses the smallest icon of at least 32px, else the largest, as a data URL", () => {
```

with:

```ts
  it("adds @connect for each host permission's host, required and optional, and * when any host will do", () => {
    const text = header({ host_permissions: ["https://*.a.test/*", "http://localhost:8080/*", "file:///*"], optional_host_permissions: ["*://b.test/*"] });
    assert.deepEqual(values(text, "connect"), ["a.test", "localhost", "b.test"]);
    assert.deepEqual(values(header({ host_permissions: ["https://a.test/*", "<all_urls>"] }), "connect"), ["*"]);
    assert.deepEqual(values(header({ manifest_version: 2, permissions: ["*://*/*", "tabs"] }), "connect"), ["*"]);
    assert.deepEqual(values(header({}), "connect"), []);
  });

  it("uses the smallest icon of at least 32px, else the largest, as a data URL", () => {
```

In `test/unit/analyze.test.ts`:

Replace:

```ts
  it("skips groups without a scan (no JS, or the MAIN world)", () => {
```

with:

```ts
  it("reports host permissions as supported, needing GM_xmlhttpRequest for the network shim", () => {
    const { entries, methods } = analyze(model({ content_scripts: [group], optional_host_permissions: ["https://api.test/*"] }), []);
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status, entry.contexts]), [["manifest.host_permissions", "supported", ["content"]]]);
    assert.deepEqual([...methods], ["xmlHttpRequest"]);
    assert.deepEqual([...analyze(model({ content_scripts: [group] }), []).methods], []);
  });

  it("skips groups without a scan (no JS, or the MAIN world)", () => {
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:file -- test/unit/manifest.test.ts test/unit/metadata.test.ts test/unit/analyze.test.ts`
Expected: FAIL, 4 tests:
- "splits permissions into API names and host patterns, …";
- "reads keyboard shortcuts and the toolbar button, …";
- "adds @connect for each host permission's host, …";
- "reports host permissions as supported, …".

- [ ] **Step 3: Read the new manifest fields.** In `src/convert/manifest.ts`, make these replacements, in order:

1. Replace:

```ts
export type Background = { kind: "worker"; entry: string; module: boolean } | { kind: "scripts"; files: string[] } | { kind: "page"; html: string };
```

with:

```ts
export type Background = { kind: "worker"; entry: string; module: boolean } | { kind: "scripts"; files: string[] } | { kind: "page"; html: string };

/** A keyboard shortcut: its suggested key per platform ("default", "mac", "windows", "linux", "chromeos"). */
export type Command = { description?: string; keys: Record<string, string> };
```

2. Replace:

```ts
  /** The page and the manifest key it came from: options_ui or options_page. */
  options?: { key: string; page: string };
```

with:

```ts
  /** The page and the manifest key it came from: options_ui or options_page. */
  options?: { key: string; page: string };
  /** The toolbar button: the manifest key it came from (action, browser_action or page_action) and its default title. */
  action?: { key: string; title?: string };
  /** API permissions (MV3 permissions, or the MV2 ones that aren't host patterns), required and optional. */
  permissions: string[];
  optionalPermissions: string[];
  /** Host match patterns: MV3 host_permissions, or the MV2 permissions that are patterns; required and optional. */
  hostPermissions: string[];
  optionalHostPermissions: string[];
  /** Keyboard shortcuts by command name. */
  commands: Record<string, Command>;
```

3. Replace:

```ts
const RUN_AT: readonly string[] = ["document_start", "document_end", "document_idle"];
```

with:

```ts
const RUN_AT: readonly string[] = ["document_start", "document_end", "document_idle"];
/** A host permission, as opposed to an API name such as "storage". */
const HOST_PATTERN = /^(?:<all_urls>$|[a-z*-]+:\/\/)/;
const ACTION_KEYS = ["action", "browser_action", "page_action"];
```

4. Replace:

```ts
    geckoId = undefined;
  }
```

with:

```ts
    geckoId = undefined;
  }
  // Chrome skips permission entries it doesn't know, so anything but a string is left out rather than refused.
  const listed = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  const required = listed(raw.permissions);
  const optional = listed(raw.optional_permissions);
  const actionKey = ACTION_KEYS.find((key) => isObject(raw[key]));
  const actionSection = actionKey === undefined ? undefined : (raw[actionKey] as Record<string, unknown>);
```

5. Replace:

```ts
      options: page(raw, ["options_ui"], "page") ?? (typeof raw.options_page === "string" ? { key: "options_page", page: filePath(raw.options_page, "options_page") } : undefined),
```

with:

```ts
      options: page(raw, ["options_ui"], "page") ?? (typeof raw.options_page === "string" ? { key: "options_page", page: filePath(raw.options_page, "options_page") } : undefined),
      ...(actionKey && actionSection ? { action: { key: actionKey, ...(text(actionSection.default_title) ? { title: text(actionSection.default_title) } : {}) } } : {}),
      permissions: required.filter((entry) => !HOST_PATTERN.test(entry)),
      optionalPermissions: optional.filter((entry) => !HOST_PATTERN.test(entry)),
      hostPermissions: [...required.filter((entry) => HOST_PATTERN.test(entry)), ...listed(raw.host_permissions)],
      optionalHostPermissions: [...optional.filter((entry) => HOST_PATTERN.test(entry)), ...listed(raw.optional_host_permissions)],
      commands: commands(raw.commands, text),
```

6. Replace:

```ts
function page(raw: Record<string, unknown>, keys: readonly string[], field: string)
```

with:

```ts
function commands(value: unknown, text: (value: unknown) => string): Record<string, Command> {
  const out: Record<string, Command> = {};
  if (!isObject(value)) return out;
  for (const [name, entry] of Object.entries(value)) {
    if (!isObject(entry)) continue;
    const suggested = entry.suggested_key;
    const keys = typeof suggested === "string" ? { default: suggested } : isObject(suggested) ? Object.fromEntries(Object.entries(suggested).filter((pair): pair is [string, string] => typeof pair[1] === "string")) : {};
    out[name] = { ...(text(entry.description) ? { description: text(entry.description) } : {}), keys };
  }
  return out;
}

function page(raw: Record<string, unknown>, keys: readonly string[], field: string)
```

- [ ] **Step 4: Put them in the runtime config.** In `src/runtime/config.ts`:

Replace:

```ts
  /** The background, if the extension has one: whether it is a service worker, and its entry file (for import.meta.url). */
  background?: { worker: boolean; entry: string };
};
```

with:

```ts
  /** The background, if the extension has one: whether it is a service worker, and its entry file (for import.meta.url). */
  background?: { worker: boolean; entry: string };
  /**
   * The manifest's permissions: API names and host match patterns, required and optional. chrome.permissions answers
   * from them, and the network shim sends requests for these hosts through gm.xmlHttpRequest.
   */
  permissions?: { api: string[]; optionalApi: string[]; origins: string[]; optionalOrigins: string[] };
  /** Keyboard shortcuts by command name: the suggested key per platform ("default", "mac", …) and the description. */
  commands?: Record<string, { description?: string; keys: Record<string, string> }>;
  /** The toolbar button (action, browser_action or page_action), if the manifest has one, and whether it has a popup. */
  action?: { key: string; title?: string; popup: boolean };
};
```

In `src/convert/index.ts`:

Replace:

```ts
    ...(background.background ? { background: { worker: background.background.worker, entry: background.background.entry } } : {}),
  };
```

with:

```ts
    ...(background.background ? { background: { worker: background.background.worker, entry: background.background.entry } } : {}),
    permissions: { api: model.permissions, optionalApi: model.optionalPermissions, origins: model.hostPermissions, optionalOrigins: model.optionalHostPermissions },
    commands: model.commands,
    ...(model.action ? { action: { ...model.action, popup: model.popup !== undefined } } : {}),
  };
```

- [ ] **Step 5: Write @connect and report host permissions.** In `src/convert/metadata.ts`:

1. Replace:

```ts
export function renderMetadata(
```

with:

```ts
/**
 * @connect lines for the host permissions, required and optional: the network shim sends requests for these hosts
 * through GM_xmlhttpRequest, which Tampermonkey checks against @connect. A pattern for any host becomes *.
 */
export function connectHosts(patterns: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const pattern of patterns) {
    const host = pattern === "<all_urls>" ? "*" : /^[a-z*-]+:\/\/([^/]*)/.exec(pattern)?.[1]?.replace(/:(?:\d+|\*)$/, "");
    if (host) hosts.add(host === "*" ? "*" : host.replace(/^\*\./, ""));
  }
  return hosts.has("*") ? ["*"] : [...hosts];
}

export function renderMetadata(
```

2. Replace:

```ts
  lines.push(["sandbox", "DOM"], ["inject-into", "content"]);
  for (const grant of grants) lines.push(["grant", grant]);
```

with:

```ts
  lines.push(["sandbox", "DOM"], ["inject-into", "content"]);
  for (const host of connectHosts([...model.hostPermissions, ...model.optionalHostPermissions])) lines.push(["connect", host]);
  for (const grant of grants) lines.push(["grant", grant]);
```

In `src/convert/analyze.ts`:

Replace:

```ts
  if (model.popup) add(`manifest.${model.popup.key}.default_popup`, "unsupported", "the popup isn't converted yet", "popup");
```

with:

```ts
  // The network shim reaches these hosts through gm.xmlHttpRequest, in the background and in content scripts.
  if (model.hostPermissions.length + model.optionalHostPermissions.length > 0) {
    use("manifest.host_permissions", { status: "supported", methods: ["xmlHttpRequest"] }, model.background ? "background" : "content");
  }
  if (model.popup) add(`manifest.${model.popup.key}.default_popup`, "unsupported", "the popup isn't converted yet", "popup");
```

- [ ] **Step 6: Run the tests**

Run: `npm run test:file -- test/unit/manifest.test.ts test/unit/metadata.test.ts test/unit/analyze.test.ts`
Expected: PASS.

- [ ] **Step 7: Apply the spec corrections.** In `docs/superpowers/specs/2026-10-09-ext2userscript-design.md`, make these exact replacements, in order:

1. Replace:

```markdown
Plan 3 corrections (§3.3, §5.3, §5.4) applied 2026-10-11
```

with:

```markdown
Plan 3 corrections (§3.3, §5.3, §5.4) applied 2026-10-11; Plan 3b corrections (§1, §3.3, §3.6, §4, §5.2) applied 2026-10-15
```

2. Replace:

```markdown
| Approach | Build-time bundling (esbuild) plus a separately tested runtime. No `with` wrapper, no runtime `eval` of extension code. |
```

with:

```markdown
| Approach | Build-time bundling (esbuild) plus a separately tested runtime. No `with` wrapper, and no runtime `eval` of extension code, except the function or code string that `scripting.executeScript` and `tabs.executeScript` send to a tab (§5.2). |
```

3. Replace:

```markdown
In a service worker, `window` and `document` are `undefined`, as in Chrome; in an MV2 background page, `window` is the shim and `document` is the tab's document.
```

with:

```markdown
In a service worker, `window` and `document` are `undefined`, as in Chrome; in an MV2 background page, `window` is the shim and `document` is the tab's document.
- Background and content scripts: `fetch` and `XMLHttpRequest`, the network shim (§5.2). A service worker gets `XMLHttpRequest` undefined, as in Chrome.
```

4. Replace:

```markdown
- **Collected:** every file referenced from `runtime.getURL` string literals, CSS `url()`, and HTML `src`/`href`/`srcset`, plus all of `web_accessible_resources`.
```

with:

```markdown
- **Collected:** every file referenced from `runtime.getURL` string literals, CSS `url()`, and HTML `src`/`href`/`srcset`, plus all of `web_accessible_resources`. With a background, also the manifest's icons (for notifications), the files it fetches by relative URL, and the style sheets it names (for `insertCSS`). The scripts it names are bundled like content scripts, for `scripting.executeScript({ files })`.
```

5. Replace:

```markdown
| host permissions | `@connect` per host (`*` for `<all_urls>`) |
```

with:

```markdown
| host permissions, required and optional | `@connect` per host (`*` when any host will do) |
```

6. Replace:

```markdown
| `scripting.executeScript` (`func` or `files`) / `insertCSS` / `removeCSS` | supported | Run in the target tab via the bus |
```

with:

```markdown
| `scripting.executeScript` (`func` or `files`) / `insertCSS` / `removeCSS` | partial | Run in the target tab's top frame via the bus. `files` are bundled at build time. A `func` runs through `new Function`, or, where the page's CSP forbids eval (Tampermonkey's sandbox follows it), in the page's world through `gm.addElement`, without `chrome.*`. |
```

7. Replace:

```markdown
| `tabs.executeScript` / `insertCSS` (MV2) | supported | Same path as above |
```

with:

```markdown
| `tabs.executeScript` / `insertCSS` / `removeCSS` (MV2) | partial | Same path as above; `code` that can't be evaluated runs in the page's world with a null result |
```

8. Replace:

```markdown
| `contextMenus` / `menus` | partial | Each item becomes a `gm.registerMenuCommand` entry. `onClicked` receives `{menuItemId, pageUrl}` but no selection or link context. |
```

with:

```markdown
| `contextMenus` / `menus` | partial | Each item becomes a `gm.registerMenuCommand` entry in every tab, kept in a GM value. `onClicked` receives `{menuItemId, pageUrl}` and any selected text, but no link or media context; items only for links, images, media or editable fields don't show. |
```

9. Replace:

```markdown
| `action` / `browserAction` / `pageAction` `.onClicked`, `openPopup` | supported | Menu command "Open <name>" |
```

with:

```markdown
| `action` / `browserAction` / `pageAction` `.onClicked`; `openPopup` | supported; with the popup (§6) | A button without a popup is a menu command named after its title; one with a popup gets "Open <name>" (§6) |
```

10. Replace:

```markdown
| `action.setBadgeText` / `setIcon` / `setTitle` | partial | Stored; shown in the popup modal title. No toolbar UI exists. |
```

with:

```markdown
| `action.setBadgeText` / `setIcon` / `setTitle` | partial | Stored. The title and badge show in the menu command's caption; there is no toolbar to show the icon on. |
```

11. Replace:

```markdown
| `commands.onCommand` + manifest `commands` | supported | `keydown` listener on each tab, mapping suggested keys per platform |
```

with:

```markdown
| `commands.onCommand` + manifest `commands` | partial | `keydown` listener on each page, mapping suggested keys per platform: a shortcut works only while such a page has focus |
```

12. Replace:

```markdown
| `notifications.create` / `clear` / `onClicked` | supported | `gm.notification` |
```

with:

```markdown
| `notifications.create` / `onClicked` / `onClosed`; `update` / `clear` | supported; partial | `gm.notification` on the leader's tab. A notification already shown can't be changed or taken back, and buttons don't show. |
```

13. Replace:

```markdown
Streaming bodies are a known ceiling: they are buffered.
```

with:

```markdown
Streaming bodies are a known ceiling: they are buffered. Extension URLs (`chrome-extension://<id>/…`, which a background's relative URLs resolve to) are served from the asset table. A request to a host the extension has permission for carries cookies unless it sets `credentials: "omit"`. More ceilings: uploads report no progress, a synchronous `XMLHttpRequest` can't go through `gm.xmlHttpRequest`, and `window.fetch` called explicitly from a content script isn't shimmed.
```

- [ ] **Step 8: Type-check, run everything, and commit**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; every unit test passes (294 in the prototype).

```bash
git add src/convert/manifest.ts src/runtime/config.ts src/convert/index.ts src/convert/metadata.ts src/convert/analyze.ts test/unit/manifest.test.ts test/unit/metadata.test.ts test/unit/analyze.test.ts docs/superpowers/specs/2026-10-09-ext2userscript-design.md
git commit -m "Read permissions, shortcuts and the toolbar button from the manifest, and add @connect" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The network shim

**Files:**
- Create: `src/runtime/net.ts`
- Test: `test/unit/net.test.ts`

**Interfaces:**
- Consumes: `Gm.xmlHttpRequest`, `GmXhrResponse` (Plan 1); `matchPatternToRegExp` (Plan 2).
- Produces:
  - `type NetworkDeps = { gm; assetUrl(path); extensionId; base(): string; origin; hosts; fetch; XMLHttpRequest? }`;
  - `type Network = { fetch; XMLHttpRequest }`;
  - `createNetwork(deps): Network`.

- [ ] **Step 1: Write the failing test** `test/unit/net.test.ts`

```ts
// The network shim: which requests go through gm.xmlHttpRequest, and the fetch and XMLHttpRequest they get back.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GmXhrResponse, XhrRequest } from "../../src/runtime/gm.ts";
import { createNetwork, type NetworkDeps } from "../../src/runtime/net.ts";

type Reply = Partial<GmXhrResponse> | Error;

/** A network over a fake gm.xmlHttpRequest that answers with `reply`, and a page fetch that records what it got. */
function network(reply: Reply = {}, overrides: Partial<NetworkDeps> = {}) {
  const gmCalls: XhrRequest[] = [];
  const pageCalls: string[] = [];
  const net = createNetwork({
    gm: {
      xmlHttpRequest: async (request) => {
        gmCalls.push(request);
        if (reply instanceof Error) throw reply;
        return { status: 200, statusText: "OK", finalUrl: request.url, responseHeaders: "", response: new ArrayBuffer(0), ...reply };
      },
    },
    assetUrl: (path) => `blob:https://page.test/${path}`,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    base: () => "https://page.test/app/index.html",
    origin: "https://page.test",
    hosts: ["https://api.test/v1/*", "*://*.cdn.test/*", "not a pattern"],
    fetch: async (input) => {
      pageCalls.push(String(input instanceof Request ? input.url : input));
      return new Response("from the page");
    },
    ...overrides,
  });
  return { net, gmCalls, pageCalls };
}

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe("fetch", () => {
  it("sends a cross-origin request for a permitted host through gm.xmlHttpRequest, and answers with a Response", async () => {
    const { net, gmCalls } = network({ status: 201, statusText: "Created", finalUrl: "https://api.test/v2/done", responseHeaders: "Content-Type: application/json\r\nX-Id: 7\r\n", response: bytes('{"ok":true}') });
    const response = await net.fetch("https://api.test/v1/items", { method: "POST", headers: { "X-Key": "k" }, body: JSON.stringify({ a: 1 }) });
    assert.deepEqual([response.status, response.statusText, response.headers.get("x-id"), response.url, response.redirected], [201, "Created", "7", "https://api.test/v2/done", true]);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(gmCalls.length, 1);
    const call = gmCalls[0];
    assert.deepEqual([call.method, call.url, call.data, call.responseType, call.anonymous], ["POST", "https://api.test/v1/items", '{"a":1}', "arraybuffer", false]);
    assert.deepEqual(call.headers, { "content-type": "text/plain;charset=UTF-8", "x-key": "k" });
  });

  it("passes a binary body through byte for byte", async () => {
    const image = Uint8Array.from({ length: 256 }, (_value, i) => i);
    const { net } = network({ responseHeaders: "content-type: image/png\r\n", response: image.buffer });
    const response = await net.fetch("https://api.test/v1/image.png");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
    assert.equal((await (await net.fetch("https://api.test/v1/image.png")).blob()).type, "image/png");
  });

  it("ignores a host permission's path, matches subdomains, and leaves cookies out only when told to", async () => {
    const { net, gmCalls } = network();
    await net.fetch("https://api.test/other/path");
    await net.fetch(new Request("https://img.cdn.test/a.png", { credentials: "omit" }));
    assert.deepEqual(gmCalls.map((call) => [call.url, call.anonymous]), [["https://api.test/other/path", false], ["https://img.cdn.test/a.png", true]]);
  });

  it("leaves same-origin and unpermitted requests to the page, and serves extension URLs from the asset table", async () => {
    const { net, gmCalls, pageCalls } = network();
    await net.fetch("/same/origin");
    await net.fetch("https://elsewhere.test/x");
    const asset = await net.fetch("chrome-extension://abcdefghijklmnopabcdefghijklmnop/data/info%20file.json");
    assert.equal(asset.url, "chrome-extension://abcdefghijklmnopabcdefghijklmnop/data/info%20file.json");
    assert.deepEqual(pageCalls, ["https://page.test/same/origin", "https://elsewhere.test/x", "blob:https://page.test/data/info file.json"]);
    assert.equal(gmCalls.length, 0);
  });

  it("resolves a background's relative URLs against its own file, so they reach the extension's files", async () => {
    const { net, pageCalls } = network({}, { base: () => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/bg/sw.js" });
    await net.fetch("config.json");
    await net.fetch(new URL("../icon.png", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/bg/sw.js"));
    assert.deepEqual(pageCalls, ["blob:https://page.test/bg/config.json", "blob:https://page.test/icon.png"]);
  });

  it("gives a body-less status no body, and fails like fetch: TypeError for a network error, AbortError when aborted", async () => {
    assert.equal((await network({ status: 204 }).net.fetch("https://api.test/v1/x")).body, null);
    await assert.rejects(network(new TypeError("ext2userscript: request failed")).net.fetch("https://api.test/v1/x"), TypeError);
    await assert.rejects(network({ status: 0 }).net.fetch("https://api.test/v1/x"), /Failed to fetch/);
    const controller = new AbortController();
    const { net, gmCalls } = network();
    const pending = net.fetch("https://api.test/v1/x", { signal: controller.signal });
    controller.abort();
    await pending.catch(() => {});
    assert.equal((gmCalls[0].signal as AbortSignal).aborted, true);
  });

  it("sends a form as its text with its content type, and binary as a Blob", async () => {
    const { net, gmCalls } = network();
    await net.fetch("https://api.test/v1/form", { method: "POST", body: new URLSearchParams({ q: "a b" }) });
    await net.fetch("https://api.test/v1/bin", { method: "PUT", body: new Uint8Array([1, 2, 3]) });
    assert.deepEqual([gmCalls[0].data, gmCalls[0].headers?.["content-type"]], ["q=a+b", "application/x-www-form-urlencoded;charset=UTF-8"]);
    assert.ok(gmCalls[1].data instanceof Blob);
    assert.equal((gmCalls[1].data as Blob).size, 3);
  });
});

describe("XMLHttpRequest", () => {
  it("plays a permitted cross-origin request out through gm.xmlHttpRequest, with the events in XHR order", async () => {
    const { net, gmCalls } = network({ status: 200, responseHeaders: "content-type: application/json\r\n", response: bytes('{"n":1}') });
    const xhr = new net.XMLHttpRequest();
    const seen: string[] = [];
    xhr.onreadystatechange = () => seen.push(`state ${xhr.readyState}`);
    for (const type of ["loadstart", "progress", "load", "loadend"]) xhr.addEventListener(type, () => seen.push(type));
    xhr.open("post", "https://api.test/v1/x");
    xhr.setRequestHeader("X-A", "1");
    xhr.setRequestHeader("x-a", "2");
    xhr.responseType = "json";
    const done = new Promise((resolve) => (xhr.onload = resolve));
    xhr.send("payload");
    await done;
    assert.deepEqual([xhr.status, xhr.response, xhr.getResponseHeader("Content-Type"), xhr.getAllResponseHeaders()], [200, { n: 1 }, "application/json", "content-type: application/json\r\n"]);
    assert.deepEqual(seen, ["state 1", "loadstart", "state 2", "state 3", "progress", "state 4", "load", "loadend"]);
    assert.deepEqual([gmCalls[0].method, gmCalls[0].data, gmCalls[0].headers], ["POST", "payload", { "X-A": "1, 2" }]);
  });

  it("reports a failed request with readyState 4, status 0 and error, and an aborted one with abort", async () => {
    const failed = new (network(new TypeError("down")).net.XMLHttpRequest)();
    const events: string[] = [];
    failed.addEventListener("error", () => events.push("error"));
    const ended = new Promise((resolve) => failed.addEventListener("loadend", resolve));
    failed.open("GET", "https://api.test/v1/x");
    failed.send();
    await ended;
    assert.deepEqual([events, failed.readyState, failed.status], [["error"], 4, 0]);

    const { net, gmCalls } = network();
    const aborted = new net.XMLHttpRequest();
    const order: string[] = [];
    for (const type of ["abort", "loadend", "load"]) aborted.addEventListener(type, () => order.push(type));
    aborted.open("GET", "https://api.test/v1/x");
    aborted.send();
    aborted.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual([order, aborted.readyState, (gmCalls[0].signal as AbortSignal).aborted], [["abort", "loadend"], 0, true]);
  });

  it("hands any other request to the page's own XMLHttpRequest, with extension URLs pointing at the asset table", () => {
    const opened: unknown[][] = [];
    class PageXhr extends EventTarget {
      upload = new EventTarget();
      readyState = 4;
      status = 200;
      responseText = "native";
      responseType = "";
      timeout = 0;
      withCredentials = false;
      open(...args: unknown[]) {
        opened.push(args);
      }
      send() {}
    }
    const { net } = network({}, { XMLHttpRequest: PageXhr as unknown as typeof XMLHttpRequest });
    const xhr = new net.XMLHttpRequest();
    xhr.open("GET", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/data.json", false);
    xhr.send();
    assert.deepEqual([opened[0].slice(0, 3), xhr.status, xhr.responseText], [["GET", "blob:https://page.test/data.json", false], 200, "native"]);
    assert.throws(() => xhr.open("GET", "https://api.test/v1/x", false), /synchronous request can't go through GM_xmlhttpRequest/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/net.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write `src/runtime/net.ts`**

```ts
// The network shim (spec §5.2, "Network"): fetch and XMLHttpRequest for the background and content scripts.
// - A request from this page to another origin that the manifest's host permissions cover goes through
//   gm.xmlHttpRequest, so CORS doesn't stop it, as it doesn't stop an extension's.
// - An extension URL (chrome-extension://<id>/path, which a background's relative URLs resolve to) is served from the
//   asset table.
// - Anything else goes to the page's own fetch and XMLHttpRequest.
// Ceilings: a body through gm.xmlHttpRequest is buffered (no streaming, no progress until it has all arrived), its
// upload sends no progress events, and it can't be synchronous.
import type { Gm, GmXhrResponse } from "./gm.ts";
import { matchPatternToRegExp } from "./match.ts";

export type NetworkDeps = {
  gm: Pick<Gm, "xmlHttpRequest">;
  /** The asset table's blob: URL for an extension path. */
  assetUrl(path: string): string;
  extensionId: string;
  /** What relative URLs resolve against: the page's URL for content scripts, chrome-extension://<id>/<entry> for the background. */
  base(): string;
  /** This page's origin: a request to it isn't cross-origin, so it stays native. */
  origin: string;
  /** Host match patterns, required and optional. Chrome ignores their paths, and so does this. */
  hosts: readonly string[];
  /** The page's own fetch and XMLHttpRequest. */
  fetch: typeof globalThis.fetch;
  XMLHttpRequest?: typeof globalThis.XMLHttpRequest;
};

export type Network = { fetch: typeof globalThis.fetch; XMLHttpRequest: typeof globalThis.XMLHttpRequest };

type Target = { gm: boolean; url: string; original: string };

/** Statuses whose responses have no body; the Response constructor refuses one. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const XHR_EVENTS = ["readystatechange", "loadstart", "progress", "load", "error", "abort", "timeout", "loadend"] as const;

export function createNetwork(deps: NetworkDeps): Network {
  const hosts = deps.hosts.flatMap((pattern) => {
    try {
      return [matchPatternToRegExp(pattern === "<all_urls>" ? pattern : pattern.replace(/^([^:]+:\/\/[^/]*)(?:\/.*)?$/, "$1/*"))];
    } catch {
      return [];
    }
  });

  const route = (url: string): Target => {
    const target = new URL(url, deps.base());
    if (target.protocol === "chrome-extension:" && target.hostname === deps.extensionId) {
      return { gm: false, url: deps.assetUrl(decodeURI(target.pathname.slice(1))), original: target.href };
    }
    const http = target.protocol === "http:" || target.protocol === "https:";
    const gm = http && target.origin !== deps.origin && hosts.some((host) => host.test(target.href));
    return { gm, url: target.href, original: target.href };
  };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const target = route(isRequest ? input.url : String(input));
    if (!target.gm) {
      const response = await deps.fetch(isRequest && target.url === input.url ? input : target.url, init);
      return target.url === target.original ? response : withUrl(response, target.original);
    }
    // A Request built the way fetch builds one: its method, its headers (with the body's Content-Type), its signal.
    const request = isRequest ? new Request(input, init) : new Request(target.url, init);
    const body = init?.body ?? undefined;
    const data =
      request.method === "GET" || request.method === "HEAD" ? undefined
      : typeof body === "string" ? body
      : body instanceof URLSearchParams ? body.toString()
      : typeof FormData !== "undefined" && body instanceof FormData ? body
      : await request.blob();
    const reply = await deps.gm.xmlHttpRequest({
      method: request.method,
      url: target.url,
      headers: Object.fromEntries(request.headers),
      ...(data === undefined || (data instanceof Blob && data.size === 0) ? {} : { data }),
      responseType: "arraybuffer",
      // An extension's request to a host it has permission for carries cookies unless told not to.
      anonymous: request.credentials === "omit",
      signal: request.signal,
    });
    return toResponse(reply, target.url);
  };

  return { fetch: fetch as typeof globalThis.fetch, XMLHttpRequest: xhrClass(deps, route) };
}

function toResponse(reply: GmXhrResponse, url: string): Response {
  if (reply.status < 200 || reply.status > 599) throw new TypeError("Failed to fetch");
  const body = NULL_BODY.has(reply.status) ? null : (reply.response as ArrayBuffer | null);
  return withUrl(new Response(body, { status: reply.status, statusText: reply.statusText, headers: parseHeaders(reply.responseHeaders) }), reply.finalUrl || url, url);
}

/** Response.url can't be set through the constructor, so it is defined on the instance. */
function withUrl(response: Response, url: string, requested = url): Response {
  return Object.defineProperties(response, { url: { value: url }, redirected: { value: url !== requested } });
}

function parseHeaders(text: string): Headers {
  const headers = new Headers();
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    try {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    } catch {
      // A header the Headers class refuses is left out.
    }
  }
  return headers;
}

/**
 * XMLHttpRequest. open() decides the route: a request for the page's own XMLHttpRequest goes to a real one, whose state
 * and events this object mirrors; a request through gm.xmlHttpRequest is played out here, with the same events in the
 * same order once the whole response has arrived.
 */
function xhrClass(deps: NetworkDeps, route: (url: string) => Target): typeof globalThis.XMLHttpRequest {
  type State = { readyState: number; status: number; statusText: string; responseURL: string; headers: string; body?: ArrayBuffer; type: string };
  const fresh = (): State => ({ readyState: 0, status: 0, statusText: "", responseURL: "", headers: "", type: "" });

  class ShimXMLHttpRequest extends EventTarget {
    static readonly UNSENT = 0;
    static readonly OPENED = 1;
    static readonly HEADERS_RECEIVED = 2;
    static readonly LOADING = 3;
    static readonly DONE = 4;
    readonly UNSENT = 0;
    readonly OPENED = 1;
    readonly HEADERS_RECEIVED = 2;
    readonly LOADING = 3;
    readonly DONE = 4;
    readonly upload = new EventTarget();
    onreadystatechange: ((event: Event) => void) | null = null;
    onloadstart: ((event: Event) => void) | null = null;
    onprogress: ((event: Event) => void) | null = null;
    onload: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onabort: ((event: Event) => void) | null = null;
    ontimeout: ((event: Event) => void) | null = null;
    onloadend: ((event: Event) => void) | null = null;
    #real?: XMLHttpRequest;
    #state = fresh();
    #method = "GET";
    #url = "";
    #headers: Record<string, string> = {};
    #controller?: AbortController;
    #responseType: XMLHttpRequestResponseType = "";
    #timeout = 0;
    #withCredentials = false;

    get readyState() { return this.#real ? this.#real.readyState : this.#state.readyState; }
    get status() { return this.#real ? this.#real.status : this.#state.status; }
    get statusText() { return this.#real ? this.#real.statusText : this.#state.statusText; }
    get responseURL() { return this.#real ? this.#real.responseURL : this.#state.responseURL; }
    get responseType() { return this.#responseType; }
    set responseType(value: XMLHttpRequestResponseType) {
      this.#responseType = value;
      if (this.#real) this.#real.responseType = value;
    }
    get timeout() { return this.#timeout; }
    set timeout(value: number) {
      this.#timeout = value;
      if (this.#real) this.#real.timeout = value;
    }
    get withCredentials() { return this.#withCredentials; }
    set withCredentials(value: boolean) {
      this.#withCredentials = value;
      if (this.#real) this.#real.withCredentials = value;
    }
    get response(): unknown {
      if (this.#real) return this.#real.response;
      const { body, readyState, type } = this.#state;
      if (readyState !== 4 || !body) return this.#responseType === "" || this.#responseType === "text" ? "" : null;
      switch (this.#responseType) {
        case "arraybuffer": return body;
        case "blob": return new Blob([body], { type });
        case "json":
          try {
            return JSON.parse(this.responseText);
          } catch {
            return null;
          }
        case "document": return new DOMParser().parseFromString(this.responseText, /xml/.test(type) ? "application/xml" : "text/html");
        default: return this.responseText;
      }
    }
    get responseText(): string {
      if (this.#real) return this.#real.responseText;
      return this.#state.body ? new TextDecoder().decode(this.#state.body) : "";
    }
    get responseXML(): Document | null {
      if (this.#real) return this.#real.responseXML;
      return this.#state.readyState === 4 && /xml|html/.test(this.#state.type) ? new DOMParser().parseFromString(this.responseText, /html/.test(this.#state.type) ? "text/html" : "application/xml") : null;
    }

    open(method: string, url: string | URL, async = true, user?: string | null, password?: string | null) {
      const target = route(String(url));
      this.#real = undefined;
      this.#state = fresh();
      this.#method = method.toUpperCase();
      this.#url = target.url;
      this.#headers = {};
      if (!target.gm) {
        if (!deps.XMLHttpRequest) throw new Error("ext2userscript: XMLHttpRequest isn't available here");
        const real = new deps.XMLHttpRequest();
        this.#real = real;
        for (const type of XHR_EVENTS) real.addEventListener(type, (event) => this.#fire(type, event as ProgressEvent));
        for (const type of XHR_EVENTS) real.upload.addEventListener(type, (event) => this.upload.dispatchEvent(progress(type, event as ProgressEvent)));
        real.open(method, target.url, async, user, password);
        real.responseType = this.#responseType;
        if (async) real.timeout = this.#timeout;
        real.withCredentials = this.#withCredentials;
        return;
      }
      if (!async) throw new DOMException("ext2userscript: a synchronous request can't go through GM_xmlhttpRequest", "InvalidAccessError");
      this.#state.readyState = 1;
      this.#fire("readystatechange");
    }

    setRequestHeader(name: string, value: string) {
      if (this.#real) return this.#real.setRequestHeader(name, value);
      if (this.#state.readyState !== 1) throw new DOMException("The object's state must be OPENED.", "InvalidStateError");
      const key = Object.keys(this.#headers).find((existing) => existing.toLowerCase() === name.toLowerCase()) ?? name;
      this.#headers[key] = key in this.#headers ? `${this.#headers[key]}, ${value}` : String(value);
    }

    getResponseHeader(name: string): string | null {
      if (this.#real) return this.#real.getResponseHeader(name);
      return this.#state.readyState < 2 ? null : parseHeaders(this.#state.headers).get(name);
    }

    getAllResponseHeaders(): string {
      if (this.#real) return this.#real.getAllResponseHeaders();
      if (this.#state.readyState < 2) return "";
      return [...parseHeaders(this.#state.headers)].map(([name, value]) => `${name}: ${value}\r\n`).join("");
    }

    overrideMimeType(mime: string) {
      this.#real?.overrideMimeType(mime);
    }

    send(body?: Document | XMLHttpRequestBodyInit | null) {
      if (this.#real) return this.#real.send(body);
      if (this.#state.readyState !== 1 || this.#controller) throw new DOMException("The object's state must be OPENED.", "InvalidStateError");
      const controller = new AbortController();
      this.#controller = controller;
      const method = this.#method;
      const data =
        method === "GET" || method === "HEAD" || body === null || body === undefined ? undefined
        : typeof Document !== "undefined" && body instanceof Document ? new XMLSerializer().serializeToString(body)
        : body;
      this.#fire("loadstart");
      deps.gm
        .xmlHttpRequest({
          method,
          url: this.#url,
          headers: this.#headers,
          ...(data === undefined ? {} : { data: typeof data === "string" || data instanceof Blob || data instanceof URLSearchParams || data instanceof FormData ? data : new Blob([data as BlobPart]) }),
          responseType: "arraybuffer",
          ...(this.#timeout > 0 ? { timeout: this.#timeout } : {}),
          signal: controller.signal,
        })
        .then(
          (reply) => {
            if (controller.signal.aborted) return;
            const headers = parseHeaders(reply.responseHeaders);
            this.#state = { ...this.#state, readyState: 2, status: reply.status, statusText: reply.statusText, responseURL: reply.finalUrl || this.#url, headers: reply.responseHeaders, type: headers.get("content-type") ?? "" };
            this.#fire("readystatechange");
            const size = (reply.response as ArrayBuffer | null)?.byteLength ?? 0;
            this.#state.readyState = 3;
            this.#fire("readystatechange");
            this.#fire("progress", { loaded: size, total: size, lengthComputable: true });
            this.#state.body = (reply.response as ArrayBuffer | null) ?? undefined;
            this.#state.readyState = 4;
            this.#controller = undefined;
            this.#fire("readystatechange");
            this.#fire("load", { loaded: size, total: size, lengthComputable: true });
            this.#fire("loadend", { loaded: size, total: size, lengthComputable: true });
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            this.#controller = undefined;
            this.#state = { ...fresh(), readyState: 4 };
            this.#fire("readystatechange");
            this.#fire(error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "error");
            this.#fire("loadend");
          },
        );
    }

    abort() {
      if (this.#real) return this.#real.abort();
      const controller = this.#controller;
      if (!controller) return;
      this.#controller = undefined;
      controller.abort();
      this.#state = { ...fresh(), readyState: 4 };
      this.#fire("readystatechange");
      this.#fire("abort");
      this.#fire("loadend");
      this.#state.readyState = 0;
    }

    /** Fires an event: the on<type> property first, then the listeners, as for a handler set before them. */
    #fire(type: (typeof XHR_EVENTS)[number], from?: { loaded: number; total: number; lengthComputable: boolean }) {
      const event = progress(type, from);
      this[`on${type}`]?.call(this, event);
      this.dispatchEvent(event);
    }
  }
  return ShimXMLHttpRequest as unknown as typeof globalThis.XMLHttpRequest;
}

/** A ProgressEvent where there is one (pages), or an Event carrying the same fields. */
function progress(type: string, from?: { loaded: number; total: number; lengthComputable: boolean }): Event {
  const init = { loaded: from?.loaded ?? 0, total: from?.total ?? 0, lengthComputable: from?.lengthComputable ?? false };
  return typeof ProgressEvent === "function" ? new ProgressEvent(type, init) : Object.assign(new Event(type), init);
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test:file -- test/unit/net.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Type-check and commit**

Run: `npm run typecheck` (expected: exit 0), then:

```bash
git add src/runtime/net.ts test/unit/net.test.ts
git commit -m "Add a fetch and XMLHttpRequest shim that reaches permitted hosts through GM_xmlhttpRequest" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Give the background and content scripts the network shim

**Files:**
- Modify:
  - `src/runtime/config.ts` (the factory types);
  - `src/convert/emit.ts` (the wrapper parameters);
  - `src/runtime/content.ts`, `src/runtime/index.ts`, `src/runtime/background.ts`.
- Modify: `src/convert/scan.ts` (`fetch("…")` literals) and `src/convert/index.ts` (a background's relative fetches become assets).
- Modify:
  - `test/unit/convert.test.ts` and `test/unit/emit-background.test.ts` (the new parameters);
  - `test/support/extension.ts` (adds `networkExtension`);
  - `test/browser/content-runtime.test.ts` (adds the network suite).
- Test: `test/browser/content-runtime.test.ts`

**Interfaces:**
- Consumes: `createNetwork` (Task 2); `RuntimeConfig.permissions` (Task 1).
- Produces:
  - **The wrapper factories:**
    - `GroupCode` is `(chrome, browser, fetch, XMLHttpRequest) => () => void`.
    - `BackgroundCode` takes `fetch` and `XMLHttpRequest` after `localStorage`, before `__x2uImportMeta`.
  - **`ScanResult.fetches: string[]`**: string literals passed to `fetch(...)`.
  - **`runContent`'s deps** gain `network: Network`.
  - **`test/support/extension.ts`:** `networkExtension(origin)`.

- [ ] **Step 1: Write the failing tests.**

In `test/unit/convert.test.ts`:

Replace:

```ts
    assert.match(userscript, /function \(chrome, browser\) \{\nreturn function \(\) \{\nif \(!globalThis\.chrome/);
```

with:

```ts
    assert.match(userscript, /function \(chrome, browser, fetch, XMLHttpRequest\) \{\nreturn function \(\) \{\nif \(!globalThis\.chrome/);
```

In `test/unit/emit-background.test.ts`:

1. Replace:

```ts
    factory?.({}, {}, { tag: "shim" }, backgroundGlobal, undefined, undefined, () => {}, {}, { url: "u" })();
```

with:

```ts
    factory?.({}, {}, { tag: "shim" }, backgroundGlobal, undefined, undefined, () => {}, {}, () => {}, undefined, { url: "u" })();
```

2. Replace:

```ts
    assert.match(userscript, /function \(chrome, browser, self, globalThis, window, document, importScripts, localStorage, __x2uImportMeta\) \{\nreturn function \(\) \{\nimportScripts|\/\* importScripts\("lib\/helper\.js"\) \*\//);
```

with:

```ts
    assert.match(userscript, /function \(chrome, browser, self, globalThis, window, document, importScripts, localStorage, fetch, XMLHttpRequest, __x2uImportMeta\) \{\nreturn function \(\) \{\nimportScripts|\/\* importScripts\("lib\/helper\.js"\) \*\//);
```

In `test/support/extension.ts`:

1. Replace:

```ts
// - moduleBackgroundExtension has an ES-module service worker.
```

with:

```ts
// - moduleBackgroundExtension has an ES-module service worker.
// - networkExtension fetches from another origin, which sends no CORS headers, in the background and content scripts.
```

2. Replace:

```ts
/** Content scripts that use nothing unsupported or partial, so the report's verdict is likely-works. */
```

with:

```ts
/**
 * origin is where the test pages are served (http://127.0.0.1:<port>); the same server as http://localhost:<port> is
 * another origin, which the host permissions cover and whose /api.json sends no CORS headers.
 */
export function networkExtension(origin: string): ExtensionFiles {
  const other = origin.replace("127.0.0.1", "localhost");
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Network Sample",
      version: "1.0.0",
      background: { service_worker: "sw.js" },
      host_permissions: [`${other}/*`],
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"] }],
    }),
    "sw.js": `chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  Promise.all([fetch("${other}/api.json").then((r) => r.json()), fetch("data/config.json").then((r) => r.json())]).then(
    ([api, config]) => sendResponse(api.from + "|" + config.kind + "|" + typeof XMLHttpRequest),
    (error) => sendResponse("failed: " + error.message),
  );
  return true;
});`,
    "data/config.json": '{"kind":"config"}',
    "content.js": `const html = document.documentElement;
chrome.runtime.sendMessage("net").then((reply) => { html.dataset.background = reply; });
fetch("${other}/api.json").then((r) => r.json()).then((body) => { html.dataset.fetch = body.from; }, (error) => { html.dataset.fetch = "failed: " + error.message; });
const xhr = new XMLHttpRequest();
xhr.open("GET", "${other}/api.json");
xhr.responseType = "json";
xhr.onload = () => { html.dataset.xhr = xhr.response.from + ":" + xhr.status; };
xhr.onerror = () => { html.dataset.xhr = "failed"; };
xhr.send();
fetch("/same.json").then((r) => r.json()).then((body) => { html.dataset.same = body.from; });
`,
  });
}

/** Content scripts that use nothing unsupported or partial, so the report's verdict is likely-works. */
```

In `test/browser/content-runtime.test.ts`:

1. Replace:

```ts
import { backgroundExtension, moduleBackgroundExtension, sampleExtension } from "../support/extension.ts";
```

with:

```ts
import { backgroundExtension, moduleBackgroundExtension, networkExtension, sampleExtension } from "../support/extension.ts";
```

2. Replace:

```ts
      "/child.html": html("child"),
    });
```

with:

```ts
      "/child.html": html("child"),
      "/api.json": () => Response.json({ from: "api" }),
      "/same.json": () => Response.json({ from: "same" }),
    });
```

3. Replace:

```ts
const page = html('<div class="x2u-box">box</div>', "<script>window.pageValue = 42;</script>");
```

with:

```ts
const page = html('<div class="x2u-box">box</div>', "<script>window.pageValue = 42;</script>");
/** A page whose CSP lets it connect only to its own origin, as GitHub's does to its own hosts. */
const connectStrictPage = async () => {
  const response = page();
  response.headers.set("content-security-policy", "connect-src 'self'");
  return response;
};
```

4. Replace:

```ts
      "/api.json": () => Response.json({ from: "api" }),
```

with:

```ts
      "/connect-strict.html": connectStrictPage,
      "/api.json": () => Response.json({ from: "api" }),
```

5. Replace:

```ts
      await waitForAttr(await open("/page.html"), "data-module", "module:/bg/icon.png");
    });
  });
}
```

with:

```ts
      await waitForAttr(await open("/page.html"), "data-module", "module:/bg/icon.png");
    });
  });

  describe(`network on ${backend}`, () => {
    const { open } = harness(backend, networkExtension);

    it("fetches from another origin the host permissions cover, in the background and content scripts, and its own files", async () => {
      const tab = await open("/page.html");
      // A service worker has no XMLHttpRequest, as in Chrome.
      await waitForAttr(tab, "data-background", "api|config|undefined");
      await waitForAttr(tab, "data-fetch", "api");
      await waitForAttr(tab, "data-xhr", "api:200");
      await waitForAttr(tab, "data-same", "same");
    });

    it("reaches a permitted host from a page whose CSP allows connections only to itself", async () => {
      const tab = await open("/connect-strict.html");
      await waitForAttr(tab, "data-fetch", "api");
      await waitForAttr(tab, "data-xhr", "api:200");
      await waitForAttr(tab, "data-same", "same");
    });
  });
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:file -- test/unit/convert.test.ts test/unit/emit-background.test.ts`
Expected: FAIL in "writes the header, the runtime and the content groups" and in "passes the background as a factory whose parameters shadow the background's globals".

Run: `npm run test:file -- --test-name-pattern=network test/browser/content-runtime.test.ts`
Expected: FAIL. Without the shim, the cross-origin requests fail.

- [ ] **Step 3: Give the factories the new parameters.** In `src/runtime/config.ts`:

1. Replace:

```ts
  importScripts: unknown,
  localStorage: unknown,
  __x2uImportMeta: { url: string },
) => () => void;
```

with:

```ts
  importScripts: unknown,
  localStorage: unknown,
  fetch: unknown,
  XMLHttpRequest: unknown,
  __x2uImportMeta: { url: string },
) => () => void;
```

2. Replace:

```ts
/**
 * One entry per content group, in manifest order: isolated-world code as a factory that takes the chrome and browser
 * objects and returns the code to run, MAIN-world code as source text, or null for a group without JS.
 */
export type GroupCode = ((chrome: unknown, browser: unknown) => () => void) | string | null;
```

with:

```ts
/**
 * One entry per content group, in manifest order: isolated-world code as a factory that takes the chrome and browser
 * objects and the network shim's fetch and XMLHttpRequest and returns the code to run, MAIN-world code as source text,
 * or null for a group without JS.
 */
export type GroupCode = ((chrome: unknown, browser: unknown, fetch: unknown, XMLHttpRequest: unknown) => () => void) | string | null;
```

In `src/convert/emit.ts`:

1. Replace:

```ts
// - Isolated-world code becomes a factory: function (chrome, browser) { return function () { <code> }; }. The outer
//   parameters give the code its chrome and browser, and the inner function is a scope of its own, so the code may
//   still declare `const browser = …` itself.
```

with:

```ts
// - Isolated-world code becomes a factory: function (chrome, browser, fetch, XMLHttpRequest) { return function () { <code> }; }.
//   The outer parameters give the code its chrome and browser and the network shim (spec §5.2), and the inner function
//   is a scope of its own, so the code may still declare `const browser = …` itself.
```

2. Replace:

```ts
    return `function (chrome, browser) {\nreturn function () {\n${group.code}\n};\n}`;
```

with:

```ts
    return `function (chrome, browser, fetch, XMLHttpRequest) {\nreturn function () {\n${group.code}\n};\n}`;
```

3. Replace:

```ts
    ? `function (chrome, browser, self, globalThis, window, document, importScripts, localStorage, __x2uImportMeta) {\nreturn function () {\n${background.code}\n};\n}`
```

with:

```ts
    ? `function (chrome, browser, self, globalThis, window, document, importScripts, localStorage, fetch, XMLHttpRequest, __x2uImportMeta) {\nreturn function () {\n${background.code}\n};\n}`
```

- [ ] **Step 4: Pass the shim in.** In `src/runtime/content.ts`:

1. Replace:

```ts
type Deps = { gm: Gm; chrome: object; assets: Assets; log: Logger };
```

with:

```ts
type Deps = { gm: Gm; chrome: object; assets: Assets; log: Logger; network: Network };
```

2. Replace:

```ts
import { filterMatches } from "./match.ts";
```

with:

```ts
import { filterMatches } from "./match.ts";
import type { Network } from "./net.ts";
```

3. Replace:

```ts
        else withGlobals(deps.chrome, c(deps.chrome, deps.chrome));
```

with:

```ts
        else withGlobals(deps.chrome, c(deps.chrome, deps.chrome, deps.network.fetch, deps.network.XMLHttpRequest));
```

In `src/runtime/index.ts`:

1. Replace:

```ts
    runContent(config, code, { gm, chrome: { runtime, storage, i18n, extension, dom }, assets, log });
```

with:

```ts
    const network = createNetwork({
      gm,
      assetUrl: getURL,
      extensionId: config.id,
      base: () => location.href,
      origin: location.origin,
      hosts: [...(config.permissions?.origins ?? []), ...(config.permissions?.optionalOrigins ?? [])],
      fetch: globalThis.fetch.bind(globalThis),
      XMLHttpRequest: globalThis.XMLHttpRequest,
    });
    runContent(config, code, { gm, chrome: { runtime, storage, i18n, extension, dom }, assets, log, network });
```

2. Replace:

```ts
import { createMessaging } from "./messaging.ts";
```

with:

```ts
import { createMessaging } from "./messaging.ts";
import { createNetwork } from "./net.ts";
```

In `src/runtime/background.ts`:

1. Replace:

```ts
import { REGISTRY_TIMING } from "./registry.ts";
```

with:

```ts
import { createNetwork } from "./net.ts";
import { REGISTRY_TIMING } from "./registry.ts";
```

2. Replace:

```ts
  const { global, fire } = createBackgroundGlobal({ chrome, browser: chrome, importScripts, localStorage });
```

with:

```ts
  const self = `chrome-extension://${config.id}/${background.entry}`;
  // A service worker has fetch but no XMLHttpRequest, as in Chrome; a background page has both.
  const network = createNetwork({
    gm,
    assetUrl: getURL,
    extensionId: config.id,
    base: () => self,
    origin: location.origin,
    hosts: [...(config.permissions?.origins ?? []), ...(config.permissions?.optionalOrigins ?? [])],
    fetch: globalThis.fetch.bind(globalThis),
    XMLHttpRequest: globalThis.XMLHttpRequest,
  });
  const XMLHttpRequest = background.worker ? undefined : network.XMLHttpRequest;
  const { global, fire } = createBackgroundGlobal({ chrome, browser: chrome, importScripts, localStorage, fetch: network.fetch, XMLHttpRequest });
```

3. Replace:

```ts
      importScripts,
      localStorage,
      { url: `chrome-extension://${config.id}/${background.entry}` },
    )();
```

with:

```ts
      importScripts,
      localStorage,
      network.fetch,
      XMLHttpRequest,
      { url: self },
    )();
```

- [ ] **Step 5: Put the files a background fetches in the asset table.** In `src/convert/scan.ts`:

1. Replace:

```ts
// dynamic import(), where it calls importScripts(...), and its top-level let, const and class declarations.
```

with:

```ts
// dynamic import(), where it calls importScripts(...), the string literals it passes to fetch(...), and its top-level
// let, const and class declarations.
```

2. Replace:

```ts
  /** String literals passed to runtime.getURL or extension.getURL, as written. */
  urls: string[];
```

with:

```ts
  /** String literals passed to runtime.getURL or extension.getURL, as written. */
  urls: string[];
  /** String literals passed to fetch(...) (or self.fetch and the like), as written: a background's relative URLs are extension files. */
  fetches: string[];
```

3. Replace:

```ts
  const result: ScanResult = { chains: [], urls: [], dynamicImport: false, importScripts: [], lexical: [] };
```

with:

```ts
  const result: ScanResult = { chains: [], urls: [], fetches: [], dynamicImport: false, importScripts: [], lexical: [] };
```

4. Replace:

```ts
    if (token.value === "importScripts" && tokens[i + 1]?.value === "(") {
```

with:

```ts
    if (token.value === "fetch" && tokens[i + 1]?.value === "(" && tokens[i + 2]?.kind === "string" && (tokens[i + 3]?.value === ")" || tokens[i + 3]?.value === ",")) {
      const owner = isDot(tokens[i - 1]) ? tokens[i - 2] : undefined;
      if (!owner || (owner.kind === "name" && GLOBAL_OWNERS.has(owner.value))) result.fetches.push(tokens[i + 2].value);
    }
    if (token.value === "importScripts" && tokens[i + 1]?.value === "(") {
```

In `src/convert/index.ts`:

1. Replace:

```ts
import { readManifest } from "./manifest.ts";
```

with:

```ts
import { readManifest } from "./manifest.ts";
import { dirname, joinPath } from "./paths.ts";
```

2. Replace:

```ts
  const getUrls = [...scans.flatMap((result) => result?.urls ?? []), ...(backgroundScan?.urls ?? [])];
```

with:

```ts
  const getUrls = [...scans.flatMap((result) => result?.urls ?? []), ...(backgroundScan?.urls ?? []), ...backgroundFiles(backgroundScan?.fetches ?? [], background.background?.entry, files)];
```

3. Replace:

```ts
const base64Bytes = (base64: string) =>
```

with:

```ts
/** The extension files a background fetches by relative URL, which resolve against its own file. Others are left out quietly. */
function backgroundFiles(urls: readonly string[], entry: string | undefined, files: ExtensionFiles): string[] {
  if (entry === undefined) return [];
  return urls.flatMap((url) => {
    if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(url)) return [];
    try {
      const path = joinPath(url.startsWith("/") ? "" : dirname(entry), url.split(/[?#]/)[0]);
      return files.has(path) ? [path] : [];
    } catch {
      return [];
    }
  });
}

const base64Bytes = (base64: string) =>
```

- [ ] **Step 6: Run the tests**

Run: `npm run test:file -- test/unit/convert.test.ts test/unit/emit-background.test.ts test/unit/scan.test.ts`
Expected: PASS.

Run: `npm run test:file -- test/browser/content-runtime.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Type-check, run everything, and commit**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; every unit test passes (304 in the prototype).

```bash
git add src/runtime/config.ts src/convert/emit.ts src/runtime/content.ts src/runtime/index.ts src/runtime/background.ts src/convert/scan.ts src/convert/index.ts test/unit/convert.test.ts test/unit/emit-background.test.ts test/support/extension.ts test/browser/content-runtime.test.ts
git commit -m "Give the background and content scripts the network shim" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Events from pages, and chrome.alarms

**Files:**
- Modify: `src/runtime/messaging.ts` (the `evt` wire kind, `emit` and `onEvent`), `src/runtime/keys.ts` (`alarms`)
- Create: `src/runtime/alarms.ts`
- Modify: `src/runtime/background.ts` (`chrome.alarms`, stopped and restarted with the background)
- Test: `test/unit/alarms.test.ts`, `test/unit/messaging.test.ts`

**Interfaces:**
- Consumes: `createEvent`, `method` (Plan 3); `keys` (Plan 3).
- Produces:
  - **`Messaging`** gains `emit(type, data): Promise<void>` and `onEvent(type, handler(data, sender))`.
  - **`keys(ns).alarms`.**
  - **`alarms.ts`:** `type Alarm` and `createAlarms(gm, ns, log)`, which resolves to `{ api, pause(), resume() }`.

- [ ] **Step 1: Write the failing tests.** Create `test/unit/alarms.test.ts`:

```ts
// chrome.alarms: a schedule stored as a GM value, fired by whichever page's background leads.
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAlarms, type Alarm } from "../../src/runtime/alarms.ts";
import { createLogger } from "../../src/runtime/chrome.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { createHub, type Hub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

const MS = 1 / 60_000; // one millisecond, in minutes

async function alarmsOn(t: TestContext, hub: Hub) {
  const alarms = await createAlarms(createGm(hub.tab()), "t", createLogger("test"));
  t.after(() => alarms.pause());
  const fired: Alarm[] = [];
  alarms.api.onAlarm.addListener((alarm: Alarm) => fired.push(alarm));
  return { alarms, api: alarms.api as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>, fired };
}

describe("alarms", () => {
  it("fires a one-shot alarm after its delay, then forgets it, keeping the schedule in a GM value", async (t) => {
    const hub = createHub();
    const { api, fired } = await alarmsOn(t, hub);
    await api.create("once", { delayInMinutes: 40 * MS });
    assert.deepEqual(Object.keys(hub.store.get("x2u:t:alarms") as object), ["once"]);
    await eventually(() => fired.length === 1, 1000);
    assert.equal(fired[0].name, "once");
    assert.deepEqual(await api.getAll(), []);
    assert.deepEqual(hub.store.get("x2u:t:alarms"), {});
  });

  it("repeats a periodic alarm, and a second create with the same name replaces the first", async (t) => {
    const { api, fired } = await alarmsOn(t, createHub());
    await api.create("tick", { delayInMinutes: 10_000 });
    await api.create("tick", { periodInMinutes: 20 * MS });
    await eventually(() => fired.length >= 3, 1000);
    const [alarm] = (await api.getAll()) as Alarm[];
    assert.deepEqual([alarm.name, alarm.periodInMinutes], ["tick", 20 * MS]);
    assert.equal(await api.clear("tick"), true);
    assert.equal(await api.clear("tick"), false);
  });

  it("follows Chrome's argument rules: an optional name, and when or delayInMinutes but not both", async (t) => {
    const { api } = await alarmsOn(t, createHub());
    await api.create({ when: Date.now() + 60_000 });
    assert.equal(((await api.get()) as Alarm).name, "");
    await assert.rejects(api.create("x", { when: 1, delayInMinutes: 1 }), /Cannot set both when and delayInMinutes/);
    await assert.rejects(api.create("x", {}), /One of when, delayInMinutes or periodInMinutes is required/);
    assert.equal(await api.clearAll(), true);
    assert.equal(await api.get("missing"), undefined);
  });

  it("fires at once an alarm whose time passed while no page was open, for the next background that starts", async (t) => {
    const hub = createHub();
    hub.store.set("x2u:t:alarms", { late: { name: "late", scheduledTime: Date.now() - 5_000 } });
    const { fired } = await alarmsOn(t, hub);
    await eventually(() => fired.length === 1, 1000);
    assert.equal(fired[0].name, "late");
  });

  it("stops firing while its page doesn't lead, and reads the schedule afresh when it leads again", async (t) => {
    const hub = createHub();
    const { alarms, api, fired } = await alarmsOn(t, hub);
    await api.create("soon", { delayInMinutes: 30 * MS });
    alarms.pause();
    await sleep(80);
    assert.equal(fired.length, 0);
    // Meanwhile another leader rescheduled it.
    hub.store.set("x2u:t:alarms", { soon: { name: "soon", scheduledTime: Date.now() + 20 } });
    await alarms.resume();
    await eventually(() => fired.length === 1, 1000);
  });
});
```

In `test/unit/messaging.test.ts`:

1. Replace:

```ts
  it("sends a background message again when the page it went to goes away unanswered", async (t) => {
```

with:

```ts
  it("carries a page's event to its handler in the leader's background, held until the background starts", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    await sleep(5);
    const other = await page(t, hub, 2);
    other.messaging.setBackgroundReady(true);
    const seen: unknown[] = [];
    const delivered = other.messaging.emit("menu-click", { id: "item" });
    await sleep(30);
    leader.messaging.onEvent("menu-click", (data, sender) => seen.push([data, (sender.tab as { id: number }).id]));
    leader.messaging.setBackgroundReady(true);
    await delivered;
    assert.deepEqual(seen, [[{ id: "item" }, 2]]);
    // An event nobody handles is dropped quietly.
    await other.messaging.emit("unknown", null);
  });

  it("sends a background message again when the page it went to goes away unanswered", async (t) => {
```

2. Replace:

```ts
  it("sends a background message again when the page it went to goes away unanswered", async (t) => {
```

with:

```ts
  it("sends a page's event again to the new leader when the page it went to goes away unanswered", async (t) => {
    const hub = createHub();
    const ghost = await page(t, hub, 1);
    await sleep(5);
    const live = await page(t, hub, 2);
    live.messaging.setBackgroundReady(true);
    const seen: unknown[] = [];
    live.messaging.onEvent("command", (data) => seen.push(data));
    await eventually(() => live.registry.live().length === 1, 1000);
    const delivered = live.messaging.emit("command", { name: "run-it" });
    await sleep(30);
    await ghost.registry.leave();
    await delivered;
    assert.deepEqual(seen, [{ name: "run-it" }]);
  });

  it("sends a background message again when the page it went to goes away unanswered", async (t) => {
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:file -- test/unit/alarms.test.ts test/unit/messaging.test.ts`
Expected: FAIL:
- the alarms file, with `ERR_MODULE_NOT_FOUND`;
- the two new messaging tests: `other.messaging.emit is not a function` and `live.messaging.onEvent is not a function`.

- [ ] **Step 3: Let pages send the background events.** In `src/runtime/messaging.ts`:

1. Replace:

```ts
// - control requests the tabs API sends to another tab (navigate, reload, close).
```

with:

```ts
// - control requests the tabs API sends to another tab (navigate, reload, close);
// - events a page sends its background for the user's actions there: a menu command, a keyboard shortcut.
```

2. Replace:

```ts
  | { k: "ctl"; id: string; op: string; args: unknown };
```

with:

```ts
  | { k: "ctl"; id: string; op: string; args: unknown }
  | { k: "evt"; id: string; type: string; data: unknown; sender: MessageSender };
```

3. Replace:

```ts
  const events = {
    content: { message: createEvent<MessageListener>(log), connect: createEvent<(port: Port) => void>(log) },
    background: { message: createEvent<MessageListener>(log), connect: createEvent<(port: Port) => void>(log) },
  };
```

with:

```ts
  const events = {
    content: { message: createEvent<MessageListener>(log), connect: createEvent<(port: Port) => void>(log) },
    background: { message: createEvent<MessageListener>(log), connect: createEvent<(port: Port) => void>(log) },
  };
  /** The background's handlers for events pages send it, by type. */
  const eventHandlers = new Map<string, (data: unknown, sender: MessageSender) => void>();
```

4. Replace:

```ts
  const refuse = (wire: Wire & { k: "msg" | "open" }, from: number) =>
    post(() => from, wire.k === "msg" ? { k: "reply", id: wire.id, error: NO_RECEIVER } : { k: "close", port: wire.port, side: "opener", error: NO_RECEIVER });
```

with:

```ts
  const refuse = (wire: Wire & { k: "msg" | "open" | "evt" }, from: number) =>
    post(() => from, wire.k === "open" ? { k: "close", port: wire.port, side: "opener", error: NO_RECEIVER } : { k: "reply", id: wire.id, error: NO_RECEIVER });

  const onEvent = (wire: Wire & { k: "evt" }, from: number) => {
    try {
      eventHandlers.get(wire.type)?.(wire.data, wire.sender);
    } catch (error) {
      log.error(error);
    }
    post(() => from, { k: "reply", id: wire.id });
  };
```

5. Replace:

```ts
      case "msg":
      case "open":
        if (wire.to === "background" && !backgroundReady) {
```

with:

```ts
      case "msg":
      case "open":
      case "evt":
        if ((wire.k === "evt" || wire.to === "background") && !backgroundReady) {
```

6. Replace:

```ts
        } else if (wire.k === "msg") onMessage(wire, from);
        else onOpen(wire, from);
        return;
```

with:

```ts
        } else if (wire.k === "msg") onMessage(wire, from);
        else if (wire.k === "evt") onEvent(wire, from);
        else onOpen(wire, from);
        return;
```

7. Replace:

```ts
    /** Asks another page to run a control request (the tabs API's update, reload and remove). */
```

with:

```ts
    /**
     * Tells the background about something the user did on this page (a menu command, a keyboard shortcut). It is held
     * and sent again like a message for the background; it resolves once the background has handled it.
     */
    emit: async (type: string, data: unknown): Promise<void> => {
      const id = nextId();
      const outcome = await request(deps.leader, id, () => ({ k: "evt", id, type, data, sender: deps.sender("content") }), true);
      if (outcome.error !== undefined) throw new Error(outcome.error);
    },
    /** The background's handler for one type of event from pages. */
    onEvent: (type: string, handler: (data: unknown, sender: MessageSender) => void) => {
      eventHandlers.set(type, handler);
    },
    /** Asks another page to run a control request (the tabs API's update, reload and remove). */
```

- [ ] **Step 4: Write `src/runtime/alarms.ts` and its key.** In `src/runtime/keys.ts`:

Replace:

```ts
    session: `x2u:${ns}:session`,
```

with:

```ts
    session: `x2u:${ns}:session`,
    /** The alarms' schedule (spec §5.2), which the leader's background keeps. */
    alarms: `x2u:${ns}:alarms`,
```

```ts
// chrome.alarms (spec §5.2): the schedule is a GM value, so it outlives the tab that leads; only the leader's background
// runs timers for it. A leader that steps down stops them, and one that leads again reloads the schedule.
// Ceilings: an alarm fires only while some page the userscript runs on is open, and a hidden tab's timers can run up
// to a minute late (Chrome throttles them).
import { createEvent, method, type Logger } from "./chrome.ts";
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";

export type Alarm = { name: string; scheduledTime: number; periodInMinutes?: number };
type AlarmInfo = { when?: number; delayInMinutes?: number; periodInMinutes?: number };

const MINUTE = 60_000;

export async function createAlarms(gm: Gm, ns: string, log: Logger) {
  const key = keys(ns).alarms;
  const onAlarm = createEvent<(alarm: Alarm) => void>(log);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let alarms: Record<string, Alarm> = {};
  let running = true;

  const load = async () => {
    const stored = await gm.getValue<Record<string, Alarm>>(key);
    alarms = stored && typeof stored === "object" ? stored : {};
  };
  const save = () => gm.setValue(key, alarms).catch((error: unknown) => log.error(error));
  const stop = (name: string) => {
    clearTimeout(timers.get(name));
    timers.delete(name);
  };
  // An alarm whose time passed while no page was open fires at once, as Chrome fires missed alarms on wake.
  const schedule = (alarm: Alarm) => {
    stop(alarm.name);
    if (running) timers.set(alarm.name, setTimeout(() => fire(alarm.name), Math.max(0, alarm.scheduledTime - Date.now())));
  };
  const fire = (name: string) => {
    const alarm = alarms[name];
    timers.delete(name);
    if (!alarm || !running) return;
    if (alarm.periodInMinutes) schedule((alarms[name] = { ...alarm, scheduledTime: Date.now() + alarm.periodInMinutes * MINUTE }));
    else delete alarms[name];
    void save();
    onAlarm.dispatch({ ...alarm });
  };

  await load();
  for (const alarm of Object.values(alarms)) schedule(alarm);

  /** create([name], info): Chrome's optional first argument. */
  const create = (...args: unknown[]) => {
    const [name, info] = typeof args[0] === "string" ? [args[0], (args[1] ?? {}) as AlarmInfo] : ["", (args[0] ?? {}) as AlarmInfo];
    if (info.when !== undefined && info.delayInMinutes !== undefined) throw new Error("Cannot set both when and delayInMinutes.");
    const delay = info.delayInMinutes ?? info.periodInMinutes;
    if (info.when === undefined && delay === undefined) throw new Error("One of when, delayInMinutes or periodInMinutes is required.");
    const alarm: Alarm = { name, scheduledTime: info.when ?? Date.now() + (delay as number) * MINUTE, ...(info.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}) };
    alarms[name] = alarm;
    schedule(alarm);
    return save();
  };
  const clear = async (name = "") => {
    const had = name in alarms;
    delete alarms[name];
    stop(name);
    await save();
    return had;
  };

  return {
    api: {
      create: method(log, create),
      get: method(log, async (name: string = "") => (alarms[name] ? { ...alarms[name] } : undefined)),
      getAll: method(log, async () => Object.values(alarms).map((alarm) => ({ ...alarm }))),
      clear: method(log, clear),
      clearAll: method(log, async () => {
        const had = Object.keys(alarms).length > 0;
        for (const name of Object.keys(alarms)) stop(name);
        alarms = {};
        await save();
        return had;
      }),
      onAlarm: onAlarm.event,
    },
    /** This page stopped leading: its timers stop, and it no longer writes the schedule. */
    pause() {
      running = false;
      for (const name of [...timers.keys()]) stop(name);
    },
    /** This page leads again: the schedule may have changed meanwhile, so it is read afresh. */
    async resume() {
      running = true;
      await load();
      for (const alarm of Object.values(alarms)) schedule(alarm);
    },
  };
}
```

- [ ] **Step 5: Give the background chrome.alarms.** In `src/runtime/background.ts`:

1. Replace:

```ts
import type { Assets } from "./assets.ts";
```

with:

```ts
import { createAlarms } from "./alarms.ts";
import type { Assets } from "./assets.ts";
```

2. Replace:

```ts
  const localStorage = await createLocalStorage(gm, config.ns, log);
```

with:

```ts
  const localStorage = await createLocalStorage(gm, config.ns, log);
  const alarms = await createAlarms(gm, config.ns, log);
```

3. Replace:

```ts
    tabs: withFallback(log, "tabs", deps.tabs, "all"),
    extension,
  };
```

with:

```ts
    tabs: withFallback(log, "tabs", deps.tabs, "all"),
    extension,
    alarms: withFallback(log, "alarms", alarms.api, "all"),
  };
```

4. Replace:

```ts
    pause: () => {
      active = false;
      messaging.setBackgroundReady(false);
    },
    resume: () => {
      active = true;
      messaging.setBackgroundReady(true);
    },
```

with:

```ts
    pause: () => {
      active = false;
      messaging.setBackgroundReady(false);
      alarms.pause();
    },
    resume: () => {
      active = true;
      messaging.setBackgroundReady(true);
      void alarms.resume();
    },
```

- [ ] **Step 6: Run the tests**

Run: `npm run test:file -- test/unit/alarms.test.ts test/unit/messaging.test.ts`
Expected: PASS. Run them 3 times; they should pass every time.

- [ ] **Step 7: Type-check, run everything, and commit**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; every unit test passes (311 in the prototype).

```bash
git add src/runtime/messaging.ts src/runtime/keys.ts src/runtime/alarms.ts src/runtime/background.ts test/unit/alarms.test.ts test/unit/messaging.test.ts
git commit -m "Let pages send events to the background, and add chrome.alarms" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Context menus and the toolbar button as menu commands

**Files:**
- Create: `src/runtime/menus.ts`
- Modify: `src/runtime/keys.ts` (`menus`), `src/runtime/background.ts`, `src/runtime/index.ts`
- Test: `test/unit/menus.test.ts`

**Interfaces:**
- Consumes:
  - `messaging.emit`, `messaging.onEvent` (Task 4);
  - `RuntimeConfig.action` (Task 1);
  - `gm.registerMenuCommand` and `gm.unregisterMenuCommand` (Plan 1).
- Produces:
  - **`keys(ns).menus`.**
  - **`menus.ts`:**
    - `type MenuItem`, `ActionState`, `MenuState`, `MenuClick`;
    - `createMenus({ gm, ns, log, config, persistent })`, which resolves to `{ contextMenus, action, click(info, tab), actionClick(tab) }`;
    - `showMenus({ gm, ns, log, config, emit })`.
  - **Page events:** `"menu-click"` (a `MenuClick`) and `"action-click"`.

- [ ] **Step 1: Write the failing test** `test/unit/menus.test.ts`

```ts
// chrome.contextMenus and the toolbar button, as menu commands every tab registers from the background's menu state.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger, readLastError } from "../../src/runtime/chrome.ts";
import type { RuntimeConfig } from "../../src/runtime/config.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { createMenus, showMenus, type MenuClick } from "../../src/runtime/menus.ts";
import { createHub, type Hub } from "../support/gm-hub.ts";
import { eventually } from "../support/time.ts";

// The page the tab's menu commands are for.
(globalThis as { location?: unknown }).location = new URL("https://page.test/app");

const config = (extra: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ name: "Ext", ns: "t", id: "id", manifest: {}, groups: [], assets: {}, locales: {}, ...extra });

/** A tab with menu commands: what it registered, and a way to click one. */
function tabWithMenu(hub: Hub) {
  const commands = new Map<number, [string, () => void]>();
  let next = 0;
  const gm = createGm({
    ...hub.tab(),
    GM_registerMenuCommand: (caption, onClick) => (commands.set(++next, [caption, onClick]), next),
    GM_unregisterMenuCommand: (id) => void commands.delete(Number(id)),
  });
  return {
    gm,
    captions: () => [...commands.values()].map(([caption]) => caption),
    click: (caption: string) => [...commands.values()].find(([text]) => text === caption)?.[1](),
  };
}

async function setup(extra: Partial<RuntimeConfig> = {}, persistent = false) {
  const hub = createHub();
  const background = await createMenus({ gm: createGm(hub.tab()), ns: "t", log: createLogger("test"), config: config(extra), persistent });
  const tab = tabWithMenu(hub);
  const tabInfo = { id: 7 };
  // The tab's clicks reach the background as the messaging layer would deliver them.
  await showMenus({
    gm: tab.gm,
    ns: "t",
    log: createLogger("test"),
    config: config(extra),
    emit: async (type, data) => (type === "menu-click" ? background.click(data as MenuClick, tabInfo) : background.actionClick(tabInfo)),
  });
  const menus = background.contextMenus as unknown as Record<string, (...args: unknown[]) => unknown> & { onClicked: { addListener(fn: (info: Record<string, unknown>, tab: unknown) => void): void } };
  const action = background.action as unknown as Record<string, (...args: unknown[]) => Promise<unknown>> & { onClicked: { addListener(fn: (tab: unknown) => void): void } };
  return { hub, menus, action, tab };
}

describe("context menus", () => {
  it("shows each item a page can show as a menu command, child under parent, checkboxes marked", async () => {
    const { menus, tab } = await setup();
    menus.create({ id: "root", title: "Tools" });
    menus.create({ id: "a", parentId: "root", title: "Search '%s'", contexts: ["selection"] });
    menus.create({ id: "b", title: "Dark mode", type: "checkbox", checked: true });
    menus.create({ id: "link", title: "Open link", contexts: ["link"] });
    menus.create({ id: "sep", type: "separator" });
    menus.create({ id: "off", title: "Off", enabled: false });
    menus.create({ id: "elsewhere", title: "Elsewhere", documentUrlPatterns: ["https://other.test/*"] });
    await eventually(() => tab.captions().length === 2, 1000);
    assert.deepEqual(tab.captions(), ["Tools › Search '…'", "☑ Dark mode"]);
  });

  it("fires onClicked with the page's URL, toggling a checkbox, and keeps up with updates and removals", async () => {
    const { menus, tab } = await setup();
    const clicks: Array<[Record<string, unknown>, unknown]> = [];
    menus.onClicked.addListener((info, clickedTab) => clicks.push([info, clickedTab]));
    menus.create({ id: "dark", title: "Dark mode", type: "checkbox" });
    await eventually(() => tab.captions().includes("☐ Dark mode"), 1000);
    tab.click("☐ Dark mode");
    await eventually(() => clicks.length === 1, 1000);
    assert.deepEqual(clicks[0], [{ menuItemId: "dark", pageUrl: location.href, editable: false, wasChecked: false, checked: true }, { id: 7 }]);
    await eventually(() => tab.captions().includes("☑ Dark mode"), 1000);
    await menus.update("dark", { title: "Night" });
    await eventually(() => tab.captions().includes("☑ Night"), 1000);
    await menus.remove("dark");
    await eventually(() => tab.captions().length === 0, 1000);
  });

  it("reports a duplicate or unknown id as lastError, and removes an item's children with it", async () => {
    const { hub, menus } = await setup();
    menus.create({ id: "x", title: "X" });
    menus.create({ id: "y", parentId: "x", title: "Y" });
    const error = await new Promise((resolve) => menus.create({ id: "x", title: "again" }, () => resolve(readLastError()?.message)));
    assert.equal(error, "Cannot create item with duplicate id x");
    await assert.rejects(menus.update("nope", {}) as Promise<unknown>, /Cannot find menu item with id nope/);
    await menus.remove("x");
    assert.deepEqual((hub.store.get("x2u:t:menus") as { items: unknown[] }).items, []);
    assert.equal((menus.ContextType as unknown as Record<string, string>).SELECTION, "selection");
  });

  it("keeps an event page's items from one start to the next, but not a persistent page's or ones without an id", async () => {
    const hub = createHub();
    hub.store.set("x2u:t:menus", { items: [{ id: "kept", title: "Kept", type: "normal", contexts: ["page"], checked: false, enabled: true, visible: true }, { id: "1", title: "Generated", type: "normal", contexts: ["page"], checked: false, enabled: true, visible: true, generated: true }], action: { enabled: true } });
    const eventPage = await createMenus({ gm: createGm(hub.tab()), ns: "t", log: createLogger("test"), config: config(), persistent: false });
    assert.equal(await new Promise((resolve) => (eventPage.contextMenus.create as (p: object, cb: () => void) => string)({ id: "kept" }, () => resolve(readLastError()?.message))), "Cannot create item with duplicate id kept");
    const persistentPage = await createMenus({ gm: createGm(hub.tab()), ns: "t", log: createLogger("test"), config: config(), persistent: true });
    assert.equal(typeof persistentPage.contextMenus.create({ id: "kept" }), "string");
  });
});

describe("toolbar button", () => {
  it("shows a button without a popup as a menu command, with its title and badge, and fires action.onClicked", async () => {
    const { action, tab } = await setup({ action: { key: "action", title: "Do it", popup: false } });
    const clicked: unknown[] = [];
    action.onClicked.addListener((clickedTab) => clicked.push(clickedTab));
    await eventually(() => tab.captions().includes("Do it"), 1000);
    await action.setBadgeText({ text: "3" });
    await eventually(() => tab.captions().includes("Do it (3)"), 1000);
    tab.click("Do it (3)");
    await eventually(() => clicked.length === 1, 1000);
    assert.deepEqual(clicked, [{ id: 7 }]);
    await action.disable();
    await eventually(() => tab.captions().length === 0, 1000);
    assert.equal(await action.isEnabled(), false);
    assert.equal(await action.getTitle({}), "Do it");
  });

  it("shows no command for a button with a popup, or for an extension without a button", async () => {
    assert.deepEqual((await setup({ action: { key: "action", popup: true } })).tab.captions(), []);
    assert.deepEqual((await setup()).tab.captions(), []);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/menus.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write `src/runtime/menus.ts`**

```ts
// chrome.contextMenus and the toolbar button (spec §5.2): a userscript manager has no context menu and no toolbar, so
// both become the manager's menu commands, which every tab registers for itself.
// - createMenus (the background) keeps the items and the button's state in one GM value, and turns clicks into
//   contextMenus.onClicked and action.onClicked.
// - showMenus (every top frame) registers a command per item that a page can show, and tells the background about a click.
// Ceilings: the menu is flat (a child's caption names its parent); items only for links, images, media or editable
// fields aren't shown, as there is nothing to click them on; onClicked gets the page's URL and any selected text, but no
// link or media details; the button's badge shows in its caption, and its icon and colours don't show at all.
import { callWithLastError, createEvent, method, type Logger } from "./chrome.ts";
import type { RuntimeConfig } from "./config.ts";
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";
import { urlMatches } from "./match.ts";

export type MenuItem = {
  id: string;
  title: string;
  type: "normal" | "checkbox" | "radio" | "separator";
  contexts: string[];
  checked: boolean;
  enabled: boolean;
  visible: boolean;
  parentId?: string;
  documentUrlPatterns?: string[];
  /** An item created without an id: it belongs to the page that created it, a persistent background page. */
  generated?: boolean;
};

/** What the toolbar button shows; undefined fields fall back to the manifest. */
export type ActionState = { title?: string; badge?: string; enabled: boolean; popup?: string };

export type MenuState = { items: MenuItem[]; action: ActionState };

export type MenuClick = { menuItemId: string; pageUrl: string; selectionText?: string };

/** Contexts a page's menu command can stand for: the page itself, its selection, or the toolbar button. */
const SHOWN_CONTEXTS = new Set(["all", "page", "frame", "selection", "action", "browser_action", "page_action"]);

const ENUMS = {
  ContextType: { ALL: "all", PAGE: "page", FRAME: "frame", SELECTION: "selection", LINK: "link", EDITABLE: "editable", IMAGE: "image", VIDEO: "video", AUDIO: "audio", LAUNCHER: "launcher", BROWSER_ACTION: "browser_action", PAGE_ACTION: "page_action", ACTION: "action" },
  ItemType: { NORMAL: "normal", CHECKBOX: "checkbox", RADIO: "radio", SEPARATOR: "separator" },
  ACTION_MENU_TOP_LEVEL_LIMIT: 6,
};

type CreateProperties = Partial<Omit<MenuItem, "generated">> & { onclick?: (info: unknown, tab: unknown) => void };

export async function createMenus(deps: { gm: Gm; ns: string; log: Logger; config: RuntimeConfig; persistent: boolean }) {
  const { gm, log } = deps;
  const key = keys(deps.ns).menus;
  const onClicked = createEvent<(info: unknown, tab: unknown) => void>(log);
  const onActionClicked = createEvent<(tab: unknown) => void>(log);
  const onclick = new Map<string, (info: unknown, tab: unknown) => void>();
  const stored = await gm.getValue<MenuState>(key);
  const state: MenuState = { items: Array.isArray(stored?.items) ? stored.items : [], action: stored?.action ?? { enabled: true } };
  // A persistent background page creates its menu every time it starts, as Chrome starts it with an empty one.
  if (deps.persistent) state.items = [];
  // Items without an id lived with the page that made them.
  state.items = state.items.filter((item) => !item.generated);
  let counter = 0;
  const save = () => gm.setValue(key, state).catch((error: unknown) => log.error(error));
  void save();

  const find = (id: unknown) => state.items.find((item) => item.id === String(id));
  /** Runs a menu change; a failure goes to the callback as lastError, or rejects when there is none. */
  const change = (callback: unknown, run: () => void): Promise<void> | undefined => {
    try {
      run();
    } catch (error) {
      if (typeof callback === "function") {
        callWithLastError(log, error as Error, () => callback());
        return undefined;
      }
      return Promise.reject(error);
    }
    const saved = save();
    if (typeof callback === "function") void saved.then(() => callback());
    return typeof callback === "function" ? undefined : saved;
  };

  const create = (properties: CreateProperties = {}, callback?: () => void): string => {
    const id = properties.id === undefined ? String(++counter) : String(properties.id);
    // create returns the id, not a promise, so a failure without a callback is an unchecked lastError, as in Chrome.
    void change(callback ?? (() => {}), () => {
      if (find(id)) throw new Error(`Cannot create item with duplicate id ${id}`);
      if (properties.parentId !== undefined && !find(properties.parentId)) throw new Error(`Cannot find menu item with id ${properties.parentId}`);
      state.items.push({
        id,
        title: String(properties.title ?? ""),
        type: properties.type ?? "normal",
        contexts: properties.contexts ?? ["page"],
        checked: properties.checked === true,
        enabled: properties.enabled !== false,
        visible: properties.visible !== false,
        ...(properties.parentId === undefined ? {} : { parentId: String(properties.parentId) }),
        ...(properties.documentUrlPatterns ? { documentUrlPatterns: properties.documentUrlPatterns } : {}),
        ...(properties.id === undefined ? { generated: true } : {}),
      });
      if (properties.onclick) onclick.set(id, properties.onclick);
    });
    return id;
  };

  const update = (id: unknown, properties: CreateProperties = {}, callback?: () => void) =>
    change(callback, () => {
      const item = find(id);
      if (!item) throw new Error(`Cannot find menu item with id ${String(id)}`);
      const { onclick: handler, id: _id, ...rest } = properties;
      Object.assign(item, rest);
      if (handler) onclick.set(item.id, handler);
    });

  const remove = (id: unknown, callback?: () => void) =>
    change(callback, () => {
      if (!find(id)) throw new Error(`Cannot find menu item with id ${String(id)}`);
      // An item's children go with it.
      const gone = new Set([String(id)]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const item of state.items) if (item.parentId !== undefined && gone.has(item.parentId) && !gone.has(item.id)) (gone.add(item.id), (grew = true));
      }
      state.items = state.items.filter((item) => !gone.has(item.id));
      for (const gid of gone) onclick.delete(gid);
    });

  const removeAll = (callback?: () => void) =>
    change(callback, () => {
      state.items = [];
      onclick.clear();
    });

  const contextMenus = {
    ...ENUMS,
    create,
    update,
    remove,
    removeAll,
    onClicked: onClicked.event,
  };

  const setAction = (patch: Partial<ActionState>) => {
    Object.assign(state.action, patch);
    return save();
  };
  const defaultTitle = deps.config.action?.title ?? deps.config.name;
  const badgeColors = { background: [0, 0, 0, 0] as unknown, text: [255, 255, 255, 255] as unknown };
  const action = {
    onClicked: onActionClicked.event,
    setTitle: method(log, (details: { title?: string } = {}) => setAction({ title: details.title ?? undefined })),
    getTitle: method(log, async () => state.action.title ?? defaultTitle),
    setBadgeText: method(log, (details: { text?: string } = {}) => setAction({ badge: details.text || undefined })),
    getBadgeText: method(log, async () => state.action.badge ?? ""),
    setBadgeBackgroundColor: method(log, async (details: { color?: unknown } = {}) => void (badgeColors.background = details.color)),
    getBadgeBackgroundColor: method(log, async () => badgeColors.background),
    setBadgeTextColor: method(log, async (details: { color?: unknown } = {}) => void (badgeColors.text = details.color)),
    getBadgeTextColor: method(log, async () => badgeColors.text),
    setIcon: method(log, async () => {}),
    setPopup: method(log, (details: { popup?: string } = {}) => setAction({ popup: details.popup || undefined })),
    getPopup: method(log, async () => state.action.popup ?? ""),
    enable: method(log, () => setAction({ enabled: true })),
    disable: method(log, () => setAction({ enabled: false })),
    isEnabled: method(log, async () => state.action.enabled),
    // pageAction's names for the same thing.
    show: method(log, () => setAction({ enabled: true })),
    hide: method(log, () => setAction({ enabled: false })),
  };

  return {
    contextMenus,
    action,
    /** A tab's menu command for an item was clicked: checkbox and radio items toggle, then onClicked fires. */
    click(info: MenuClick, tab: unknown) {
      const item = find(info.menuItemId);
      if (!item) return;
      const wasChecked = item.checked;
      if (item.type === "checkbox") item.checked = !item.checked;
      if (item.type === "radio") for (const other of state.items) if (other.type === "radio" && other.parentId === item.parentId) other.checked = other === item;
      if (item.type === "checkbox" || item.type === "radio") void save();
      const data = { ...info, editable: false, ...(item.parentId === undefined ? {} : { parentMenuItemId: item.parentId }), ...(item.type === "checkbox" || item.type === "radio" ? { wasChecked, checked: item.checked } : {}) };
      onclick.get(item.id)?.(data, tab);
      onClicked.dispatch(data, tab);
    },
    /** A tab's command for the toolbar button was clicked. */
    actionClick(tab: unknown) {
      onActionClicked.dispatch(tab);
    },
  };
}

/**
 * Keeps this page's menu commands in step with the background's menu state: one for the toolbar button (when it has no
 * popup and is enabled) and one per context-menu item this page can show. emit tells the background about a click.
 * Top frames only: a manager shows one menu per tab.
 */
export async function showMenus(deps: { gm: Gm; ns: string; log: Logger; config: RuntimeConfig; emit(type: string, data: unknown): Promise<void> }) {
  const { gm, log, config } = deps;
  const key = keys(deps.ns).menus;
  let registered: Array<number | string> = [];

  const render = async (state: MenuState | undefined) => {
    const commands: Array<[caption: string, onClick: () => void]> = [];
    const action = state?.action ?? { enabled: true };
    if (config.action && !config.action.popup && !action.popup && action.enabled) {
      const title = action.title ?? config.action.title ?? config.name;
      commands.push([action.badge ? `${title} (${action.badge})` : title, () => void deps.emit("action-click", null).catch((error: unknown) => log.error(error))]);
    }
    const items = state?.items ?? [];
    const byId = new Map(items.map((item) => [item.id, item]));
    const parents = new Set(items.flatMap((item) => (item.parentId === undefined ? [] : [item.parentId])));
    for (const item of items) {
      if (!item.visible || !item.enabled || item.type === "separator" || parents.has(item.id)) continue;
      if (!item.contexts.some((context) => SHOWN_CONTEXTS.has(context))) continue;
      if (item.documentUrlPatterns && !safeMatches(location.href, item.documentUrlPatterns)) continue;
      const path: string[] = [];
      for (let at: MenuItem | undefined = item; at; at = at.parentId === undefined ? undefined : byId.get(at.parentId)) path.unshift(at.title.replace(/%s/g, "…"));
      const mark = item.type === "checkbox" || item.type === "radio" ? (item.checked ? "☑ " : "☐ ") : "";
      commands.push([
        mark + path.join(" › "),
        () => {
          const selection = globalThis.getSelection?.()?.toString() ?? "";
          const info: MenuClick = { menuItemId: item.id, pageUrl: location.href, ...(selection ? { selectionText: selection } : {}) };
          void deps.emit("menu-click", info).catch((error: unknown) => log.error(error));
        },
      ]);
    }
    const previous = registered;
    registered = [];
    for (const id of previous) await gm.unregisterMenuCommand(id).catch(() => {});
    for (const [caption, onClick] of commands) registered.push(await gm.registerMenuCommand(caption, onClick));
  };

  // Renders run one after another, each with the latest state, so commands never pile up.
  let queue = Promise.resolve();
  const refresh = (state: MenuState | undefined) => {
    queue = queue.then(() => render(state)).catch((error: unknown) => log.error("couldn't show the extension's menu commands:", error));
    return queue;
  };
  await gm.addValueChangeListener(key, (_key, _old, value) => void refresh(value as MenuState | undefined));
  await refresh(await gm.getValue<MenuState>(key));
}

function safeMatches(url: string, patterns: readonly string[]): boolean {
  try {
    return urlMatches(url, patterns);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Wire it in.** In `src/runtime/keys.ts`:

Replace:

```ts
    alarms: `x2u:${ns}:alarms`,
```

with:

```ts
    alarms: `x2u:${ns}:alarms`,
    /** Context-menu items and the toolbar button's state, which every tab shows as menu commands. */
    menus: `x2u:${ns}:menus`,
```

In `src/runtime/background.ts`:

1. Replace:

```ts
import { createLocalStorage } from "./local-storage.ts";
```

with:

```ts
import { createLocalStorage } from "./local-storage.ts";
import { createMenus, type MenuClick } from "./menus.ts";
```

2. Replace:

```ts
  const alarms = await createAlarms(gm, config.ns, log);
```

with:

```ts
  const alarms = await createAlarms(gm, config.ns, log);
  // A persistent MV2 background page makes its menu each time it starts; an event page or service worker makes it once.
  const persistent = !background.worker && (config.manifest as { background?: { persistent?: unknown } }).background?.persistent !== false;
  const menus = await createMenus({ gm, ns: config.ns, log, config, persistent });
  messaging.onEvent("menu-click", (data, sender) => menus.click(data as MenuClick, sender.tab));
  messaging.onEvent("action-click", (_data, sender) => menus.actionClick(sender.tab));
```

3. Replace:

```ts
    alarms: withFallback(log, "alarms", alarms.api, "all"),
  };
```

with:

```ts
    alarms: withFallback(log, "alarms", alarms.api, "all"),
    contextMenus: withFallback(log, "contextMenus", menus.contextMenus, "all"),
    menus: withFallback(log, "menus", menus.contextMenus, "all"),
    // MV3's action, and MV2's browserAction and pageAction: one toolbar button, shown as a menu command.
    action: withFallback(log, "action", menus.action, "all"),
    browserAction: withFallback(log, "browserAction", menus.action, "all"),
    pageAction: withFallback(log, "pageAction", menus.action, "all"),
  };
```

In `src/runtime/index.ts`:

1. Replace:

```ts
import { createMessaging } from "./messaging.ts";
```

with:

```ts
import { showMenus } from "./menus.ts";
import { createMessaging } from "./messaging.ts";
```

2. Replace:

```ts
      if (frame || !background) return;
```

with:

```ts
      if (frame || !background) return;
      // The background's context-menu items and toolbar button, as this tab's menu commands.
      void showMenus({ gm, ns: config.ns, log, config, emit: messaging.emit });
```

- [ ] **Step 5: Run the test**

Run: `npm run test:file -- test/unit/menus.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Type-check, run everything, and commit**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; every unit test passes (317 in the prototype).

```bash
git add src/runtime/menus.ts src/runtime/keys.ts src/runtime/background.ts src/runtime/index.ts test/unit/menus.test.ts
git commit -m "Show context menus and the toolbar button as menu commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Keyboard shortcuts

**Files:**
- Create: `src/runtime/commands.ts`
- Modify:
  - `src/runtime/background.ts`, `src/runtime/index.ts`;
  - `src/convert/support.ts` (`commands` leaves the unsupported manifest keys);
  - `src/convert/analyze.ts` (reports `manifest.commands` as partial).
- Test: `test/unit/commands.test.ts`, `test/unit/analyze.test.ts`

**Interfaces:**
- Consumes:
  - `RuntimeConfig.commands` (Task 1);
  - `messaging.emit`, `messaging.onEvent` (Task 4);
  - the menus' `actionClick` (Task 5).
- Produces:
  - **`commands.ts`:**
    - `type Shortcut`, `EXECUTE_ACTION`;
    - `commandPlatform(platform?)`, `parseShortcut(text, platform)`;
    - `listenForCommands(target, config, emit, log, platform?)`;
    - `createCommands(config, log, platform?)`, which returns `{ api, fire(name, tab) }`.
  - **Page event:** `"command"` (`{ name }`).

- [ ] **Step 1: Write the failing tests.** Create `test/unit/commands.test.ts`:

```ts
// chrome.commands: the manifest's shortcuts, heard on each page and fired in the background.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/runtime/chrome.ts";
import { commandPlatform, createCommands, listenForCommands, parseShortcut } from "../../src/runtime/commands.ts";
import type { RuntimeConfig } from "../../src/runtime/config.ts";

const config: RuntimeConfig = {
  name: "Ext", ns: "t", id: "id", manifest: {}, groups: [], assets: {}, locales: {},
  commands: {
    toggle: { description: "Toggle", keys: { default: "Ctrl+Shift+Y", mac: "MacCtrl+Shift+Y" } },
    next: { keys: { default: "Alt+Period" } },
    unbound: { keys: {} },
  },
};

const key = (code: string, modifiers: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean; repeat?: boolean } = {}) =>
  Object.assign(new Event("keydown", { cancelable: true }), { code, ...modifiers });

describe("parseShortcut", () => {
  it("reads Chrome's key names, with Ctrl meaning Command on a Mac", () => {
    assert.deepEqual(parseShortcut("Ctrl+Shift+Y", "linux"), { code: "KeyY", ctrl: true, alt: false, shift: true, meta: false });
    assert.deepEqual(parseShortcut("Ctrl+Shift+Y", "mac"), { code: "KeyY", ctrl: false, alt: false, shift: true, meta: true });
    assert.deepEqual(parseShortcut("MacCtrl+Command+3", "mac"), { code: "Digit3", ctrl: true, alt: false, shift: false, meta: true });
    assert.equal(parseShortcut("Alt+Up", "windows")?.code, "ArrowUp");
    assert.equal(parseShortcut("Alt+Comma", "windows")?.code, "Comma");
    assert.equal(parseShortcut("Ctrl+Shift+Banana", "linux"), undefined);
    assert.equal(parseShortcut("Ctrl+Shift", "linux"), undefined);
  });

  it("names this platform the way manifests do", () => {
    assert.deepEqual(["MacIntel", "Win32", "Linux x86_64", "CrOS x86_64"].map((platform) => commandPlatform(platform)), ["mac", "windows", "linux", "chromeos"]);
  });
});

describe("listenForCommands", () => {
  it("tells the background about a shortcut, using this platform's key, and keeps it from the page", async () => {
    const page = new EventTarget();
    const sent: unknown[] = [];
    listenForCommands(page, config, async (type, data) => void sent.push([type, data]), createLogger("test"), "mac");
    const pageSaw: string[] = [];
    page.addEventListener("keydown", (event) => pageSaw.push((event as Event & { code: string }).code));
    const matching = key("KeyY", { ctrlKey: true, shiftKey: true });
    page.dispatchEvent(matching);
    page.dispatchEvent(key("KeyY", { metaKey: true, shiftKey: true })); // Ctrl+Shift+Y, which the Mac key replaces
    page.dispatchEvent(key("Period", { altKey: true }));
    page.dispatchEvent(key("Period", { altKey: true, repeat: true }));
    assert.deepEqual(sent, [["command", { name: "toggle" }], ["command", { name: "next" }]]);
    assert.equal(matching.defaultPrevented, true);
    assert.deepEqual(pageSaw, ["KeyY"]);
  });
});

describe("createCommands", () => {
  it("lists the shortcuts for this platform and fires onCommand with the tab", async () => {
    const commands = createCommands(config, createLogger("test"), "windows");
    assert.deepEqual(await (commands.api.getAll as () => Promise<unknown>)(), [
      { name: "toggle", description: "Toggle", shortcut: "Ctrl+Shift+Y" },
      { name: "next", description: "", shortcut: "Alt+Period" },
      { name: "unbound", description: "", shortcut: "" },
    ]);
    const fired: unknown[] = [];
    commands.api.onCommand.addListener((name: string, tab: unknown) => fired.push([name, tab]));
    commands.fire("toggle", { id: 3 });
    assert.deepEqual(fired, [["toggle", { id: 3 }]]);
  });
});
```

In `test/unit/analyze.test.ts`:

1. Replace:

```ts
      model({ background: { service_worker: "sw.js" }, action: { default_popup: "p.html" }, options_ui: { page: "o.html" }, chrome_url_overrides: { newtab: "n.html" }, commands: {} }),
```

with:

```ts
      model({ background: { service_worker: "sw.js" }, action: { default_popup: "p.html" }, options_ui: { page: "o.html" }, chrome_url_overrides: { newtab: "n.html" }, commands: { go: { suggested_key: "Alt+G" } } }),
```

2. Replace:

```ts
      ["manifest.action.default_popup", "unsupported", ["popup"]],
      ["manifest.options_ui", "unsupported", ["options"]],
      ["manifest.chrome_url_overrides", "unsupported", ["background"]],
      ["manifest.commands", "unsupported", ["background"]],
    ]);
```

with:

```ts
      ["manifest.commands", "partial", ["background"]],
      ["manifest.action.default_popup", "unsupported", ["popup"]],
      ["manifest.options_ui", "unsupported", ["options"]],
      ["manifest.chrome_url_overrides", "unsupported", ["background"]],
    ]);
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:file -- test/unit/commands.test.ts test/unit/analyze.test.ts`
Expected: FAIL:
- the commands file, with `ERR_MODULE_NOT_FOUND`;
- "reports the pages and manifest features this version doesn't convert", because `manifest.commands` is still unsupported.

- [ ] **Step 3: Write `src/runtime/commands.ts`**

```ts
// chrome.commands (spec §5.2): the manifest's keyboard shortcuts. Every page the userscript runs on listens for them and
// tells the background, which fires commands.onCommand, or action.onClicked for _execute_action.
// Ceilings: a shortcut works only while such a page has focus, and the user can't change it.
import { createEvent, method, type Logger } from "./chrome.ts";
import type { RuntimeConfig } from "./config.ts";

export type Shortcut = { code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
type KeyEventLike = Event & { code?: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean; repeat?: boolean };

/** The commands that act for the toolbar button instead of firing onCommand. */
export const EXECUTE_ACTION = new Set(["_execute_action", "_execute_browser_action", "_execute_page_action"]);

/** Chrome's key names, as KeyboardEvent.code names them. Letters and digits are handled on their own. */
const KEYS: Readonly<Record<string, string>> = {
  Comma: "Comma", Period: "Period", Space: "Space", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Insert: "Insert", Delete: "Delete", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight",
  MediaNextTrack: "MediaTrackNext", MediaPreviousTrack: "MediaTrackPrevious", MediaPlayPause: "MediaPlayPause", MediaStop: "MediaStop",
};

/** This browser's platform as manifest commands name it. */
export function commandPlatform(platform = globalThis.navigator?.platform ?? ""): string {
  return /^Mac/i.test(platform) ? "mac" : /^Win/i.test(platform) ? "windows" : /CrOS/i.test(platform) ? "chromeos" : "linux";
}

/**
 * A suggested key such as "Ctrl+Shift+Y", for a platform. On a Mac, Ctrl means Command and MacCtrl means Control, as
 * in Chrome. Undefined for a key this can't listen for.
 */
export function parseShortcut(text: string, platform: string): Shortcut | undefined {
  const shortcut: Shortcut = { code: "", ctrl: false, alt: false, shift: false, meta: false };
  for (const part of text.split("+").map((piece) => piece.trim())) {
    if (part === "Ctrl") shortcut[platform === "mac" ? "meta" : "ctrl"] = true;
    else if (part === "MacCtrl") shortcut.ctrl = true;
    else if (part === "Command") shortcut.meta = true;
    else if (part === "Alt") shortcut.alt = true;
    else if (part === "Shift") shortcut.shift = true;
    else if (/^[A-Z]$/.test(part)) shortcut.code = `Key${part}`;
    else if (/^\d$/.test(part)) shortcut.code = `Digit${part}`;
    else if (/^F([1-9]|1[0-2])$/.test(part)) shortcut.code = part;
    else if (KEYS[part]) shortcut.code = KEYS[part];
    else return undefined;
  }
  return shortcut.code ? shortcut : undefined;
}

function matches(event: KeyEventLike, shortcut: Shortcut): boolean {
  return event.code === shortcut.code && !!event.ctrlKey === shortcut.ctrl && !!event.altKey === shortcut.alt && !!event.shiftKey === shortcut.shift && !!event.metaKey === shortcut.meta;
}

/** The shortcut each command has on this platform. */
function shortcuts(config: RuntimeConfig, platform: string): Array<[name: string, shortcut: Shortcut]> {
  return Object.entries(config.commands ?? {}).flatMap(([name, command]) => {
    const text = command.keys[platform] ?? command.keys.default;
    const shortcut = text === undefined ? undefined : parseShortcut(text, platform);
    return shortcut ? [[name, shortcut] as [string, Shortcut]] : [];
  });
}

/** Listens on this page for the extension's shortcuts. A shortcut is the extension's, so the page doesn't see it. */
export function listenForCommands(target: EventTarget, config: RuntimeConfig, emit: (type: string, data: unknown) => Promise<void>, log: Logger, platform = commandPlatform()): void {
  const wanted = shortcuts(config, platform);
  if (wanted.length === 0) return;
  target.addEventListener(
    "keydown",
    (event) => {
      const key = event as KeyEventLike;
      const found = wanted.find(([, shortcut]) => matches(key, shortcut));
      if (!found) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!key.repeat) void emit("command", { name: found[0] }).catch((error: unknown) => log.error(error));
    },
    true,
  );
}

/** chrome.commands for the background: getAll from the manifest, and onCommand for what pages report. */
export function createCommands(config: RuntimeConfig, log: Logger, platform = commandPlatform()) {
  const onCommand = createEvent<(name: string, tab: unknown) => void>(log);
  const onChanged = createEvent<(change: unknown) => void>(log);
  return {
    api: {
      getAll: method(log, async () =>
        Object.entries(config.commands ?? {}).map(([name, command]) => ({
          name,
          description: command.description ?? "",
          shortcut: command.keys[platform] ?? command.keys.default ?? "",
        })),
      ),
      onCommand: onCommand.event,
      // Shortcuts can't be changed here, so this never fires.
      onChanged: onChanged.event,
    },
    fire(name: string, tab: unknown) {
      onCommand.dispatch(name, tab);
    },
  };
}
```

- [ ] **Step 4: Wire it in, and report shortcuts as partial.** In `src/runtime/background.ts`:

1. Replace:

```ts
import { createEvent, createLogger, method, readLastError, withFallback, type Logger } from "./chrome.ts";
```

with:

```ts
import { createEvent, createLogger, method, readLastError, withFallback, type Logger } from "./chrome.ts";
import { createCommands, EXECUTE_ACTION } from "./commands.ts";
```

2. Replace:

```ts
  messaging.onEvent("action-click", (_data, sender) => menus.actionClick(sender.tab));
```

with:

```ts
  messaging.onEvent("action-click", (_data, sender) => menus.actionClick(sender.tab));
  const commands = createCommands(config, log);
  messaging.onEvent("command", (data, sender) => {
    const { name } = data as { name: string };
    // _execute_action opens the popup when there is one (not converted yet), and clicks the button otherwise.
    if (!EXECUTE_ACTION.has(name)) commands.fire(name, sender.tab);
    else if (!config.action?.popup) menus.actionClick(sender.tab);
  });
```

3. Replace:

```ts
    alarms: withFallback(log, "alarms", alarms.api, "all"),
```

with:

```ts
    alarms: withFallback(log, "alarms", alarms.api, "all"),
    commands: withFallback(log, "commands", commands.api, "all"),
```

In `src/runtime/index.ts`:

1. Replace:

```ts
import { createMessaging } from "./messaging.ts";
```

with:

```ts
import { createMessaging } from "./messaging.ts";
import { listenForCommands } from "./commands.ts";
```

2. Replace:

```ts
    // Without a background, a message for it fails at once instead of waiting for one to start.
    if (!background) messaging.setBackgroundReady(true);
```

with:

```ts
    // Without a background, a message for it fails at once instead of waiting for one to start.
    if (!background) messaging.setBackgroundReady(true);
    // The manifest's keyboard shortcuts, in every frame: a shortcut pressed before this page has joined waits for it.
    else listenForCommands(window, config, messaging.emit, log);
```

In `src/convert/support.ts`:

Delete:

```ts
  commands: { reason: "keyboard shortcuts aren't converted yet", context: "background" },
```

In `src/convert/analyze.ts`:

Replace:

```ts
  // The network shim reaches these hosts through gm.xmlHttpRequest, in the background and in content scripts.
```

with:

```ts
  if (Object.keys(model.commands).length > 0) add("manifest.commands", "partial", "shortcuts work only while a page the userscript runs on has focus", "background");
  // The network shim reaches these hosts through gm.xmlHttpRequest, in the background and in content scripts.
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:file -- test/unit/commands.test.ts test/unit/analyze.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check, run everything, and commit**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; every unit test passes (321 in the prototype).

```bash
git add src/runtime/commands.ts src/runtime/background.ts src/runtime/index.ts src/convert/support.ts src/convert/analyze.ts test/unit/commands.test.ts test/unit/analyze.test.ts
git commit -m "Hear the manifest's keyboard shortcuts on each page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Notifications, cookies, permissions, windows and getBackgroundPage

**Files:**
- Create: `src/runtime/notifications.ts`, `src/runtime/cookies.ts`, `src/runtime/permissions.ts`, `src/runtime/windows.ts`
- Modify:
  - `src/runtime/assets.ts` (`dataUrl`);
  - `src/convert/assets.ts` (the manifest's icons, with a background);
  - `src/runtime/keys.ts` (`permissions`);
  - `src/runtime/background.ts`.
- Test: `test/unit/small-apis.test.ts`

**Interfaces:**
- Consumes: `gm.notification`, `gm.cookie` (Plan 1); `RuntimeConfig.permissions` (Task 1); the tabs API's `query` and `create` (Plan 3).
- Produces:
  - **`Assets.dataUrl(path): string | undefined`.**
  - **`keys(ns).permissions`.**
  - **The modules:**
    - `createNotifications({ gm, log, dataUrl })`;
    - `createCookies(gm, log)`;
    - `createPermissions(gm, ns, log, config)`, which resolves;
    - `createWindows(tabs, log)`.
  - **`getBackgroundPage`:** `runtime.getBackgroundPage()` and `extension.getBackgroundPage()` in the background.

- [ ] **Step 1: Write the failing test** `test/unit/small-apis.test.ts`

```ts
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/small-apis.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Give notifications their icons as data: URLs.** In `src/runtime/assets.ts`:

Replace:

```ts
    text: (path: string) => (table[path] ? new TextDecoder().decode(decode(table[path][1])) : undefined),
```

with:

```ts
    text: (path: string) => (table[path] ? new TextDecoder().decode(decode(table[path][1])) : undefined),
    /** The file as a data: URL, for a consumer outside the page that can't load its blob: URLs (a manager's notification). */
    dataUrl: (path: string) => {
      const entry = table[toPath(path)];
      return entry ? `data:${entry[0]};base64,${entry[1]}` : undefined;
    },
```

In `src/convert/assets.ts`:

1. Replace:

```ts
  for (const resource of model.webAccessibleResources) {
```

with:

```ts
  // The extension's icons, which its notifications usually show.
  for (const path of Object.values(model.icons)) include(path, "icons");
  for (const resource of model.webAccessibleResources) {
```

2. Replace:

```ts
// The asset table (spec §3.6): the extension files the runtime can hand out as blob: URLs. Collected from getURL string
// literals in the content scripts, url() in their CSS, and web_accessible_resources; minus --ignore-assets globs.
```

with:

```ts
// The asset table (spec §3.6): the extension files the runtime can hand out as blob: URLs. Collected from getURL string
// literals, url() in content CSS, the manifest's icons and web_accessible_resources; minus --ignore-assets globs.
```

3. Replace:

```ts
  // The extension's icons, which its notifications usually show.
  for (const path of Object.values(model.icons)) include(path, "icons");
```

with:

```ts
  // The extension's icons, which a background's notifications usually show.
  if (model.background) for (const path of Object.values(model.icons)) include(path, "icons");
```

4. Replace:

```ts
// literals, url() in content CSS, the manifest's icons and web_accessible_resources; minus --ignore-assets globs.
```

with:

```ts
// literals, url() in content CSS, the manifest's icons (when there is a background) and web_accessible_resources; minus
// --ignore-assets globs.
```

- [ ] **Step 4: Write the four modules**

```ts
// chrome.notifications (spec §5.2) through gm.notification, on the leader's tab. A notification's text is its message,
// context message and list items; its icon is an extension file or a URL.
// Ceilings: a shown notification can't be taken back, so clear and update only forget it; buttons and progress don't
// show, so onButtonClicked never fires; a click reaches onClicked only while the leader's tab is open.
import { createEvent, method, type Logger } from "./chrome.ts";
import type { Gm } from "./gm.ts";

type Options = {
  type?: string;
  iconUrl?: string;
  title?: string;
  message?: string;
  contextMessage?: string;
  items?: Array<{ title: string; message: string }>;
};

export function createNotifications(deps: { gm: Gm; log: Logger; dataUrl(path: string): string | undefined }) {
  const { log } = deps;
  const onClicked = createEvent<(id: string) => void>(log);
  const onClosed = createEvent<(id: string, byUser: boolean) => void>(log);
  const onButtonClicked = createEvent<(id: string, button: number) => void>(log);
  const onPermissionLevelChanged = createEvent<(level: string) => void>(log);
  const shown = new Map<string, Options>();

  /** An extension path becomes a data: URL the manager can load; a URL stays as it is. */
  const image = (url?: string) => (url === undefined ? undefined : /^(?:https?|data|blob):/i.test(url) ? url : (deps.dataUrl(url.replace(/^chrome-extension:\/\/[^/]+\//, "")) ?? undefined));

  const show = async (id: string, options: Options) => {
    shown.set(id, options);
    const text = [options.message, options.contextMessage, ...(options.items ?? []).map((item) => `${item.title}: ${item.message}`)].filter(Boolean).join("\n");
    await deps.gm.notification({
      title: options.title ?? "",
      text: text || " ",
      image: image(options.iconUrl),
      onclick: () => onClicked.dispatch(id),
      ondone: () => {
        if (shown.delete(id)) onClosed.dispatch(id, true);
      },
    });
    return id;
  };

  /** create([id], options): Chrome's optional first argument; a new id when there is none. */
  const create = (...args: unknown[]) => {
    const [id, options] = typeof args[0] === "string" ? [args[0], (args[1] ?? {}) as Options] : [crypto.randomUUID(), (args[0] ?? {}) as Options];
    return show(id, options);
  };

  return {
    TemplateType: { BASIC: "basic", IMAGE: "image", LIST: "list", PROGRESS: "progress" },
    PermissionLevel: { GRANTED: "granted", DENIED: "denied" },
    create: method(log, create),
    update: method(log, async (id: string, options: Options = {}) => {
      const previous = shown.get(id);
      if (!previous) return false;
      await show(id, { ...previous, ...options });
      return true;
    }),
    clear: method(log, async (id: string) => shown.delete(id)),
    getAll: method(log, async () => Object.fromEntries([...shown.keys()].map((id) => [id, true]))),
    getPermissionLevel: method(log, async () => "granted"),
    onClicked: onClicked.event,
    onClosed: onClosed.event,
    onButtonClicked: onButtonClicked.event,
    onPermissionLevelChanged: onPermissionLevelChanged.event,
  };
}
```

```ts
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
```

```ts
// chrome.permissions (spec §5.2): answers come from the manifest. A userscript can't ask the user, so request grants
// any permission the manifest lists as optional; grants and removals of optional permissions persist in a GM value.
// Ceiling: the network shim reaches optional hosts whether or not they were granted.
import { createEvent, method, type Logger } from "./chrome.ts";
import type { RuntimeConfig } from "./config.ts";
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";
import { urlMatches } from "./match.ts";

type Set_ = { permissions?: string[]; origins?: string[] };
type Granted = { permissions: string[]; origins: string[] };

/** A URL a match pattern matches, to test whether other patterns cover it. */
const sample = (pattern: string) =>
  pattern === "<all_urls>" ? "https://a.example/" : pattern.replace(/^\*:/, "https:").replace(/:\/\/\*\./, "://").replace(/:\/\/\*(?=[/:])/, "://a.example").replace(/\*/g, "");

/** Whether the patterns cover a pattern: the same one, or one that matches it. */
function covers(patterns: readonly string[], pattern: string): boolean {
  if (patterns.includes(pattern) || patterns.includes("<all_urls>")) return true;
  try {
    return urlMatches(sample(pattern), patterns);
  } catch {
    return false;
  }
}

export async function createPermissions(gm: Gm, ns: string, log: Logger, config: RuntimeConfig) {
  const key = keys(ns).permissions;
  const declared = config.permissions ?? { api: [], optionalApi: [], origins: [], optionalOrigins: [] };
  const onAdded = createEvent<(permissions: Set_) => void>(log);
  const onRemoved = createEvent<(permissions: Set_) => void>(log);
  const stored = await gm.getValue<Granted>(key);
  const granted: Granted = { permissions: stored?.permissions ?? [], origins: stored?.origins ?? [] };
  const effective = () => ({ permissions: [...new Set([...declared.api, ...granted.permissions])], origins: [...new Set([...declared.origins, ...granted.origins])] });
  const save = () => gm.setValue(key, granted);

  const contains = async ({ permissions = [], origins = [] }: Set_ = {}) => {
    const now = effective();
    return permissions.every((name) => now.permissions.includes(name)) && origins.every((origin) => covers(now.origins, origin));
  };

  return {
    contains: method(log, contains),
    getAll: method(log, async () => effective()),
    request: method(log, async ({ permissions = [], origins = [] }: Set_ = {}) => {
      const allowed = permissions.every((name) => declared.api.includes(name) || declared.optionalApi.includes(name)) && origins.every((origin) => covers([...declared.origins, ...declared.optionalOrigins], origin));
      if (!allowed) throw new Error("Only permissions specified in the manifest may be requested.");
      const now = effective();
      const added = { permissions: permissions.filter((name) => !now.permissions.includes(name)), origins: origins.filter((origin) => !covers(now.origins, origin)) };
      if (added.permissions.length + added.origins.length > 0) {
        granted.permissions.push(...added.permissions);
        granted.origins.push(...added.origins);
        await save();
        onAdded.dispatch(added);
      }
      return true;
    }),
    remove: method(log, async ({ permissions = [], origins = [] }: Set_ = {}) => {
      if (permissions.some((name) => declared.api.includes(name)) || origins.some((origin) => declared.origins.includes(origin))) throw new Error("You cannot remove required permissions.");
      const removed = { permissions: permissions.filter((name) => granted.permissions.includes(name)), origins: origins.filter((origin) => granted.origins.includes(origin)) };
      if (removed.permissions.length + removed.origins.length === 0) return false;
      granted.permissions = granted.permissions.filter((name) => !removed.permissions.includes(name));
      granted.origins = granted.origins.filter((origin) => !removed.origins.includes(origin));
      await save();
      onRemoved.dispatch(removed);
      return true;
    }),
    onAdded: onAdded.event,
    onRemoved: onRemoved.event,
  };
}
```

```ts
// chrome.windows (spec §5.2): one synthetic window, id 1, holding every tab (chrome.tabs does the same).
// Ceilings: a window can't be moved, resized or closed; create opens its URLs as tabs; the events never fire.
import { createEvent, method, type Logger } from "./chrome.ts";
import { WINDOW_ID } from "./tabs.ts";

type QueryOptions = { populate?: boolean };
type TabsApi = { query(query: object): Promise<unknown>; create(properties: { url?: string; active?: boolean }): Promise<unknown> };

export function createWindows(tabs: TabsApi, log: Logger) {
  const window = async (options: QueryOptions = {}) => ({
    id: WINDOW_ID,
    focused: typeof document !== "undefined" && document.hasFocus(),
    top: globalThis.screenY ?? 0,
    left: globalThis.screenX ?? 0,
    width: globalThis.outerWidth ?? 0,
    height: globalThis.outerHeight ?? 0,
    incognito: false,
    type: "normal",
    state: "normal",
    alwaysOnTop: false,
    ...(options.populate ? { tabs: await tabs.query({}) } : {}),
  });
  const get = async (id: number, options?: QueryOptions) => {
    if (id !== WINDOW_ID && id !== -2) throw new Error(`No window with id: ${id}.`);
    return window(options);
  };
  const event = () => createEvent<(...args: unknown[]) => void>(log).event;

  return {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    CreateType: { NORMAL: "normal", POPUP: "popup", PANEL: "panel" },
    WindowType: { NORMAL: "normal", POPUP: "popup", PANEL: "panel", APP: "app", DEVTOOLS: "devtools" },
    WindowState: { NORMAL: "normal", MINIMIZED: "minimized", MAXIMIZED: "maximized", FULLSCREEN: "fullscreen", LOCKED_FULLSCREEN: "locked-fullscreen" },
    get: method(log, get),
    getCurrent: method(log, (options?: QueryOptions) => window(options)),
    getLastFocused: method(log, (options?: QueryOptions) => window(options)),
    getAll: method(log, async (options?: QueryOptions) => [await window(options)]),
    create: method(log, async (data: { url?: string | string[]; focused?: boolean } = {}) => {
      for (const url of typeof data.url === "string" ? [data.url] : (data.url ?? [])) await tabs.create({ url, active: data.focused ?? true });
      return window({ populate: true });
    }),
    update: method(log, (id: number) => get(id)),
    remove: method(log, async () => {
      throw new Error("ext2userscript: a userscript can't close the browser window");
    }),
    onCreated: event(),
    onRemoved: event(),
    onFocusChanged: event(),
    onBoundsChanged: event(),
  };
}
```

- [ ] **Step 5: Wire them in.** In `src/runtime/keys.ts`:

Replace:

```ts
    menus: `x2u:${ns}:menus`,
```

with:

```ts
    menus: `x2u:${ns}:menus`,
    /** Optional permissions chrome.permissions.request granted, and not removed since. */
    permissions: `x2u:${ns}:permissions`,
```

In `src/runtime/background.ts`:

1. Replace:

```ts
import { createCommands, EXECUTE_ACTION } from "./commands.ts";
```

with:

```ts
import { createCommands, EXECUTE_ACTION } from "./commands.ts";
import { createCookies } from "./cookies.ts";
```

2. Replace:

```ts
import { createNetwork } from "./net.ts";
```

with:

```ts
import { createNetwork } from "./net.ts";
import { createNotifications } from "./notifications.ts";
import { createPermissions } from "./permissions.ts";
```

3. Replace:

```ts
import { REGISTRY_TIMING } from "./registry.ts";
```

with:

```ts
import { REGISTRY_TIMING } from "./registry.ts";
import { createWindows } from "./windows.ts";
```

4. Replace:

```ts
  const onInstalled = createEvent<(details: object) => void>(log);
```

with:

```ts
  const permissions = await createPermissions(gm, config.ns, log, config);
  // The background's global object, for getBackgroundPage; it exists once the code below has made it.
  let backgroundGlobal: unknown;
  const onInstalled = createEvent<(details: object) => void>(log);
```

5. Replace:

```ts
    setUninstallURL: method(log, async () => {}),
    ...structuredClone(RUNTIME_ENUMS),
  }, "all");
  const extension = withFallback(log, "extension", {
    getURL,
```

with:

```ts
    setUninstallURL: method(log, async () => {}),
    getBackgroundPage: method(log, async () => backgroundGlobal),
    ...structuredClone(RUNTIME_ENUMS),
  }, "all");
  const extension = withFallback(log, "extension", {
    getURL,
    getBackgroundPage: () => backgroundGlobal,
```

6. Replace:

```ts
    commands: withFallback(log, "commands", commands.api, "all"),
```

with:

```ts
    commands: withFallback(log, "commands", commands.api, "all"),
    notifications: withFallback(log, "notifications", createNotifications({ gm, log, dataUrl: assets.dataUrl }), "all"),
    cookies: withFallback(log, "cookies", createCookies(gm, log), "all"),
    permissions: withFallback(log, "permissions", permissions, "all"),
    windows: withFallback(log, "windows", createWindows(deps.tabs as Parameters<typeof createWindows>[0], log), "all"),
```

7. Replace:

```ts
  const { global, fire } = createBackgroundGlobal({ chrome, browser: chrome, importScripts, localStorage, fetch: network.fetch, XMLHttpRequest });
```

with:

```ts
  const { global, fire } = createBackgroundGlobal({ chrome, browser: chrome, importScripts, localStorage, fetch: network.fetch, XMLHttpRequest });
  backgroundGlobal = global;
```

- [ ] **Step 6: Run the tests**

Run: `npm run test:file -- test/unit/small-apis.test.ts test/unit/assets.test.ts test/unit/convert.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check, run everything, and commit**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; every unit test passes (327 in the prototype).

```bash
git add src/runtime/notifications.ts src/runtime/cookies.ts src/runtime/permissions.ts src/runtime/windows.ts src/runtime/assets.ts src/convert/assets.ts src/runtime/keys.ts src/runtime/background.ts test/unit/small-apis.test.ts
git commit -m "Add notifications, cookies, permissions, windows and getBackgroundPage" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Scripting

**Files:**
- Create: `src/runtime/scripting.ts`
- Modify:
  - `src/runtime/content.ts` (`withGlobals` is exported and returns its function's result);
  - `src/runtime/config.ts` (`InjectableCode`).
- Modify:
  - `src/convert/scan.ts` (`files`: paths of scripts and style sheets);
  - `src/convert/emit.ts` (injectable files as a fourth argument to `start`);
  - `src/convert/index.ts` (collects them).
- Modify: `src/runtime/index.ts` (the tab's injector answers control requests), `src/runtime/background.ts` (`chrome.scripting`, and the MV2 members on `chrome.tabs`)
- Test: `test/unit/scripting.test.ts`

**Interfaces:**
- Consumes: `messaging.control` (Plan 3); `Network` (Task 2); `Assets.text` (Plan 2).
- Produces:
  - **`content.ts`:** `withGlobals<T>(chrome, fn: () => T): T`.
  - **`config.ts`:** `type InjectableCode = Record<string, (chrome, browser, fetch, XMLHttpRequest) => () => void>`.
  - **`ScanResult.files: string[]`.**
  - **The emitted call:** `emit(header, runtime, config, code, background?, injectables?)`, and `start(config, code, background?, injectables?)`.
  - **`scripting.ts`:**
    - `createScripting({ messaging, assets, log, currentTab })`, which returns `{ scripting, tabs }`;
    - `createInjector({ gm, chrome, network, injectables, withGlobals, log })`, which returns `{ run(op, args) }`.
  - **Control requests:** `"execute"` and `"css"`.

- [ ] **Step 1: Write the failing test** `test/unit/scripting.test.ts`

```ts
// chrome.scripting and MV2's tabs.executeScript: the background's requests, and the tab running them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withGlobals } from "../../src/runtime/content.ts";
import { createLogger } from "../../src/runtime/chrome.ts";
import { createGm } from "../../src/runtime/gm.ts";
import type { Messaging } from "../../src/runtime/messaging.ts";
import type { Network } from "../../src/runtime/net.ts";
import { createInjector, createScripting } from "../../src/runtime/scripting.ts";

type Api = Record<string, (...args: unknown[]) => Promise<unknown>>;
const log = createLogger("test");

/** The background's side, over a fake control channel that answers with `answer` and records what it was asked. */
function background(answer: unknown = "done") {
  const sent: unknown[][] = [];
  const messaging = { control: async (tabId: number, op: string, args: unknown) => (sent.push([tabId, op, args]), answer) } as unknown as Messaging;
  const scripting = createScripting({ messaging, assets: { text: (path) => (path === "css/a.css" ? "a { color: red }" : undefined) }, log, currentTab: async () => 9 });
  return { sent, scripting: scripting.scripting as unknown as Api, tabs: scripting.tabs as unknown as Api };
}

describe("createScripting", () => {
  it("sends a function's source and arguments to the target tab, and answers with Chrome's result list", async () => {
    const { sent, scripting } = background(42);
    const results = await scripting.executeScript({ target: { tabId: 3 }, func: (a: number, b: number) => a + b, args: [1, 2] });
    assert.deepEqual(results, [{ frameId: 0, result: 42 }]);
    // Node's type stripping leaves spaces where the annotations were, so the source is compared without them.
    const request = sent[0][2] as { func: string };
    assert.deepEqual([sent[0][0], sent[0][1], { ...request, func: request.func.replace(/\s+/g, "") }], [3, "execute", { func: "(a,b)=>a+b", args: [1, 2], world: "ISOLATED" }]);
    await scripting.executeScript({ target: { tabId: 3 }, files: ["inject.js"], world: "MAIN" });
    assert.deepEqual(sent[1], [3, "execute", { files: ["inject.js"], world: "MAIN" }]);
  });

  it("sends CSS text, reading files from the asset table", async () => {
    const { sent, scripting } = background();
    await scripting.insertCSS({ target: { tabId: 4 }, files: ["css/a.css"] });
    await scripting.removeCSS({ target: { tabId: 4 }, css: "b {}" });
    assert.deepEqual(sent, [[4, "css", { css: "\na { color: red }", remove: false }], [4, "css", { css: "b {}", remove: true }]]);
  });

  it("gives MV2's tabs.executeScript the current tab when no id is given, and a plain result list", async () => {
    const { sent, tabs } = background("title");
    assert.deepEqual(await tabs.executeScript({ code: "document.title" }), ["title"]);
    assert.deepEqual(sent, [[9, "execute", { code: "document.title", world: "ISOLATED" }]]);
  });
});

describe("createInjector", () => {
  const chrome = { runtime: { id: "ext" } };
  const network = { fetch: async () => new Response(""), XMLHttpRequest: class {} } as unknown as Network;
  const injector = (injectables = {}) => createInjector({ gm: createGm({}), chrome, network, injectables, withGlobals, log });

  it("runs a bundled file like a content script, with this tab's chrome object", async () => {
    const seen: unknown[] = [];
    const run = injector({ "inject.js": (c: unknown) => () => void seen.push(c, (globalThis as { chrome?: unknown }).chrome) }).run("execute", { files: ["/inject.js"], world: "ISOLATED" });
    assert.equal(await run, null);
    assert.deepEqual(seen, [chrome, chrome]);
    await assert.rejects(injector().run("execute", { files: ["missing.js"], world: "ISOLATED" }) as Promise<unknown>, /Could not load file: 'missing\.js'/);
  });

  it("runs a function's source with its arguments and chrome, waiting for a promise", async () => {
    const run = injector().run("execute", { func: "async (n) => chrome.runtime.id + n", args: [1], world: "ISOLATED" });
    assert.equal(await run, "ext1");
  });

  it("evaluates MV2 code to its last value, with chrome as a global", async () => {
    assert.equal(await injector().run("execute", { code: "var x = 2; chrome.runtime.id + x", world: "ISOLATED" }), "ext2");
    assert.equal(injector().run("navigate", {}), undefined);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:file -- test/unit/scripting.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Export withGlobals, and name the injectable code's type.** In `src/runtime/content.ts`:

1. Replace:

```ts
function withGlobals(chrome: object, fn: () => void): void {
```

with:

```ts
/** Runs fn with globalThis.chrome and globalThis.browser set to this extension's chrome object, for libraries that look there. */
export function withGlobals<T>(chrome: object, fn: () => T): T {
```

2. Replace:

```ts
  try {
    fn();
  } finally {
```

with:

```ts
  try {
    return fn();
  } finally {
```

In `src/runtime/config.ts`:

Replace:

```ts
export type GroupCode = ((chrome: unknown, browser: unknown, fetch: unknown, XMLHttpRequest: unknown) => () => void) | string | null;
```

with:

```ts
export type GroupCode = ((chrome: unknown, browser: unknown, fetch: unknown, XMLHttpRequest: unknown) => () => void) | string | null;

/** Extension files the background may inject with scripting.executeScript({ files }), by path, as content-script factories. */
export type InjectableCode = Record<string, (chrome: unknown, browser: unknown, fetch: unknown, XMLHttpRequest: unknown) => () => void>;
```

- [ ] **Step 4: Write `src/runtime/scripting.ts`**

```ts
// chrome.scripting and MV2's tabs.executeScript / insertCSS / removeCSS (spec §5.2): the background sends the work to
// the target tab as a control request, and the tab runs it.
// - files: the converter bundled the extension files the background names, so they run like content scripts.
// - func (and MV2's code): its source runs through new Function (or eval), with this tab's chrome object. That is the
//   one place the runtime evaluates extension code, as a function's source is all there is to send. Where the page's
//   CSP forbids eval (Tampermonkey's sandbox follows it), the function runs in the page's world instead, through
//   gm.addElement, without chrome.*.
// - CSS goes in as a <style> through gm.addElement, and removeCSS takes out the same text.
// Ceilings: only the tab's top frame; a file's result is null (its completion value can't be read without eval); MV2
// code that can't be evaluated runs in the page's world with a null result.
import type { Assets } from "./assets.ts";
import { method, type Logger } from "./chrome.ts";
import type { InjectableCode } from "./config.ts";
import type { Gm } from "./gm.ts";
import type { Messaging } from "./messaging.ts";
import type { Network } from "./net.ts";

type Target = { tabId: number; frameIds?: number[]; allFrames?: boolean };
type ExecuteDetails = { target: Target; func?: (...args: unknown[]) => unknown; args?: unknown[]; files?: string[]; world?: "ISOLATED" | "MAIN" };
type CssDetails = { target: Target; css?: string; files?: string[] };
type ExecuteRequest = { files?: string[]; func?: string; args?: unknown[]; code?: string; world: "ISOLATED" | "MAIN" };

/** The background's side: chrome.scripting, and the MV2 members on chrome.tabs. */
export function createScripting(deps: { messaging: Messaging; assets: Pick<Assets, "text">; log: Logger; currentTab(): Promise<number | undefined> }) {
  const { messaging, log } = deps;
  const run = async (tabId: number, request: ExecuteRequest) => [{ frameId: 0, result: (await messaging.control(tabId, "execute", request)) ?? null }];
  const cssText = (details: { css?: string; files?: string[]; code?: string; file?: string }) =>
    [details.css ?? details.code ?? "", ...[...(details.files ?? []), ...(details.file ? [details.file] : [])].map((path) => deps.assets.text(path.replace(/^\/+/, "")) ?? "")].join("\n");
  const css = (tabId: number, text: string, remove: boolean) => messaging.control(tabId, "css", { css: text, remove });
  /** tabs.executeScript([tabId], details): the current tab when there is no id. */
  const tabArgs = async (args: unknown[]) => {
    const [tabId, details] = typeof args[0] === "number" ? [args[0], args[1]] : [await deps.currentTab(), args[0]];
    if (tabId === undefined) throw new Error("No tab to inject into");
    return [tabId, (details ?? {}) as { code?: string; file?: string }] as const;
  };

  return {
    scripting: {
      ExecutionWorld: { ISOLATED: "ISOLATED", MAIN: "MAIN" },
      StyleOrigin: { AUTHOR: "AUTHOR", USER: "USER" },
      executeScript: method(log, (details: ExecuteDetails) =>
        run(details.target.tabId, {
          ...(details.files ? { files: details.files } : {}),
          ...(details.func ? { func: details.func.toString(), args: details.args ?? [] } : {}),
          world: details.world ?? "ISOLATED",
        }),
      ),
      insertCSS: method(log, async (details: CssDetails) => void (await css(details.target.tabId, cssText(details), false))),
      removeCSS: method(log, async (details: CssDetails) => void (await css(details.target.tabId, cssText(details), true))),
    },
    tabs: {
      executeScript: method(log, async (...args: unknown[]) => {
        const [tabId, details] = await tabArgs(args);
        const result = await run(tabId, { ...(details.code !== undefined ? { code: details.code } : {}), ...(details.file ? { files: [details.file] } : {}), world: "ISOLATED" });
        return result.map((entry) => entry.result);
      }),
      insertCSS: method(log, async (...args: unknown[]) => {
        const [tabId, details] = await tabArgs(args);
        await css(tabId, cssText(details), false);
      }),
      removeCSS: method(log, async (...args: unknown[]) => {
        const [tabId, details] = await tabArgs(args);
        await css(tabId, cssText(details), true);
      }),
    },
  };
}

/** The tab's side: runs what the background sent. */
export function createInjector(deps: { gm: Gm; chrome: object; network: Network; injectables: InjectableCode; withGlobals<T>(chrome: object, run: () => T): T; log: Logger }) {
  const { gm, log } = deps;
  const root = () => document.head ?? document.documentElement;
  const styles = new Map<string, Element[]>();

  /** Runs source in the page's world through gm.addElement, which gets past the page's CSP; resolves with its result. */
  const inPage = async (expression: string): Promise<unknown> => {
    const source = `(function () {
  var script = document.currentScript;
  script.setAttribute("data-ran", "");
  function done(key, value) { script.setAttribute(key, JSON.stringify(value === undefined ? null : value)); script.dispatchEvent(new Event("x2u-done")); }
  try {
    var result = ${expression};
    if (result && typeof result.then === "function") result.then(function (value) { done("data-result", value); }, function (error) { done("data-error", String(error && error.message || error)); });
    else done("data-result", result);
  } catch (error) { done("data-error", String(error && error.message || error)); }
})();`;
    const element = await gm.addElement(root(), "script", { textContent: source });
    // The script runs as it goes in; one that didn't run was blocked, and one with a promise result finishes later.
    if (!element.hasAttribute("data-ran")) {
      element.remove();
      throw new Error("ext2userscript: the page blocked the script executeScript put in it");
    }
    if (!element.hasAttribute("data-result") && !element.hasAttribute("data-error")) await new Promise((resolve) => element.addEventListener("x2u-done", resolve, { once: true }));
    element.remove();
    const error = element.getAttribute("data-error");
    if (error !== null) throw new Error(JSON.parse(error) as string);
    return JSON.parse(element.getAttribute("data-result") ?? "null");
  };

  const isEvalBlocked = (error: unknown) => error instanceof EvalError || (error instanceof Error && /Content Security Policy|unsafe-eval/.test(error.message));

  const execute = async (request: ExecuteRequest): Promise<unknown> => {
    for (const path of request.files ?? []) {
      const factory = deps.injectables[path.replace(/^\/+/, "")];
      if (!factory) throw new Error(`Could not load file: '${path}'.`);
      if (request.world === "MAIN") await inPage(`(${factory.toString()})(undefined, undefined, window.fetch, window.XMLHttpRequest)()`);
      else deps.withGlobals(deps.chrome, factory(deps.chrome, deps.chrome, deps.network.fetch, deps.network.XMLHttpRequest));
    }
    if (request.func !== undefined) {
      const args = request.args ?? [];
      const inPageWorld = () => inPage(`(${request.func})(...${JSON.stringify(args)})`);
      if (request.world === "MAIN") return inPageWorld();
      let fn: (...args: unknown[]) => unknown;
      try {
        fn = new Function("chrome", "browser", "fetch", "XMLHttpRequest", `return (${request.func});`)(deps.chrome, deps.chrome, deps.network.fetch, deps.network.XMLHttpRequest);
      } catch (error) {
        if (!isEvalBlocked(error)) throw error;
        log.once("scripting-eval", "this page's CSP forbids eval, so executeScript's function runs in the page's world, without chrome.*");
        return inPageWorld();
      }
      return await deps.withGlobals(deps.chrome, () => fn(...args));
    }
    if (request.code !== undefined) {
      try {
        return deps.withGlobals(deps.chrome, () => (0, eval)(request.code as string));
      } catch (error) {
        if (!isEvalBlocked(error)) throw error;
        log.once("scripting-eval", "this page's CSP forbids eval, so executeScript's code runs in the page's world, without chrome.*");
        await gm.addElement(root(), "script", { textContent: request.code });
        return null;
      }
    }
    return null;
  };

  const css = async ({ css: text, remove }: { css: string; remove: boolean }) => {
    if (remove) {
      for (const element of styles.get(text) ?? []) element.remove();
      styles.delete(text);
      return null;
    }
    const element = await gm.addElement(root(), "style", { textContent: text });
    styles.set(text, [...(styles.get(text) ?? []), element]);
    return null;
  };

  return {
    /** A control request this injector answers, or undefined for one it doesn't. */
    run(op: string, args: unknown): Promise<unknown> | undefined {
      if (op === "execute") return execute(args as ExecuteRequest);
      if (op === "css") return css(args as { css: string; remove: boolean });
      return undefined;
    },
  };
}
```

- [ ] **Step 5: Bundle the files a background may inject.** In `src/convert/scan.ts`:

1. Replace:

```ts
  /** String literals passed to fetch(...) (or self.fetch and the like), as written: a background's relative URLs are extension files. */
  fetches: string[];
```

with:

```ts
  /** String literals passed to fetch(...) (or self.fetch and the like), as written: a background's relative URLs are extension files. */
  fetches: string[];
  /** String literals that look like a script or style sheet's path ("content.js", "/css/a.css"): files a background may inject. */
  files: string[];
```

2. Replace:

```ts
  const result: ScanResult = { chains: [], urls: [], fetches: [], dynamicImport: false, importScripts: [], lexical: [] };
```

with:

```ts
  const result: ScanResult = { chains: [], urls: [], fetches: [], files: [], dynamicImport: false, importScripts: [], lexical: [] };
```

3. Replace:

```ts
    if (token.kind !== "name") continue;
    if (token.depth === 0
```

with:

```ts
    if (token.kind === "string" && /^\/?[\w@~.-]+(?:\/[\w@~.-]+)*\.(?:js|css)$/.test(token.value)) result.files.push(token.value);
    if (token.kind !== "name") continue;
    if (token.depth === 0
```

In `src/convert/emit.ts`:

1. Replace:

```ts
// - The background is a factory too, whose parameters shadow the globals a background reaches (spec §3.3).
```

with:

```ts
// - The background is a factory too, whose parameters shadow the globals a background reaches (spec §3.3).
// - Files the background may inject with scripting.executeScript({ files }) are content-script factories, by path.
```

2. Replace:

```ts
export function emit(header: string, runtime: string, config: RuntimeConfig, code: readonly ContentCode[], background: BackgroundBundle | null = null): string {
  const groups = code.map((group) => {
    if (group === null) return "null";
    if (group.world === "MAIN") return JSON.stringify(group.code);
    return `function (chrome, browser, fetch, XMLHttpRequest) {\nreturn function () {\n${group.code}\n};\n}`;
  });
```

with:

```ts
const factory = (code: string) => `function (chrome, browser, fetch, XMLHttpRequest) {\nreturn function () {\n${code}\n};\n}`;

export function emit(
  header: string,
  runtime: string,
  config: RuntimeConfig,
  code: readonly ContentCode[],
  background: BackgroundBundle | null = null,
  injectables: Readonly<Record<string, string>> = {},
): string {
  const groups = code.map((group) => {
    if (group === null) return "null";
    if (group.world === "MAIN") return JSON.stringify(group.code);
    return factory(group.code);
  });
  const files = Object.entries(injectables).map(([path, text]) => `${JSON.stringify(path)}: ${factory(text)}`);
```

3. Replace:

```ts
  return `${header}\n\n(function () {\n${runtime}\n__x2uRuntime.start(${JSON.stringify(config)}, [\n${groups.join(",\n")}\n], ${backgroundFactory});\n})();\n`;
```

with:

```ts
  return `${header}\n\n(function () {\n${runtime}\n__x2uRuntime.start(${JSON.stringify(config)}, [\n${groups.join(",\n")}\n], ${backgroundFactory}, {\n${files.join(",\n")}\n});\n})();\n`;
```

In `src/convert/index.ts`:

1. Replace:

```ts
  let userscript = emit(prepared.header, options.runtime, prepared.config, prepared.code, prepared.background);
```

with:

```ts
  let userscript = emit(prepared.header, options.runtime, prepared.config, prepared.code, prepared.background, prepared.injectables);
```

2. Replace:

```ts
): Promise<{ header: string; config: RuntimeConfig; code: ContentCode[]; background: BackgroundBundle | null; report: Report }> {
```

with:

```ts
): Promise<{ header: string; config: RuntimeConfig; code: ContentCode[]; background: BackgroundBundle | null; injectables: Record<string, string>; report: Report }> {
```

3. Replace:

```ts
  const getUrls = [...scans.flatMap((result) => result?.urls ?? []), ...(backgroundScan?.urls ?? []), ...backgroundFiles(backgroundScan?.fetches ?? [], background.background?.entry, files)];
```

with:

```ts
  // Files the background names that it may inject: scripts are bundled like content scripts, style sheets go in the asset table.
  const injectable = [...new Set((backgroundScan?.files ?? []).map((path) => path.replace(/^\/+/, "")))].filter((path) => files.has(path));
  const injectables = Object.fromEntries(injectable.filter((path) => path.endsWith(".js")).map((path) => [path, decodeText(files.get(path) as Uint8Array)]));
  const getUrls = [
    ...scans.flatMap((result) => result?.urls ?? []),
    ...(backgroundScan?.urls ?? []),
    ...backgroundFiles(backgroundScan?.fetches ?? [], background.background?.entry, files),
    ...injectable.filter((path) => path.endsWith(".css")),
  ];
```

4. Replace:

```ts
  return { header: renderMetadata(model, files, ns, grantsFor(methods)), config, code, background: background.background, report };
```

with:

```ts
  return { header: renderMetadata(model, files, ns, grantsFor(methods)), config, code, background: background.background, injectables, report };
```

5. Replace:

```ts
import { dirname, joinPath } from "./paths.ts";
```

with:

```ts
import { decodeText } from "./files.ts";
import { dirname, joinPath } from "./paths.ts";
```

- [ ] **Step 6: Wire it in.** In `src/runtime/index.ts`:

1. Replace:

```ts
import type { BackgroundCode, GroupCode, RuntimeConfig } from "./config.ts";
import { runContent } from "./content.ts";
```

with:

```ts
import type { BackgroundCode, GroupCode, InjectableCode, RuntimeConfig } from "./config.ts";
import { runContent, withGlobals } from "./content.ts";
```

2. Replace:

```ts
import { createNetwork } from "./net.ts";
```

with:

```ts
import { createNetwork } from "./net.ts";
import { createInjector } from "./scripting.ts";
```

3. Replace:

```ts
export function start(config: RuntimeConfig, code: readonly GroupCode[], background: BackgroundCode | null = null): void {
```

with:

```ts
export function start(config: RuntimeConfig, code: readonly GroupCode[], background: BackgroundCode | null = null, injectables: InjectableCode = {}): void {
```

4. Replace:

```ts
      control: async (op, args) => {
        if (!tabs) throw new Error("this tab isn't ready");
        return tabs.control(op, args);
      },
```

with:

```ts
      control: async (op, args) => {
        const injected = injector.run(op, args);
        if (injected) return injected;
        if (!tabs) throw new Error("this tab isn't ready");
        return tabs.control(op, args);
      },
```

5. Replace:

```ts
    runContent(config, code, { gm, chrome: { runtime, storage, i18n, extension, dom }, assets, log, network });
```

with:

```ts
    const contentChrome = { runtime, storage, i18n, extension, dom };
    // Scripts and styles the background's scripting API sends this page.
    const injector = createInjector({ gm, chrome: contentChrome, network, injectables, withGlobals, log });
    runContent(config, code, { gm, chrome: contentChrome, assets, log, network });
```

In `src/runtime/background.ts`:

1. Replace:

```ts
import { createWindows } from "./windows.ts";
```

with:

```ts
import { createScripting } from "./scripting.ts";
import { createWindows } from "./windows.ts";
```

2. Replace:

```ts
  const known: Record<string, object> = {
    runtime,
    storage: deps.storage,
    i18n: deps.i18n,
    tabs: withFallback(log, "tabs", deps.tabs, "all"),
```

with:

```ts
  const tabs = deps.tabs as { query(query: object): Promise<Array<{ id: number }>> } & Record<string, unknown>;
  const scripting = createScripting({ messaging, assets, log, currentTab: async () => (await tabs.query({ active: true }))[0]?.id });
  const known: Record<string, object> = {
    runtime,
    storage: deps.storage,
    i18n: deps.i18n,
    // MV2's tabs.executeScript, insertCSS and removeCSS sit next to the rest of chrome.tabs.
    tabs: withFallback(log, "tabs", { ...tabs, ...scripting.tabs }, "all"),
    scripting: withFallback(log, "scripting", scripting.scripting, "all"),
```

- [ ] **Step 7: Run the tests**

Run: `npm run test:file -- test/unit/scripting.test.ts test/unit/emit.test.ts test/unit/emit-background.test.ts test/unit/convert.test.ts test/unit/scan.test.ts`
Expected: PASS.

- [ ] **Step 8: Type-check, run everything, and commit**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; every unit test passes (333 in the prototype).

```bash
git add src/runtime/scripting.ts src/runtime/content.ts src/runtime/config.ts src/convert/scan.ts src/convert/emit.ts src/convert/index.ts src/runtime/index.ts src/runtime/background.ts test/unit/scripting.test.ts
git commit -m "Run scripting.executeScript and insertCSS in the target tab" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Report the new APIs, and test them end to end

**Files:**
- Modify: `src/convert/support.ts`: rows for every new API, with the GM methods they need (`notification`, `cookie`, the menu methods).
- Modify:
  - `test/unit/analyze-background.test.ts`;
  - `test/support/extension.ts` (adds `apiExtension`; `backgroundExtension`'s first line now calls an API that is still unconverted);
  - `test/browser/content-runtime.test.ts` (the extension-API suite and a page whose CSP forbids eval);
  - `README.md`.
- Test: `test/unit/analyze-background.test.ts`, `test/browser/content-runtime.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `support.ts` rows for `alarms`, `contextMenus` and `menus`, `action`, `browserAction` and `pageAction`, `commands`, `notifications`, `cookies`, `permissions`, `windows`, `scripting`, `tabs.executeScript`/`insertCSS`/`removeCSS` and `getBackgroundPage`. `test/support/extension.ts` gains `apiExtension(origin)`.

- [ ] **Step 1: Write the failing tests.** In `test/unit/analyze-background.test.ts`:

1. Replace:

```ts
chrome.alarms.create('a');
```

with:

```ts
chrome.bookmarks.create({});
```

2. Replace:

```ts
      ["chrome.alarms.create", "unsupported", "isn't converted yet"],
```

with:

```ts
      ["chrome.bookmarks.create", "unsupported", "isn't converted yet"],
```

3. Replace:

```ts
  it("flags dynamic importScripts, remote imports, a background page and persistent: true", () => {
```

with:

```ts
  it("reports the APIs this version converts, with the GM grants they need", async () => {
    const { model, files: all } = extension({ background: { service_worker: "sw.js" } }, {
      "sw.js": [
        "chrome.alarms.create('a', { periodInMinutes: 1 }); chrome.commands.getAll(); chrome.permissions.request({});",
        "chrome.contextMenus.create({}); chrome.action.setBadgeText({}); chrome.action.setIcon({});",
        "chrome.notifications.create({}); chrome.cookies.get({}); chrome.windows.getAll(); chrome.scripting.executeScript({});",
      ].join("\n"),
    });
    const result = await bundleBackground(model, all);
    const { entries, methods } = analyze(model, [], { scan: scan(result.background?.code ?? ""), bundle: result });
    assert.deepEqual(entries.map((entry) => [entry.subject, entry.status]), [
      ["chrome.alarms.create", "supported"],
      ["chrome.commands.getAll", "supported"],
      ["chrome.permissions.request", "partial"],
      ["chrome.contextMenus.create", "partial"],
      ["chrome.action.setBadgeText", "partial"],
      ["chrome.action.setIcon", "partial"],
      ["chrome.notifications.create", "supported"],
      ["chrome.cookies.get", "partial"],
      ["chrome.windows.getAll", "partial"],
      ["chrome.scripting.executeScript", "partial"],
    ]);
    assert.deepEqual([...methods].sort(), ["cookie", "notification", "registerMenuCommand", "unregisterMenuCommand"]);
  });

  it("flags dynamic importScripts, remote imports, a background page and persistent: true", () => {
```

In `test/support/extension.ts`:

1. Replace:

```ts
"sw.js": `chrome.alarms.create("tick", { periodInMinutes: 1 }).catch(() => {});
```

with:

```ts
"sw.js": `chrome.bookmarks.create({ title: "x2u" }).catch(() => {});
```

2. Replace:

```ts
// - networkExtension fetches from another origin, which sends no CORS headers, in the background and content scripts.
```

with:

```ts
// - networkExtension fetches from another origin, which sends no CORS headers, in the background and content scripts.
// - apiExtension uses alarms, context menus, the toolbar button, a shortcut, scripting, notifications, cookies,
//   permissions, windows and getBackgroundPage.
```

3. Replace:

```ts
/** Content scripts that use nothing unsupported or partial, so the report's verdict is likely-works. */
```

with:

```ts
/** origin is where the test pages are served; its page.html has a .x2u-box element and the title "x2u". */
export function apiExtension(origin: string): ExtensionFiles {
  return files({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "API Sample",
      version: "1.0.0",
      icons: { "48": "icon.png" },
      background: { service_worker: "sw.js" },
      permissions: ["alarms", "contextMenus", "notifications", "scripting", "cookies"],
      optional_permissions: ["bookmarks"],
      host_permissions: [`${origin}/*`],
      action: { default_title: "Click API Sample" },
      commands: { "run-it": { suggested_key: { default: "Alt+Shift+K" }, description: "Run it" } },
      content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"] }],
    }),
    "icon.png": PIXEL,
    "sw.js": `chrome.runtime.onInstalled.addListener(() => chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: "say", title: "Say hello" })));
chrome.alarms.create("soon", { delayInMinutes: 0.001 });
chrome.alarms.onAlarm.addListener((alarm) => chrome.storage.local.set({ alarm: alarm.name }));
chrome.contextMenus.onClicked.addListener((info, tab) => chrome.tabs.sendMessage(tab.id, { menu: info.menuItemId }));
chrome.action.onClicked.addListener((tab) => chrome.tabs.sendMessage(tab.id, { action: true }));
chrome.commands.onCommand.addListener((name, tab) => chrome.tabs.sendMessage(tab.id, { command: name }));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const target = { tabId: sender.tab.id };
  if (message === "inject") {
    chrome.scripting
      .executeScript({ target, func: (word) => { document.documentElement.dataset.injected = word; return document.title; }, args: ["yes"] })
      .then(([first]) => chrome.scripting.executeScript({ target, files: ["inject.js"] }).then(() => first.result))
      .then((title) => chrome.scripting.insertCSS({ target, css: ".x2u-box { border-top-color: rgb(4, 5, 6); }" }).then(() => sendResponse(title)));
    return true;
  }
  if (message === "apis") {
    Promise.all([
      chrome.permissions.contains({ permissions: ["bookmarks"] }),
      chrome.permissions.request({ permissions: ["bookmarks"] }).then(() => chrome.permissions.contains({ permissions: ["bookmarks"] })),
      chrome.windows.getCurrent({ populate: true }).then((window) => window.id + ":" + (window.tabs.length > 0)),
      chrome.notifications.create("hello", { type: "basic", iconUrl: "icon.png", title: "Hi", message: "There" }),
      chrome.runtime.getBackgroundPage().then((page) => page === self),
      chrome.commands.getAll().then((all) => all.map((command) => command.name).join()),
    ]).then((values) => sendResponse(values.join("|")), (error) => sendResponse("failed: " + error.message));
    return true;
  }
  if (message === "cookie") {
    chrome.cookies
      .set({ url: "${origin}/", name: "x2u", value: "baked" })
      .then(() => chrome.cookies.get({ url: "${origin}/", name: "x2u" }))
      .then((cookie) => sendResponse(cookie && cookie.value), (error) => sendResponse("failed: " + error.message));
    return true;
  }
});`,
    "inject.js": "document.documentElement.dataset.file = typeof chrome.runtime.id;",
    "content.js": `const html = document.documentElement;
chrome.runtime.onMessage.addListener((message) => {
  if (message.menu) html.dataset.menu = message.menu;
  if (message.action) html.dataset.action = "clicked";
  if (message.command) html.dataset.command = message.command;
});
chrome.runtime.sendMessage("inject").then((title) => { html.dataset.injectTitle = title; });
chrome.runtime.sendMessage("apis").then((reply) => { html.dataset.apis = reply; });
chrome.runtime.sendMessage("cookie").then((reply) => { html.dataset.cookie = reply; });
const poll = () => chrome.storage.local.get("alarm").then(({ alarm }) => (alarm ? (html.dataset.alarm = alarm) : setTimeout(poll, 200)));
poll();
`,
  });
}

/** Content scripts that use nothing unsupported or partial, so the report's verdict is likely-works. */
```

4. Replace:

```ts
      chrome.permissions.contains({ permissions: ["bookmarks"] }),
      chrome.permissions.request({ permissions: ["bookmarks"] }).then(() => chrome.permissions.contains({ permissions: ["bookmarks"] })),
```

with:

```ts
      // Granted, then removed again, so each run starts without it.
      chrome.permissions
        .request({ permissions: ["bookmarks"] })
        .then(() => chrome.permissions.contains({ permissions: ["bookmarks"] }))
        .then((granted) => chrome.permissions.remove({ permissions: ["bookmarks"] }).then(() => chrome.permissions.contains({ permissions: ["bookmarks"] })).then((kept) => granted + "/" + kept)),
```

In `test/browser/content-runtime.test.ts`:

1. Replace:

```ts
import { backgroundExtension, moduleBackgroundExtension, networkExtension, sampleExtension } from "../support/extension.ts";
```

with:

```ts
import { apiExtension, backgroundExtension, moduleBackgroundExtension, networkExtension, sampleExtension } from "../support/extension.ts";
```

2. Replace:

```ts
      await waitForAttr(tab, "data-same", "same");
    });
  });
}
```

with:

```ts
      await waitForAttr(tab, "data-same", "same");
    });
  });

  describe(`extension APIs on ${backend}`, () => {
    const { open, session } = harness(backend, apiExtension);

    it("runs scripting, alarms, permissions, windows, notifications, cookies and getBackgroundPage", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-inject-title", "x2u");
      await waitForAttr(tab, "data-injected", "yes");
      await waitForAttr(tab, "data-file", "string");
      assert.equal(await tab.locator(".x2u-box").evaluate((box) => getComputedStyle(box).borderTopColor), "rgb(4, 5, 6)");
      await waitForAttr(tab, "data-apis", "false|true|1:true|hello|true|run-it");
      await waitForAttr(tab, "data-alarm", "soon");
      await waitForAttr(tab, "data-cookie", "baked");
    });

    it("hears the manifest's shortcut on the page", async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-inject-title", "x2u");
      await tab.keyboard.press("Alt+Shift+K");
      await waitForAttr(tab, "data-command", "run-it");
    });

    it("shows context-menu items and the toolbar button as menu commands, and notifications, on the emulator", { skip: backend !== "emulator" }, async () => {
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-apis", "false|true|1:true|hello|true|run-it");
      const emulator = session().emulator;
      assert.ok(emulator);
      for (let tries = 0; tries < 50 && (await emulator.menu(tab)).length < 2; tries++) await sleep(100);
      assert.deepEqual((await emulator.menu(tab)).sort(), ["Click API Sample", "Say hello"]);
      assert.equal(await emulator.clickMenu(tab, "Say hello"), true);
      await waitForAttr(tab, "data-menu", "say");
      assert.equal(await emulator.clickMenu(tab, "Click API Sample"), true);
      await waitForAttr(tab, "data-action", "clicked");
      const shown = (await Promise.all(session().context.pages().map((page) => emulator.notifications(page)))).flat();
      assert.ok(shown.some((notification) => notification.title === "Hi" && notification.text === "There"));
    });
  });
}
```

3. Replace:

```ts
      await waitForAttr(tab, "data-apis", "false|true|1:true|hello|true|run-it");
      await waitForAttr(tab, "data-alarm", "soon");
```

with:

```ts
      await waitForAttr(tab, "data-apis", "true/false|1:true|hello|true|run-it");
      await waitForAttr(tab, "data-alarm", "soon");
```

4. Replace:

```ts
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-apis", "false|true|1:true|hello|true|run-it");
      const emulator = session().emulator;
```

with:

```ts
      const tab = await open("/page.html");
      await waitForAttr(tab, "data-inject-title", "x2u");
      const emulator = session().emulator;
```

5. Replace:

```ts
  response.headers.set("content-security-policy", "connect-src 'self'");
  return response;
};
```

with:

```ts
  response.headers.set("content-security-policy", "connect-src 'self'");
  return response;
};
/** A page whose CSP forbids eval (and inline scripts), as many sites' do. */
const strictPage = async () => {
  const response = page();
  response.headers.set("content-security-policy", "script-src 'self'; object-src 'none'");
  return response;
};
```

6. Replace:

```ts
      "/connect-strict.html": connectStrictPage,
```

with:

```ts
      "/strict.html": strictPage,
      "/connect-strict.html": connectStrictPage,
```

7. Replace:

```ts
    it("hears the manifest's shortcut on the page", async () => {
```

with:

```ts
    it("runs executeScript's function on a page whose CSP forbids eval, in the page's world if it must", async () => {
      const tab = await open("/strict.html");
      await waitForAttr(tab, "data-inject-title", "x2u");
      await waitForAttr(tab, "data-injected", "yes");
      await waitForAttr(tab, "data-file", "string");
    });

    it("hears the manifest's shortcut on the page", async () => {
```

8. Replace:

```ts
    it("runs executeScript's function on a page whose CSP forbids eval, in the page's world if it must", async () => {
```

with:

```ts
    // The emulator's addElement doesn't get past the page's CSP as the managers' does (spec §10.2), so this runs on them only.
    it("runs executeScript's function on a page whose CSP forbids eval, in the page's world if it must", { skip: backend === "emulator" }, async () => {
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:file -- test/unit/analyze-background.test.ts`
Expected: FAIL in "reports the APIs this version converts, with the GM grants they need". The new APIs are still "isn't converted yet", and grant nothing.

Run: `npm run test:file -- --test-name-pattern="extension APIs" test/browser/content-runtime.test.ts`
Expected: FAIL. Without the grants, `chrome.notifications.create` and `chrome.cookies.*` reject with "GM_notification is not available" and "GM_cookie is not available".

- [ ] **Step 3: Add the rows.** In `src/convert/support.ts`:

1. Replace:

```ts
// The API support table (spec §5.2): the single source of truth for what the runtime implements. The analyzer reads it
// for the report, and metadata.ts reads the gm methods a row needs for @grant (spec §5.1). It grows with the runtime:
// this version converts content scripts and the background's core: messaging, tabs, storage, i18n and lifecycle.
```

with:

```ts
// The API support table (spec §5.2): the single source of truth for what the runtime implements. The analyzer reads it
// for the report, and metadata.ts reads the gm methods a row needs for @grant (spec §5.1). It grows with the runtime:
// this version converts content scripts and the background, with every API of spec §5.2 but the popup's.
```

2. Replace:

```ts
const NO_PAGES = "it reaches extension pages, and popups and options pages aren't converted yet";
```

with:

```ts
const NO_PAGES = "it reaches extension pages, and popups and options pages aren't converted yet";
const MENUS: readonly GmMethod[] = ["registerMenuCommand", "unregisterMenuCommand"];

/** One row per member, all with the same support. */
const rows = (namespace: string, members: readonly string[], support: Support): Record<string, Support> =>
  Object.fromEntries(members.map((member) => [`${namespace}.${member}`, support]));

/** chrome.contextMenus, and Firefox's chrome.menus, as the manager's menu commands. */
const contextMenus = (namespace: string) => ({
  ...rows(namespace, ["create", "update", "remove", "removeAll", "onClicked"], {
    status: "partial",
    reason: "items become the userscript manager's menu commands; ones only for links, images, media or editable fields don't show",
    methods: MENUS,
  }),
  ...rows(namespace, ["ContextType", "ItemType", "ACTION_MENU_TOP_LEVEL_LIMIT"], { status: "supported" }),
});

/** MV3's action and MV2's browserAction and pageAction: a menu command stands for the toolbar button. */
const action = (namespace: string) => ({
  ...rows(namespace, ["onClicked"], { status: "supported", methods: MENUS }),
  ...rows(namespace, ["getTitle", "getBadgeText", "getBadgeBackgroundColor", "getBadgeTextColor", "enable", "disable", "isEnabled", "show", "hide"], { status: "supported", methods: MENUS }),
  ...rows(namespace, ["setTitle", "setBadgeText"], { status: "partial", reason: "shown in the menu command's caption", methods: MENUS }),
  ...rows(namespace, ["setIcon", "setBadgeBackgroundColor", "setBadgeTextColor"], { status: "partial", reason: "there is no toolbar button to show it on" }),
  ...rows(namespace, ["setPopup", "getPopup"], { status: "partial", reason: "the popup isn't converted yet" }),
});

const TOP_FRAME = "only the tab's top frame";
```

3. Replace:

```ts
  "tabs.TAB_ID_NONE": { status: "supported" },
};
```

with:

```ts
  "tabs.TAB_ID_NONE": { status: "supported" },
  ...rows("tabs", ["executeScript"], { status: "partial", reason: `${TOP_FRAME}; code runs in the page's world, with a null result, where the page's CSP forbids eval` }),
  ...rows("tabs", ["insertCSS", "removeCSS"], { status: "partial", reason: TOP_FRAME }),
  "runtime.getBackgroundPage": { status: "supported" },
  "extension.getBackgroundPage": { status: "supported" },
  ...rows("alarms", ["create", "get", "getAll", "clear", "clearAll", "onAlarm"], { status: "supported" }),
  ...contextMenus("contextMenus"),
  ...contextMenus("menus"),
  ...action("action"),
  ...action("browserAction"),
  ...action("pageAction"),
  "commands.getAll": { status: "supported" },
  "commands.onCommand": { status: "partial", reason: "shortcuts work only while a page the userscript runs on has focus" },
  "commands.onChanged": { status: "partial", reason: "never fires: shortcuts can't be changed" },
  ...rows("notifications", ["create"], { status: "supported", methods: ["notification"] }),
  ...rows("notifications", ["update", "clear"], { status: "partial", reason: "a notification already shown can't be changed or taken back", methods: ["notification"] }),
  ...rows("notifications", ["getAll", "getPermissionLevel", "onClicked", "onClosed", "TemplateType", "PermissionLevel"], { status: "supported" }),
  ...rows("notifications", ["onButtonClicked", "onPermissionLevelChanged", "onShowSettings"], { status: "partial", reason: "never fires: buttons and settings don't show" }),
  ...rows("cookies", ["get", "getAll", "set", "remove", "getAllCookieStores"], { status: "partial", reason: "through GM_cookie, so the userscript manager decides which cookies are seen", methods: ["cookie"] }),
  ...rows("cookies", ["OnChangedCause", "SameSiteStatus"], { status: "supported" }),
  "cookies.onChanged": { status: "partial", reason: "never fires" },
  ...rows("permissions", ["contains", "getAll", "remove", "onAdded", "onRemoved"], { status: "supported" }),
  "permissions.request": { status: "partial", reason: "grants what the manifest lists as optional without asking the user" },
  ...rows("windows", ["get", "getCurrent", "getLastFocused", "getAll", "create", "update"], { status: "partial", reason: "one window holding every tab" }),
  ...rows("windows", ["WINDOW_ID_NONE", "WINDOW_ID_CURRENT", "CreateType", "WindowType", "WindowState"], { status: "supported" }),
  "windows.remove": { status: "partial", reason: "a userscript can't close the browser window" },
  ...rows("windows", ["onCreated", "onRemoved", "onFocusChanged", "onBoundsChanged"], { status: "partial", reason: "never fires: there is one window" }),
  "scripting.executeScript": { status: "partial", reason: `${TOP_FRAME}; a function runs in the page's world, without chrome.*, where the page's CSP forbids eval` },
  ...rows("scripting", ["insertCSS", "removeCSS"], { status: "partial", reason: TOP_FRAME }),
  ...rows("scripting", ["ExecutionWorld", "StyleOrigin"], { status: "supported" }),
};
```

- [ ] **Step 4: Run the tests on the emulator**

Run: `npm run test:file -- test/unit/analyze-background.test.ts`
Expected: PASS.

Run: `npm run test:file -- test/browser/content-runtime.test.ts`
Expected: PASS, 14 tests, 1 skipped (the strict-CSP test needs a real manager). Run it 3 times.

Run: `S4_CHURN_MS=10000 npm run test:browser`
Expected: everything passes, apart from the known Firefox S3 failure on macOS 27.

- [ ] **Step 5 (controller, release tier): run it on real managers.** It needs the bench profile and one browser at a time.

Run: `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/content-runtime.test.ts`
Expected: PASS, 28 tests, 2 skipped (the emulator-only menu test). The prototype passed on Tampermonkey 5.5.1 and Violentmonkey 2.49.0.

Run: `S4_CHURN_MS=20000 X2U_BACKENDS=tm,vm npm run test:file -- test/browser/s4-crosstab.test.ts`
Expected: PASS, 4 tests: 1,050 of 1,050 messages per manager, and one leader at every check.

Run: `X2U_BACKENDS=tm,vm npm run test:file -- test/browser/conformance.test.ts`
Expected: PASS, 6 tests.

Afterwards, `pgrep -fl "Google Chrome for Testing"` should show nothing.

- [ ] **Step 6: Update the README.** In `README.md`:

Replace:

```markdown
Content scripts and the background (service workers, background scripts and pages) are converted today, with
messaging, ports, tabs, storage and lifecycle events. Popups, options pages and the rest of the extension APIs come
next, and the report says what didn't convert.
```

with:

```markdown
Content scripts and the background (service workers, background scripts and pages) are converted today, with
messaging, ports, tabs, storage, lifecycle events, cross-origin requests, alarms, context menus and the toolbar button
(as the userscript manager's menu commands), keyboard shortcuts, notifications, cookies, permissions and scripting.
Popups and options pages come next, and the report says what didn't convert.
```

- [ ] **Step 7: Run everything, then commit**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; every unit test passes (334 in the prototype).

```bash
git add src/convert/support.ts test/unit/analyze-background.test.ts test/support/extension.ts test/browser/content-runtime.test.ts README.md
git commit -m "Report the new APIs, and test them end to end on every backend" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After Plan 3b

- **Ceilings this plan accepts.** Each is noted where its code is.
  - **Network:**
    - bodies through `gm.xmlHttpRequest` are buffered;
    - uploads report no progress;
    - a synchronous `XMLHttpRequest` can't go through it;
    - `window.fetch` called explicitly from a content script isn't shimmed;
    - optional hosts are reachable whether or not they were granted.
  - **Alarms:** an alarm fires only while a page the userscript runs on is open. A hidden tab's timers can run up to a minute late.
  - **Context menus:**
    - the menu is flat;
    - items only for links, images, media or editable fields don't show;
    - `onClicked` gets no link or media details;
    - `menuItemId` is always a string.
  - **The toolbar button:** the badge shows in the command's caption; the icon and colours don't show.
  - **Shortcuts:** they work only while such a page has focus, and can't be changed.
  - **Notifications:** a shown one can't be changed or taken back; buttons and progress don't show.
  - **Cookies:** `onChanged` never fires, and the manager decides which cookies are seen.
  - **Scripting:**
    - only the top frame;
    - a file's result is `null`;
    - a function that falls back to the page's world loses `chrome.*`;
    - `registerContentScripts` isn't converted.
  - **Windows:** one synthetic window.
  - **Permissions:** `request` grants without asking.
- **Still deferred from Plan 3's review:**
  - `sendMessage`/`connect` throw after `pagehide`;
  - fallback fakes are one level deep;
  - `global.ts`'s strict set and delete, with no `defineProperty` trap;
  - a worker's `self.window`/`self.document`;
  - the leader's own `pushState` reaching its background late;
  - `tabs.update(undefined, {url})`.
- **Plan 4:** popup and options pages, `action.openPopup` and the "Open <name>" command, `runtime.openOptionsPage`, `getBackgroundPage` from a popup, and messages between the background and extension pages.
