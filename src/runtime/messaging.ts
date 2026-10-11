// Extension messaging (spec §5.3). Every page runs one router. It carries:
// - runtime.sendMessage / onMessage and runtime.connect / onConnect, between content scripts and the background;
// - tabs.sendMessage / tabs.connect, from the background to one tab's content scripts;
// - control requests the tabs API sends to another tab (navigate, reload, close).
// Everything travels as JSON over the cross-tab bus. A message for this same page goes through the bus too, which
// delivers it in a microtask, so delivery is always asynchronous and always a copy, as in Chrome.
import { callWithLastError, createEvent, type ChromeEvent, type Logger } from "./chrome.ts";

export type Endpoint = "content" | "background";
export type MessageSender = { id: string; url?: string; origin?: string; frameId?: number; tab?: unknown };

type Side = "opener" | "receiver";
type Outcome = { data?: unknown; error?: string; none?: boolean };
type Wire =
  | { k: "msg"; id: string; to: Endpoint; data: unknown; sender: MessageSender }
  | ({ k: "reply"; id: string } & Outcome)
  | { k: "open"; port: string; to: Endpoint; name: string; sender: MessageSender }
  | { k: "post"; port: string; side: Side; data: unknown }
  | { k: "close"; port: string; side: Side; error?: string }
  | { k: "accepted"; port: string }
  | { k: "ctl"; id: string; op: string; args: unknown };

export const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";
export const PORT_CLOSED = "The message port closed before a response was received.";
const REPLY_TIMEOUT_MS = 30_000;
/** How long a page holds messages for its background while it waits to lead (the election's grace period and boot). */
const HOLD_MS = 5_000;

export type Port = {
  name: string;
  sender?: MessageSender;
  onMessage: ChromeEvent<(message: unknown, port: Port) => void>;
  onDisconnect: ChromeEvent<(port: Port) => void>;
  postMessage(message: unknown): void;
  disconnect(): void;
};

type MessageListener = (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => unknown;

export type MessagingDeps = {
  extensionId: string;
  log: Logger;
  /** The page whose background receives runtime messages: the expected leader. */
  leader(): number | undefined;
  /** What the receiving end sees as sender, for messages and ports opened from this endpoint. Read when the message
   * leaves, so a message sent before this page knows its tab id still carries sender.tab. */
  sender(from: Endpoint): MessageSender;
  /** Whether a tab or frame with this id is live (or is this page), so a message to a closed tab fails at once. */
  exists(id: number): boolean;
  /** Runs a control request from another page's tabs API on this page. */
  control(op: string, args: unknown): Promise<unknown>;
};

export type Messaging = ReturnType<typeof createMessaging>;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createMessaging(deps: MessagingDeps) {
  const { log } = deps;
  // Message and port ids only need to be unique; this page's tab id isn't known yet when its first content script runs.
  const instance = Math.random().toString(36).slice(2, 10);
  const nextId = () => `${instance}:${++counter}`;
  let transport: ((to: number, wire: Wire) => Promise<void>) | undefined;
  const queued: Array<() => void> = [];
  let counter = 0;
  let backgroundReady = false;
  // Waiting for this page's background: messages and port openings for it, and whatever arrives on a port whose
  // opening waits, so a port's first postMessage isn't lost.
  const held: Array<{ wire: Wire; from: number; timer?: ReturnType<typeof setTimeout> }> = [];
  const opening = (port: string) => held.some((entry) => entry.wire.k === "open" && entry.wire.port === port);
  type Pending = { to?: number; settle(outcome: Outcome): void; resend?(): boolean };
  const pending = new Map<string, Pending>();
  type PortEntry = {
    peer(): number | undefined;
    receive(data: unknown): void;
    close(error?: string): void;
    /** The other end took the connection (its onConnect ran). */
    accepted?(): void;
    /** Opens again at whoever leads now, when the page it went to left before taking it. False once taken. */
    reroute?(): boolean;
  };
  const ports = new Map<string, PortEntry>();
  const events = {
    content: { message: createEvent<MessageListener>(log), connect: createEvent<(port: Port) => void>(log) },
    background: { message: createEvent<MessageListener>(log), connect: createEvent<(port: Port) => void>(log) },
  };

  /** Sends once the bus is up and the target is known; noTarget runs when there is nobody to send to. */
  const post = (target: () => number | undefined, wire: Wire | (() => Wire), noTarget?: () => void, onTarget?: (to: number) => void) => {
    const go = () => {
      const to = target();
      if (to === undefined) return noTarget?.();
      onTarget?.(to);
      transport?.(to, typeof wire === "function" ? wire() : wire).catch((error: unknown) => log.error("couldn't send a message:", error));
    };
    if (transport) go();
    else queued.push(go);
  };

  /**
   * Sends a request and settles with its reply, or with `none` if the other end goes away or 30 s pass. A request for the
   * background is sent again (up to twice) when the page it went to goes away first: the page may have been a ghost
   * that never got it, and the new leader should answer.
   */
  const request = (target: () => number | undefined, id: string, wire: () => Wire, toBackground = false): Promise<Outcome> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => entry.settle({ none: true }), REPLY_TIMEOUT_MS);
      let sends = 0;
      const go = () => {
        sends++;
        entry.to = undefined;
        post(target, wire, () => entry.settle({ error: NO_RECEIVER }), (to) => (entry.to = to));
      };
      const entry: Pending = {
        settle: (outcome) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(outcome);
        },
        ...(toBackground ? { resend: () => sends < 3 && (go(), true) } : {}),
      };
      pending.set(id, entry);
      go();
    });

  /** Chrome's two calling styles: a trailing callback (lastError on failure), or a promise. */
  const finish = (outcome: Promise<Outcome>, callback?: (response?: unknown) => void): Promise<unknown> | undefined => {
    if (callback) {
      void outcome.then((result) => {
        if (result.error !== undefined) callWithLastError(log, new Error(result.error), () => callback());
        else if (result.none) callWithLastError(log, new Error(PORT_CLOSED), () => callback());
        else callback(result.data);
      });
      return undefined;
    }
    return outcome.then((result) => {
      if (result.error !== undefined) throw new Error(result.error);
      return result.none ? undefined : result.data;
    });
  };

  const send = (target: () => number | undefined, to: Endpoint, data: unknown, from: Endpoint, callback?: (response?: unknown) => void) => {
    const id = nextId();
    return finish(request(target, id, () => ({ k: "msg", id, to, data, sender: deps.sender(from) }), to === "background"), callback);
  };

  /**
   * Creates one end of a port. `open` is set for the end that connects: it sends the opening, and keeps what was posted
   * until the other end takes the connection, so the opening can be sent again to a new leader if the first page it
   * went to leaves first (a ghost, say). Once taken, the other end leaving disconnects the port, as in Chrome.
   */
  const createPort = (id: string, side: Side, name: string, resolvePeer: () => number | undefined, sender?: MessageSender, open?: () => Wire): Port => {
    let peer: number | undefined;
    const target = () => (peer ??= resolvePeer());
    const other: Side = side === "opener" ? "receiver" : "opener";
    const onMessage = createEvent<(message: unknown, port: Port) => void>(log);
    const onDisconnect = createEvent<(port: Port) => void>(log);
    let closed = false;
    let taken = !open;
    let reroutes = 0;
    const unanswered: unknown[] = [];
    const key = `${id}:${side}`;
    const sendOpen = () => {
      if (open) post(target, open, () => setTimeout(() => ports.get(key)?.close(NO_RECEIVER)));
    };
    const port: Port = {
      name,
      ...(sender ? { sender } : {}),
      onMessage: onMessage.event,
      onDisconnect: onDisconnect.event,
      postMessage: (message) => {
        if (closed) throw new Error("Attempting to use a disconnected port object");
        if (!taken) unanswered.push(message);
        post(target, { k: "post", port: id, side: other, data: message });
      },
      // Chrome fires onDisconnect only at the other end.
      disconnect: () => {
        if (closed) return;
        closed = true;
        ports.delete(key);
        post(target, { k: "close", port: id, side: other });
      },
    };
    ports.set(key, {
      peer: () => peer,
      receive: (data) => {
        if (!closed) onMessage.dispatch(data, port);
      },
      close: (error) => {
        if (closed) return;
        closed = true;
        ports.delete(key);
        if (error === undefined) onDisconnect.dispatch(port);
        else callWithLastError(log, new Error(error), () => onDisconnect.dispatch(port));
      },
      accepted: () => {
        taken = true;
        unanswered.length = 0;
      },
      reroute: () => {
        if (taken || closed || reroutes >= 2) return false;
        reroutes++;
        peer = undefined;
        sendOpen();
        for (const message of unanswered) post(target, { k: "post", port: id, side: other, data: message });
        return true;
      },
    });
    sendOpen();
    return port;
  };

  const connect = (target: () => number | undefined, to: Endpoint, name: string, from: Endpoint): Port => {
    const id = nextId();
    return createPort(id, "opener", name, target, undefined, () => ({ k: "open", port: id, to, name, sender: deps.sender(from) }));
  };

  const onMessage = (wire: Wire & { k: "msg" }, from: number) => {
    const { message } = events[wire.to];
    let done = false;
    const respond = (outcome: Outcome) => {
      if (done) return;
      done = true;
      post(() => from, { k: "reply", id: wire.id, ...outcome });
    };
    if (!message.event.hasListeners()) return respond({ error: NO_RECEIVER });
    let open = false;
    // A listener keeps the channel open by returning true (and calling sendResponse later) or by returning a promise.
    for (const result of message.dispatch(wire.data, wire.sender, (data?: unknown) => respond({ data }))) {
      if (result === true) open = true;
      else if (result instanceof Promise) {
        open = true;
        result.then((data: unknown) => respond({ data }), (error: unknown) => respond({ error: messageOf(error) }));
      }
    }
    if (!open) respond({ none: true });
  };

  const onOpen = (wire: Wire & { k: "open" }, from: number) => {
    const { connect: event } = events[wire.to];
    if (!event.event.hasListeners()) return post(() => from, { k: "close", port: wire.port, side: "opener", error: NO_RECEIVER });
    event.dispatch(createPort(wire.port, "receiver", wire.name, () => from, wire.sender));
    post(() => from, { k: "accepted", port: wire.port });
  };

  const refuse = (wire: Wire & { k: "msg" | "open" }, from: number) =>
    post(() => from, wire.k === "msg" ? { k: "reply", id: wire.id, error: NO_RECEIVER } : { k: "close", port: wire.port, side: "opener", error: NO_RECEIVER });

  const handle = (payload: unknown, from: number): void => {
    const wire = payload as Wire;
    switch (wire.k) {
      case "msg":
      case "open":
        if (wire.to === "background" && !backgroundReady) {
          const entry = {
            wire,
            from,
            timer: setTimeout(() => {
              if (!held.includes(entry)) return;
              // Refused: it goes, and so does anything held for the port it would have opened.
              const port = wire.k === "open" ? wire.port : undefined;
              held.splice(0, held.length, ...held.filter((other) => other !== entry && !("port" in other.wire && other.wire.port === port)));
              refuse(wire, from);
            }, HOLD_MS),
          };
          held.push(entry);
        } else if (wire.k === "msg") onMessage(wire, from);
        else onOpen(wire, from);
        return;
      case "reply":
        pending.get(wire.id)?.settle(wire);
        return;
      case "accepted":
        ports.get(`${wire.port}:opener`)?.accepted?.();
        return;
      case "post":
      case "close": {
        const port = ports.get(`${wire.port}:${wire.side}`);
        if (!port && opening(wire.port)) held.push({ wire, from });
        else if (wire.k === "post") port?.receive(wire.data);
        else port?.close(wire.error);
        return;
      }
      case "ctl":
        deps.control(wire.op, wire.args).then(
          (data) => post(() => from, { k: "reply", id: wire.id, data }),
          (error: unknown) => post(() => from, { k: "reply", id: wire.id, error: messageOf(error) }),
        );
        return;
    }
  };

  /** A target for one tab: nobody, if no such tab is live. */
  const tab = (tabId: number) => () => (deps.exists(tabId) ? tabId : undefined);

  /** The runtime.* messaging members for content scripts or the background. */
  const runtime = (endpoint: Endpoint) => ({
    sendMessage: (...args: unknown[]) => {
      // (extensionId?, message, options?, callback?), aligned as Chrome aligns them: with two arguments left, the first is
      // the extension id only if it can be one (a string or null); otherwise the second is options.
      let last = args.length - 1;
      const callback = typeof args[last] === "function" ? (args[last--] as (response?: unknown) => void) : undefined;
      if (last > 1 || (last === 1 && !(args[0] === null || typeof args[0] === "string"))) last--;
      const message = args[last];
      const extensionId = last >= 1 ? args[last - 1] : undefined;
      const external = typeof extensionId === "string" && extensionId !== deps.extensionId;
      // Content scripts reach the background. The background reaches extension pages, and this version has none.
      const target = endpoint === "content" && !external ? deps.leader : () => undefined;
      return send(target, "background", message, endpoint, callback);
    },
    onMessage: events[endpoint].message.event,
    connect: (...args: unknown[]): Port => {
      const info = (typeof args[args.length - 1] === "object" ? args[args.length - 1] : undefined) as { name?: string } | undefined;
      return connect(endpoint === "content" ? deps.leader : () => undefined, "background", info?.name ?? "", endpoint);
    },
    onConnect: events[endpoint].connect.event,
  });

  return {
    /** Starts sending through the bus; anything sent before then goes now. */
    attach(sendWire: (to: number, wire: unknown) => Promise<void>) {
      transport = sendWire;
      for (const go of queued.splice(0)) go();
    },
    /** The bus handler: every wire message for this page. */
    handle,
    /** Whether this page's background has started (and still leads); until then, background messages are held. */
    setBackgroundReady(ready: boolean) {
      backgroundReady = ready;
      if (!ready) return;
      for (const entry of held.splice(0)) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        handle(entry.wire, entry.from);
      }
    },
    /** A page went away: its pending replies settle as closed, and ports to it disconnect. */
    peerGone(id: number) {
      for (const entry of [...pending.values()]) if (entry.to === id && !entry.resend?.()) entry.settle({ none: true });
      for (const port of [...ports.values()]) if (port.peer() === id && !port.reroute?.()) port.close();
    },
    runtime,
    tabs: {
      sendMessage: (tabId: number, message: unknown, ...rest: unknown[]) => {
        const callback = typeof rest[rest.length - 1] === "function" ? (rest.pop() as (response?: unknown) => void) : undefined;
        return send(tab(tabId), "content", message, "background", callback);
      },
      connect: (tabId: number, info?: { name?: string }) => connect(tab(tabId), "content", info?.name ?? "", "background"),
    },
    /** Asks another page to run a control request (the tabs API's update, reload and remove). */
    control: async (tabId: number, op: string, args: unknown): Promise<unknown> => {
      const id = nextId();
      const outcome = await request(tab(tabId), id, () => ({ k: "ctl", id, op, args }));
      if (outcome.error !== undefined) throw new Error(outcome.error);
      return outcome.data;
    },
  };
}
