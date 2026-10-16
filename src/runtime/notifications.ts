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
