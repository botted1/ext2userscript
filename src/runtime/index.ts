// The runtime's entry point (spec §5). runtime-node.ts bundles this file to an IIFE named __x2uRuntime, and every
// userscript calls __x2uRuntime.start(config, code) once.
import { createAssets } from "./assets.ts";
import { createLogger, readLastError, withFallback } from "./chrome.ts";
import type { GroupCode, RuntimeConfig } from "./config.ts";
import { runContent } from "./content.ts";
import { createGm } from "./gm.ts";
import { createI18n } from "./i18n.ts";
import { createStorage } from "./storage.ts";

export function start(config: RuntimeConfig, code: readonly GroupCode[]): void {
  const log = createLogger(config.name);
  try {
    const gm = createGm();
    if (!gm.caps.valueListeners) {
      log.error(`${gm.handler} isn't supported: ext2userscript supports Tampermonkey and Violentmonkey`);
      return;
    }
    const i18n = withFallback(log, "i18n", createI18n(config, log));
    const assets = createAssets(config.assets, config.id, i18n.getMessage, log);
    const getURL = (path: string) => assets.url(path);
    const runtime = withFallback(log, "runtime", {
      id: config.id,
      get lastError() {
        return readLastError();
      },
      getURL,
      getManifest: () => structuredClone(config.manifest),
    });
    const extension = withFallback(log, "extension", {
      getURL,
      inIncognitoContext: false,
      get lastError() {
        return readLastError();
      },
    });
    // The namespaces Chrome gives content scripts. chrome.tabs and the rest are undefined there, as in Chrome.
    const chrome = { runtime, storage: createStorage(gm, config.ns, log), i18n, extension };
    runContent(config, code, { gm, chrome, assets, log });
  } catch (error) {
    log.error("couldn't start:", error);
  }
}
