// MAIN-world content scripts' patches (spec §5.5). Tampermonkey's default sandbox mode turns @sandbox DOM off, so the
// userscript shares the page's realm, and a MAIN-world script's change to a DOM prototype reaches the extension's own
// code, which Chrome's isolated world never sees (Dark Reader's proxy hides its sheets from document.styleSheets, and
// its own dark-theme check then removes the theme). So each MAIN-world group's script is named, and the realm's
// defineProperty turns that script's change to a native prototype's getter, setter or method into one that gives the
// userscript's own frames what was there before, and every other caller the patch.
// ponytail: defineProperty on prototypes only; a patch by assignment (XMLHttpRequest.prototype.open = …) or on an
// instance (document.hidden) still reaches the extension. A shielded member reads a stack per access (about 3 µs, the
// page's accesses too). Diff the prototypes after each MAIN-world group runs if an extension needs more.
import { frameScript, SINK } from "./trusted.ts";

/** The runtime's wrappers' name in stack frames: a method key, so minifying keeps it, as with the trusted sinks. */
const PATCH = "__x2uMainPatch";

/** The script of the code that called the innermost runtime wrapper, past built-ins and other wrappers. */
function caller(): string | undefined {
  // String(): the page shares Error here, and its prepareStackTrace may return something else.
  const frames = String(new Error().stack).split("\n");
  for (const frame of frames.slice(frames.findIndex((frame) => frame.includes(PATCH)) + 1)) {
    const script = frame.includes(PATCH) || frame.includes(SINK) ? undefined : frameScript(frame);
    if (script !== undefined) return script;
  }
  return undefined;
}

const base = (id: string) => `chrome-extension://${encodeURIComponent(id)}/`;
/** The name a MAIN-world group's script goes by, which the shield recognises. */
export const mainScriptName = (id: string, index: number) => `${base(id)}content_scripts/${index}.js`;

/** Keeps the MAIN-world scripts of extension `id` from changing the native prototypes this userscript's code sees. */
export function shieldFromMainWorld(id: string): void {
  // The userscript's own script, as its frames name it. "<anonymous>" could be the page's eval'd code too.
  const own = frameScript(new Error().stack?.split("\n")[1]);
  if (!own || own === "<anonymous>") return;
  const isMain = (script: string | undefined) => script?.startsWith(base(id)) === true;
  const prototypes = new WeakSet<object>();
  // Constructors only (capitalised names). Reading window["0"], a frame, would make Chrome create that frame's
  // about:blank document early; a same-origin page then reuses its window, and the manager never runs in it.
  for (const name of Object.getOwnPropertyNames(globalThis).filter((key) => /^[A-Z]/.test(key))) {
    const value: unknown = Object.getOwnPropertyDescriptor(globalThis, name)?.value;
    if (typeof value === "function" && typeof value.prototype === "object" && value.prototype) prototypes.add(value.prototype);
  }
  const { defineProperty, defineProperties, getOwnPropertyDescriptor: describe } = Object;
  const reflectDefine = Reflect.defineProperty;
  /** Each member made here, and what it gives the userscript: a patch over a patch, or a restore, sees past it. */
  const originals = new WeakMap<Function, Function>();

  /** Runs a define of `keys`; when a MAIN-world script made it on a native prototype, shields what it changed. */
  const guard = <T>(target: unknown, keys: () => PropertyKey[], define: () => T): T => {
    if (!prototypes.has(target as object) || !isMain(caller())) return define();
    const object = target as object;
    const before = keys().map((key) => [key, describe(object, key)] as const);
    const result = define();
    for (const [key, old] of before) {
      const now = describe(object, key);
      if (!old || !now) continue;
      let changed = false;
      for (const part of ["get", "set", "value"] as const) {
        const original = typeof old[part] === "function" ? (originals.get(old[part]) ?? old[part]) : undefined;
        const patched = now[part];
        if (typeof original !== "function" || typeof patched !== "function" || original === patched) continue;
        now[part] = {
          [PATCH](this: unknown, ...args: unknown[]) {
            return Reflect.apply(caller() === own ? original : patched, this, args);
          },
        }[PATCH];
        originals.set(now[part], original);
        changed = true;
      }
      // A non-configurable patch stays as it is, for everyone.
      if (changed && now.configurable) defineProperty(object, key, now);
    }
    return result;
  };
  Object.defineProperty = {
    [PATCH](target: object, key: PropertyKey, descriptor: PropertyDescriptor) {
      return guard(target, () => [key], () => defineProperty(target, key, descriptor));
    },
  }[PATCH] as typeof Object.defineProperty;
  Object.defineProperties = {
    [PATCH](target: object, descriptors: PropertyDescriptorMap) {
      return guard(target, () => Reflect.ownKeys(descriptors), () => defineProperties(target, descriptors));
    },
  }[PATCH] as typeof Object.defineProperties;
  Reflect.defineProperty = {
    [PATCH](target: object, key: PropertyKey, descriptor: PropertyDescriptor) {
      return guard(target, () => [key], () => reflectDefine(target, key, descriptor));
    },
  }[PATCH];
}
