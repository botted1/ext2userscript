import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAssets } from "../../src/runtime/assets.ts";
import { callWithLastError, createEvent, createLogger, method, readLastError, withFallback, type Logger } from "../../src/runtime/chrome.ts";
import { createI18n, pickLocale } from "../../src/runtime/i18n.ts";
import { frameScript } from "../../src/runtime/trusted.ts";

/** A logger that records what it would print. */
function recorder(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const seen = new Set<string>();
  return {
    lines,
    error: (...args) => lines.push(args.map(String).join(" ")),
    once: (key, ...args) => {
      if (seen.has(key)) return;
      seen.add(key);
      lines.push(args.map(String).join(" "));
    },
  };
}

describe("createLogger", () => {
  it("prefixes errors with the extension's name and logs a keyed message once", (t: TestContext) => {
    const errors = t.mock.method(console, "error", () => {});
    const log = createLogger("Sample");
    log.error("boom");
    log.once("k", "first");
    log.once("k", "second");
    assert.deepEqual(errors.mock.calls.map((call) => call.arguments), [["[ext2userscript:Sample]", "boom"], ["[ext2userscript:Sample]", "first"]]);
  });
});

describe("method", () => {
  it("returns a promise when there is no callback", async () => {
    const add = method(recorder(), async (a: number, b: number) => a + b);
    assert.equal(await add(1, 2), 3);
  });

  it("calls back instead of returning a promise when the last argument is a function", async () => {
    const add = method(recorder(), async (a: number, b: number) => a + b);
    const result = await new Promise((resolve) => assert.equal(add(1, 2, resolve), undefined));
    assert.equal(result, 3);
  });

  it("sets runtime.lastError during the callback of a failed call, and clears it afterwards", async () => {
    const log = recorder();
    const fail = method(log, async () => {
      throw new Error("nope");
    });
    const seen = await new Promise((resolve) => fail(() => resolve(readLastError()?.message)));
    assert.equal(seen, "nope");
    assert.equal(readLastError(), undefined);
    assert.deepEqual(log.lines, []);
  });

  it("logs an unchecked lastError", () => {
    const log = recorder();
    callWithLastError(log, new Error("ignored"), () => {});
    assert.deepEqual(log.lines, ["Unchecked runtime.lastError: ignored"]);
  });

  it("turns a synchronous throw into a rejection", async () => {
    const broken = method(recorder(), () => {
      throw new Error("sync");
    });
    await assert.rejects(broken() as Promise<unknown>, /sync/);
  });
});

describe("createEvent", () => {
  it("dispatches to every listener, once each, isolating a listener that throws", () => {
    const log = recorder();
    const { event, dispatch } = createEvent<(n: number) => void>(log);
    const seen: number[] = [];
    const listener = (n: number) => seen.push(n);
    event.addListener(listener);
    event.addListener(listener);
    event.addListener(() => {
      throw new Error("bad listener");
    });
    event.addListener((n) => seen.push(n * 10));
    dispatch(1);
    assert.deepEqual(seen, [1, 10]);
    assert.equal(log.lines.length, 1);
    assert.equal(event.hasListener(listener), true);
    event.removeListener(listener);
    assert.equal(event.hasListener(listener), false);
  });

  it("runs onFirstListener when the first listener is added", () => {
    let starts = 0;
    const { event } = createEvent<() => void>(recorder(), () => starts++);
    event.addListener(() => {});
    event.addListener(() => {});
    assert.equal(starts, 1);
  });
});

describe("withFallback", () => {
  it("fakes only the members it's told Chrome has, so feature detection sees what a content script would", () => {
    const runtime = withFallback(recorder(), "runtime", { id: "abc" }, ["sendMessage", "onMessage"]) as Record<string, unknown>;
    assert.equal(typeof runtime.sendMessage, "function");
    assert.equal(typeof runtime.onMessage, "object");
    assert.equal(runtime.getBackgroundPage, undefined);
    assert.equal("getBackgroundPage" in runtime, false);
  });

  it("keeps implemented members and rejects unknown ones with a named error, logged once", async () => {
    const log = recorder();
    const runtime = withFallback(log, "runtime", { id: "abc" }, ["sendMessage"]) as Record<string, unknown> & { id: string };
    assert.equal(runtime.id, "abc");
    const send = runtime.sendMessage as (...args: unknown[]) => Promise<unknown>;
    await assert.rejects(send({}), /ext2userscript: chrome\.runtime\.sendMessage is not available in userscripts/);
    await assert.rejects(send({}), /not available/);
    assert.equal(log.lines.length, 1);
  });

  it("calls back with lastError when an unknown method gets a callback", async () => {
    const runtime = withFallback(recorder(), "runtime", {}, ["sendMessage"]) as Record<string, (...args: unknown[]) => unknown>;
    const message = await new Promise((resolve) => runtime.sendMessage({}, () => resolve(readLastError()?.message)));
    assert.match(String(message), /chrome\.runtime\.sendMessage is not available/);
  });

  it("gives unknown events an addListener that logs and never fires", () => {
    const log = recorder();
    const runtime = withFallback(log, "runtime", {}, ["onMessage"]) as Record<string, { addListener(fn: () => void): void; hasListeners(): boolean }>;
    runtime.onMessage.addListener(() => {});
    assert.match(log.lines[0], /chrome\.runtime\.onMessage is not available in userscripts; the listener will never be called/);
    assert.equal(runtime.onMessage.hasListeners(), false);
  });

  it("fakes every member when told 'all', as the background needs, but never then or toJSON", async () => {
    const alarms = withFallback(recorder(), "alarms", {}, "all") as Record<string, unknown>;
    await assert.rejects((alarms.create as () => Promise<unknown>)(), /chrome\.alarms\.create is not available in userscripts/);
    assert.equal(typeof (alarms.onAlarm as { addListener: unknown }).addListener, "function");
    assert.equal("anything" in alarms, true);
    assert.equal(alarms.then, undefined);
    assert.equal(alarms.toJSON, undefined);
  });

  it("doesn't fake then or toJSON, so a namespace never looks like a promise", async () => {
    const storage = withFallback(recorder(), "storage", { local: 1 }, []);
    assert.equal((storage as Record<string, unknown>).then, undefined);
    assert.equal(await Promise.resolve(storage), storage);
    assert.equal(JSON.stringify(storage), '{"local":1}');
  });
});

describe("pickLocale", () => {
  const available = ["en", "en_GB", "pt_BR", "fr"];

  it("prefers an exact match, ignoring case and - versus _", () => assert.equal(pickLocale(available, ["en-gb"], "en"), "en_GB"));
  it("falls back to the base language", () => assert.equal(pickLocale(available, ["fr-CA"], "en"), "fr"));
  it("tries each wanted locale in order", () => assert.equal(pickLocale(available, ["de", "pt-BR"], "en"), "pt_BR"));
  it("uses the fallback when nothing matches", () => assert.equal(pickLocale(available, ["de"], "en"), "en"));
});

describe("createI18n", () => {
  const config = {
    id: "abcdefghijklmnopabcdefghijklmnop",
    defaultLocale: "en",
    locales: {
      en: {
        greeting: { message: "Hello $who$ and $2", placeholders: { who: { content: "$1" } } },
        price: { message: "Costs $$5" },
        onlydefault: { message: "from en" },
      },
      fr: { greeting: { message: "Bonjour $WHO$", placeholders: { who: { content: "$1" } } } },
    },
  };

  it("picks the browser's language and fills placeholders and substitutions", () => {
    const i18n = createI18n(config, recorder(), ["fr-FR", "en"]);
    assert.equal(i18n.getMessage("Greeting", ["x2u"]), "Bonjour x2u");
  });

  it("falls back to the default locale per message, and returns '' for unknown names", () => {
    const i18n = createI18n(config, recorder(), ["fr"]);
    assert.equal(i18n.getMessage("onlyDefault"), "from en");
    assert.equal(i18n.getMessage("missing"), "");
  });

  it("substitutes $1–$9 and $$, and accepts a single string substitution", () => {
    const i18n = createI18n(config, recorder(), ["en-US"]);
    assert.equal(i18n.getMessage("greeting", ["a", "b"]), "Hello a and b");
    assert.equal(i18n.getMessage("greeting", "solo"), "Hello solo and ");
    assert.equal(i18n.getMessage("price"), "Costs $5");
  });

  it("honours a forced locale and answers predefined messages", () => {
    const i18n = createI18n({ ...config, locale: "fr" }, recorder(), ["en"]);
    assert.equal(i18n.getMessage("greeting", ["x"]), "Bonjour x");
    assert.equal(i18n.getMessage("@@extension_id"), config.id);
    assert.equal(i18n.getMessage("@@ui_locale"), "fr");
    assert.equal(i18n.getMessage("@@bidi_dir"), "ltr");
  });

  it("reports the browser's languages", async () => {
    const i18n = createI18n(config, recorder(), ["de-DE", "en"]);
    assert.equal(i18n.getUILanguage(), "de-DE");
    assert.deepEqual(await i18n.getAcceptLanguages(), ["de-DE", "en"]);
  });
});

describe("createAssets", () => {
  const table = { "img/dot.png": ["image/png", btoa("PNGDATA")] as [string, string], "inject.js": ["text/javascript", btoa("window.x = 1;")] as [string, string] };

  it("hands out one blob URL per path, whatever form the path takes", async () => {
    const assets = createAssets(table, "id", () => "", recorder());
    const url = assets.url("/img/dot.png?v=2");
    assert.match(url, /^blob:/);
    assert.equal(assets.url("./img/dot.png"), url);
    assert.equal(assets.pathOf(url), "img/dot.png");
    const blob = await fetch(url).then((response) => response.blob());
    assert.equal(blob.type, "image/png");
    assert.equal(await blob.text(), "PNGDATA");
  });

  it("returns a chrome-extension URL and logs once for a file it doesn't have", () => {
    const log = recorder();
    const assets = createAssets(table, "abc", () => "", log);
    assert.equal(assets.url("missing.png"), "chrome-extension://abc/missing.png");
    assets.url("missing.png");
    assert.equal(log.lines.length, 1);
  });

  it("decodes a text asset", () => assert.equal(createAssets(table, "id", () => "", recorder()).text("inject.js"), "window.x = 1;"));

  it("resolves asset placeholders and __MSG_ names in CSS", () => {
    const assets = createAssets(table, "id", (name) => (name === "@@extension_id" ? "abc" : `[${name}]`), recorder());
    const css = assets.css('a { background: url("x2u-asset:img%2Fdot.png"); content: "__MSG_label__"; }');
    assert.match(css, /^a \{ background: url\("blob:[^"]+"\); content: "\[label\]"; \}$/);
  });
});

describe("frameScript", () => {
  it("reads the script a V8 stack frame belongs to, with or without a function name", () => {
    assert.equal(frameScript("    at Proxy.later (chrome-extension://abc/userscript.html?name=a.user.js&id=1:15:134)"), "chrome-extension://abc/userscript.html?name=a.user.js&id=1");
    assert.equal(frameScript("    at chrome-extension://abc/a%20b.user.js#23:14:15"), "chrome-extension://abc/a%20b.user.js#23");
    assert.equal(frameScript("    at <anonymous>:289:15"), "<anonymous>");
    assert.equal(frameScript("Error"), undefined);
    assert.equal(frameScript(undefined), undefined);
  });
});
