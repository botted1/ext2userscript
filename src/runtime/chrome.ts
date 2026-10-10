// What every chrome.* namespace shares (spec §5.2, §9): logging with the extension's name, calls that take a trailing
// callback or return a promise, runtime.lastError, events, and a named rejection for any member this version doesn't
// implement.

export type Logger = {
  error(...args: unknown[]): void;
  /** Logs once per key for the page's lifetime. */
  once(key: string, ...args: unknown[]): void;
};

export function createLogger(name: string): Logger {
  const prefix = `[ext2userscript:${name}]`;
  const seen = new Set<string>();
  return {
    error: (...args) => console.error(prefix, ...args),
    once: (key, ...args) => {
      if (seen.has(key)) return;
      seen.add(key);
      console.error(prefix, ...args);
    },
  };
}

let lastError: { message: string } | undefined;
let lastErrorChecked = false;

/** chrome.runtime.lastError: set only while a failed call's callback runs. */
export function readLastError(): { message: string } | undefined {
  lastErrorChecked = true;
  return lastError;
}

/** Runs a callback with runtime.lastError set, as Chrome does, and logs the error if the callback never looked at it. */
export function callWithLastError(log: Logger, error: unknown, callback: () => void): void {
  lastError = { message: error instanceof Error ? error.message : String(error) };
  lastErrorChecked = false;
  try {
    callback();
  } finally {
    if (!lastErrorChecked) log.error(`Unchecked runtime.lastError: ${lastError.message}`);
    lastError = undefined;
  }
}

/** A chrome.* method: with a trailing callback it calls back (setting lastError on failure); without one it returns a promise. */
export function method<A extends unknown[], R>(log: Logger, impl: (...args: A) => Promise<R>) {
  return (...args: unknown[]): Promise<R> | undefined => {
    const callback = typeof args[args.length - 1] === "function" ? (args.pop() as (result?: R) => void) : undefined;
    let promise: Promise<R>;
    try {
      promise = impl(...(args as A));
    } catch (error) {
      promise = Promise.reject(error);
    }
    if (!callback) return promise;
    promise.then(
      (result) => callback(result),
      (error: unknown) => callWithLastError(log, error, () => callback()),
    );
    return undefined;
  };
}

export type ChromeEvent<F extends (...args: never[]) => unknown> = {
  addListener(listener: F): void;
  removeListener(listener: F): void;
  hasListener(listener: F): boolean;
  hasListeners(): boolean;
};

/** A chrome.* event. onFirstListener runs when the first listener is added, so costly watching starts only when needed. */
export function createEvent<F extends (...args: never[]) => unknown>(log: Logger, onFirstListener?: () => void) {
  const listeners = new Set<F>();
  const event: ChromeEvent<F> = {
    addListener: (listener) => {
      if (listeners.size === 0) onFirstListener?.();
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
    hasListener: (listener) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
  };
  const dispatch = (...args: Parameters<F>) => {
    for (const listener of [...listeners]) {
      try {
        listener(...args);
      } catch (error) {
        log.error("Error in event handler:", error);
      }
    }
  };
  return { event, dispatch };
}

export const unavailable = (api: string) => new Error(`ext2userscript: chrome.${api} is not available in userscripts`);

/**
 * Wraps a namespace so that the members Chrome gives content scripts but this version doesn't implement (faked) fail
 * with a named error, logged once (spec §9): an event's addListener logs that the listener will never be called, and a
 * method rejects or calls back with lastError set. Any other missing member is undefined, as in Chrome, so feature
 * detection takes the content-script path.
 */
export function withFallback<T extends object>(log: Logger, namespace: string, members: T, faked: readonly string[]): T {
  return new Proxy(members, {
    has: (target, property) => property in target || (typeof property === "string" && faked.includes(property)),
    get(target, property, receiver) {
      if (typeof property === "symbol" || property in target || !faked.includes(property)) return Reflect.get(target, property, receiver);
      const api = `${namespace}.${property}`;
      if (/^on[A-Z]/.test(property)) {
        return {
          addListener: () => log.once(api, `${unavailable(api).message}; the listener will never be called`),
          removeListener: () => {},
          hasListener: () => false,
          hasListeners: () => false,
        };
      }
      return method(log, () => {
        log.once(api, unavailable(api).message);
        return Promise.reject(unavailable(api));
      });
    },
  });
}
