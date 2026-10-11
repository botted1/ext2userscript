// The background's global object (spec §3.3): what `self` and `globalThis` (and `window`, for an MV2 background page)
// mean in background code. It is the userscript's real global, with what a background expects on top: chrome and
// browser, importScripts, localStorage, and a service worker's install/activate events, skipWaiting and clients.
// The real global is never the proxy's target, so the proxy may answer differently for properties Window fixes in place.

/** Service-worker events: install and activate fire once the background has run; the rest never fire here. */
const WORKER_EVENTS = new Set(["install", "activate", "message", "fetch", "push", "sync", "periodicsync", "notificationclick", "notificationclose"]);

type Listener = ((event: unknown) => void) | { handleEvent(event: unknown): void };

export function createBackgroundGlobal(own: Record<string, unknown>) {
  const real = globalThis as unknown as Record<PropertyKey, unknown>;
  const listeners = new Map<string, Set<Listener>>();
  const bound = new Map<Function, Function>();
  const members: Record<string, unknown> = {
    ...own,
    addEventListener: (type: string, listener: Listener, options?: unknown) => {
      if (!WORKER_EVENTS.has(type)) return window.addEventListener(type, listener as EventListener, options as AddEventListenerOptions);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: Listener, options?: unknown) => {
      if (!WORKER_EVENTS.has(type)) return window.removeEventListener(type, listener as EventListener, options as EventListenerOptions);
      listeners.get(type)?.delete(listener);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [], get: async () => undefined, openWindow: async () => null },
  };
  const global: typeof globalThis = new Proxy(Object.create(null) as object, {
    get(_target, property) {
      if (property === "self" || property === "globalThis") return global;
      if (typeof property === "string" && property in members) return members[property];
      const value = real[property];
      // A native method needs the real global as `this`: self.setTimeout(...) would otherwise throw "Illegal invocation".
      // Lower-case names only, so constructors (self.Promise, self.URL) keep their static members.
      if (typeof value !== "function" || typeof property !== "string" || !/^[a-z]/.test(property)) return value;
      let fn = bound.get(value);
      if (!fn) bound.set(value, (fn = value.bind(real)));
      return fn;
    },
    set(_target, property, value) {
      if (typeof property === "string" && property in members) members[property] = value;
      else real[property] = value;
      return true;
    },
    has: (_target, property) => (typeof property === "string" && property in members) || property in real,
    deleteProperty: (_target, property) => delete real[property],
  }) as typeof globalThis;

  return {
    global,
    /** Fires a service-worker lifecycle event at the listeners background code added on self. */
    fire(type: "install" | "activate") {
      const event = { type, waitUntil: () => {} };
      for (const listener of listeners.get(type) ?? []) {
        try {
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        } catch (error) {
          console.error(error);
        }
      }
    },
  };
}
