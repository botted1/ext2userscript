// Trusted Types (spec §5.5). A page that requires them (YouTube) makes plain strings throw in its HTML and script-URL
// sinks. Tampermonkey's userscript world gets the page's rules, and its DOM too, though an extension's content script
// never does; so the extension's own innerHTML or <script src> would throw. The runtime wraps the sinks and passes a
// string through a policy of its own only when the code assigning it is the userscript's, as its stack frames name
// it: the page's own code keeps its protection, which a `default` policy would turn off for the whole page.
// ponytail: the common sinks only (no document.write, srcdoc, setAttribute or Range); add one if an extension needs it.

type Policy = { createHTML(text: string): unknown; createScriptURL(url: string): unknown };

/**
 * The wrappers' name in stack frames. It is a method key, so minifying keeps it: a second converted userscript in the
 * same world wraps these wrappers, and each runtime skips the other's frames to find the code that called the sink.
 */
export const SINK = "__x2uTrustedSink";
type Factory = { createPolicy(name: string, rules: object): Policy };

/** The script a stack frame ("    at f (url:1:2)" or "    at url:1:2") belongs to. */
export function frameScript(frame: string | undefined): string | undefined {
  return frame?.match(/^\s*at (?:.*\()?(.+?):\d+:\d+\)?$/)?.[1];
}

/** Wraps the sinks when this world enforces Trusted Types and the page lets the runtime create its policy. */
export function trustExtensionStrings(): void {
  const factory = (globalThis as { trustedTypes?: Factory }).trustedTypes;
  // The userscript's own script, as its frames name it. "<anonymous>" could be the page's eval'd code too.
  const own = frameScript(new Error().stack?.split("\n")[1]);
  if (!factory || !own || own === "<anonymous>" || !enforced()) return;
  let policy: Policy;
  try {
    policy = factory.createPolicy("ext2userscript", { createHTML: (text: string) => text, createScriptURL: (url: string) => url });
  } catch {
    return; // a CSP that names its allowed policies (trusted-types <names>) refuses this one
  }
  // Called straight from a wrapped sink: frame 1 is this function and 2 the sink. The code that called the sink is the
  // next frame with a position, past built-ins (Object.assign, Reflect.set) and other runtimes' wrappers.
  const fromExtension = () => {
    for (const frame of new Error().stack?.split("\n").slice(3) ?? []) {
      const script = frame.includes(SINK) ? undefined : frameScript(frame);
      if (script !== undefined) return script === own;
    }
    return false;
  };
  const html = (text: string) => policy.createHTML(text);
  for (const [proto, name, create] of [
    [Element.prototype, "innerHTML", html],
    [Element.prototype, "outerHTML", html],
    [ShadowRoot.prototype, "innerHTML", html],
    [HTMLScriptElement.prototype, "src", (url: string) => policy.createScriptURL(url)],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    const set = descriptor?.set;
    if (!set) continue;
    Object.defineProperty(proto, name, {
      ...descriptor,
      set: {
        [SINK](this: unknown, value: unknown) {
          set.call(this, typeof value === "string" && fromExtension() ? create(value) : value);
        },
      }[SINK],
    });
  }
  const insertAdjacentHTML = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = {
    [SINK](this: Element, position: InsertPosition, text: string) {
      insertAdjacentHTML.call(this, position, (typeof text === "string" && fromExtension() ? html(text) : text) as string);
    },
  }[SINK];
  const parseFromString = DOMParser.prototype.parseFromString;
  DOMParser.prototype.parseFromString = {
    [SINK](this: DOMParser, text: string, type: DOMParserSupportedType) {
      return parseFromString.call(this, (typeof text === "string" && fromExtension() ? html(text) : text) as string, type);
    },
  }[SINK];
}

/** Whether an HTML string throws here, on an element that isn't in the page. */
function enforced(): boolean {
  try {
    document.createElement("div").innerHTML = "<b></b>";
    return false;
  } catch {
    return true;
  }
}
