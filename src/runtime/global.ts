// The background's global object (spec §3.3): what `self` and `globalThis` (and `window`, for an MV2 background page)
// mean in background code. It is the userscript's real global, with what a background expects on top: chrome and
// browser, importScripts, localStorage, and a service worker's install/activate events, skipWaiting and clients.
// The real global is never the proxy's target, so the proxy may answer differently for properties Window fixes in place.

/** Service-worker events: install and activate fire once the background has run; the rest never fire here. */
const WORKER_EVENTS = new Set(["install", "activate", "message", "fetch", "push", "sync", "periodicsync", "notificationclick", "notificationclose"]);

type Listener = ((event: unknown) => void) | { handleEvent(event: unknown): void };

export function createBackgroundGlobal(own: Record<string, unknown>) {
  const listeners = new Map<string, Set<Listener>>();
  const members: Record<string, unknown> = {
    ...own,
    // self.onmessage and the like stay here: on the tab's real global, the page could post into the background's handler.
    ...Object.fromEntries([...WORKER_EVENTS].map((type) => [`on${type}`, null])),
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
  const global = proxyGlobal(globalThis, members, ["self", "globalThis"]);

  return {
    global,
    /** Answers for a background page's top-level declarations (getters and setters), as its window does. */
    expose(declarations: object) {
      Object.defineProperties(members, Object.getOwnPropertyDescriptors(declarations));
    },
    /** Fires a service-worker lifecycle event at the listeners background code added on self. */
    fire(type: "install" | "activate") {
      const event = { type, waitUntil: () => {} };
      const handler = members[`on${type}`];
      for (const listener of [...(listeners.get(type) ?? []), ...(typeof handler === "function" ? [handler as Listener] : [])]) {
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

/**
 * A global object over a real one (the userscript's, or a page iframe's window): members first, then the real global's
 * properties, with its native methods bound to it. The names in `itself` answer the proxy.
 *
 * With `bare` (the userscript's global, for a page over its iframe's window): what code adds that the real global doesn't
 * have (window.$ = jQuery) goes to `bare` instead, where the code's bare names find it, as one script of a page finds
 * what an earlier one put on window.
 */
export function proxyGlobal(target: object, members: Record<string, unknown>, itself: readonly string[], bare?: object): typeof globalThis {
  const own = target as Record<PropertyKey, unknown>;
  const added = bare as Record<PropertyKey, unknown> | undefined;
  /** Where a property lives: the real global if it has it, else `bare` when there is one. */
  const holder = (property: PropertyKey) => (added && !(property in own) ? added : own);
  const bound = new Map<Function, Function>();
  /** Functions code put on the global (self.moment = factory()): handed back as they are, static members and all. */
  const assigned = new WeakSet<Function>();
  const global: typeof globalThis = new Proxy(Object.create(null) as object, {
    get(_target, property) {
      if (typeof property === "string" && itself.includes(property)) return global;
      if (typeof property === "string" && property in members) return members[property];
      const real = holder(property);
      const value = real[property];
      // A native method needs the real global as `this`: self.setTimeout(...) would otherwise throw "Illegal invocation".
      // Lower-case names only, so constructors (self.Promise, self.URL) keep their static members.
      if (typeof value !== "function" || typeof property !== "string" || !/^[a-z]/.test(property) || assigned.has(value)) return value;
      let fn = bound.get(value);
      if (!fn) bound.set(value, (fn = value.bind(real)));
      return fn;
    },
    set(_target, property, value) {
      if (typeof value === "function") assigned.add(value);
      if (typeof property === "string" && property in members) members[property] = value;
      else holder(property)[property] = value;
      return true;
    },
    has: (_target, property) => (typeof property === "string" && property in members) || property in own || (added !== undefined && property in added),
    deleteProperty: (_target, property) => delete holder(property)[property],
  }) as typeof globalThis;
  return global;
}
