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

/**
 * Listens on this page for the extension's shortcuts. A shortcut is the extension's, so the page doesn't see it; and only
 * the user's key presses count (isUserEvent), so the page can't fire one by making up a key event.
 */
export function listenForCommands(
  target: EventTarget,
  config: RuntimeConfig,
  emit: (type: string, data: unknown) => Promise<void>,
  log: Logger,
  platform = commandPlatform(),
  isUserEvent = (event: Event) => event.isTrusted,
): void {
  const wanted = shortcuts(config, platform);
  if (wanted.length === 0) return;
  target.addEventListener(
    "keydown",
    (event) => {
      if (!isUserEvent(event)) return;
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
