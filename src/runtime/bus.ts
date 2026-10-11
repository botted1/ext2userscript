// Cross-tab messaging (spec §5.3).
// - Each tab writes only its own outbox key, so concurrent senders never overwrite each other.
// - Every tab listens to the outboxes of the live tabs and tracks what it has read.
import type { Gm } from "./gm.ts";
import { keys } from "./keys.ts";
import type { Registry } from "./registry.ts";

export type Envelope = { seq: number; t: number; to: number | "*"; payload: unknown };
type Outbox = { epoch: string; msgs: Envelope[] };

/** An outbox keeps at most RING_SIZE messages, none older than RING_MAX_AGE_MS. */
export const RING_SIZE = 64;
export const RING_MAX_AGE_MS = 10_000;
/** Epochs remembered per sender, so a page that returns from the back/forward cache is not replayed. */
const EPOCHS_KEPT = 4;

export type Bus = {
  /** Send to one tab, or "*" for every other tab. Sending to this tab delivers locally. */
  send(to: number | "*", payload: unknown): Promise<void>;
  onMessage(fn: (payload: unknown, from: number) => void): void;
  /** Messages lost because a sender's outbox moved on before this tab read it (spec §5.3). */
  readonly dropped: number;
  stop(): Promise<void>;
};

const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === "object" && value !== null && typeof (value as Envelope).seq === "number" && typeof (value as Envelope).t === "number";

function readOutbox(value: unknown): Outbox | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { epoch, msgs } = value as Partial<Outbox>;
  if (typeof epoch !== "string" || !Array.isArray(msgs)) return undefined;
  const valid = msgs.filter(isEnvelope);
  return valid.length > 0 ? { epoch, msgs: valid } : undefined;
}

/** handler, when given, is attached before the bus reads any outbox, so the catch-up read reaches it too. */
export async function startBus(gm: Gm, ns: string, registry: Registry, handler?: (payload: unknown, from: number) => void): Promise<Bus> {
  const k = keys(ns);
  const me = registry.me;
  const startedAt = Date.now();
  const epoch = Math.random().toString(36).slice(2);
  const handlers: Array<(payload: unknown, from: number) => void> = handler ? [handler] : [];
  const ring: Envelope[] = [];
  // Per sender, per epoch: the last seq delivered. Kept after a tab leaves, so a tab that comes back isn't replayed.
  const read = new Map<number, Map<string, number>>();
  // Per sender: this bus's listener on its outbox. Resolves to the listener id, or to undefined if registering failed.
  const listening = new Map<number, Promise<number | string | undefined>>();
  let seq = 0;
  let dropped = 0;
  let warned = false;
  let stopped = false;

  const deliver = (payload: unknown, from: number) => {
    if (stopped) return;
    for (const fn of handlers) {
      try {
        fn(payload, from);
      } catch (error) {
        console.error("[ext2userscript] message handler threw", error);
      }
    }
  };

  const receive = (from: number, value: unknown) => {
    const outbox = readOutbox(value);
    if (stopped || !outbox) return;
    const epochs = read.get(from) ?? new Map<string, number>();
    const seen = epochs.get(outbox.epoch);
    // A sender heard from before counts a new epoch from 0. A sender heard from for the first time counts no gap.
    const base = seen ?? (epochs.size > 0 ? 0 : undefined);
    if (base !== undefined && outbox.msgs[0].seq > base + 1) {
      dropped += outbox.msgs[0].seq - base - 1;
      if (!warned) {
        warned = true;
        console.warn(`[ext2userscript] missed cross-tab messages from tab ${from}: its outbox moved on before this tab read it`);
      }
    }
    for (const env of outbox.msgs) {
      // An epoch already read: anything newer than what was read. An epoch not read yet: only what was sent after this tab started.
      const fresh = seen !== undefined ? env.seq > seen : env.t >= startedAt;
      if (fresh && (env.to === me || env.to === "*")) deliver(env.payload, from);
    }
    if (seen === undefined && epochs.size >= EPOCHS_KEPT) {
      const oldest = epochs.keys().next().value;
      if (oldest !== undefined) epochs.delete(oldest);
    }
    epochs.set(outbox.epoch, Math.max(seen ?? 0, outbox.msgs[outbox.msgs.length - 1].seq));
    read.set(from, epochs);
  };

  // Removes a listener. Never rejects: a failure is logged.
  const detach = async (listener: number | string) => {
    try {
      await gm.removeValueChangeListener(listener);
    } catch (error) {
      console.error("[ext2userscript] cannot remove a cross-tab listener", error);
    }
  };
  // Never rejects: a failure is logged, a listener added before the failure is removed, and the result is undefined.
  const register = async (id: number): Promise<number | string | undefined> => {
    let listener: number | string | undefined;
    try {
      listener = await gm.addValueChangeListener(k.out(id), (_key, _old, value) => receive(id, value));
      receive(id, await gm.getValue(k.out(id))); // catch up on anything sent before this tab was listening
      return listener;
    } catch (error) {
      console.error(`[ext2userscript] cannot listen to tab ${id}'s outbox`, error);
      if (listener !== undefined) await detach(listener);
      return undefined;
    }
  };
  const listen = (id: number) => {
    if (stopped || listening.has(id)) return;
    const registration = register(id);
    listening.set(id, registration);
    // A failed registration is forgotten, so the next join for this tab retries it.
    void registration.then((listener) => {
      if (listener === undefined && listening.get(id) === registration) listening.delete(id);
    });
  };
  const unlisten = async (id: number) => {
    const registration = listening.get(id);
    listening.delete(id);
    const listener = await registration;
    if (listener !== undefined) await detach(listener);
  };

  registry.onAdded((tab) => listen(tab.id));
  registry.onRemoved((id) => {
    if (!stopped) void unlisten(id);
  });
  for (const tab of registry.live()) listen(tab.id);
  await Promise.all(listening.values());

  return {
    send: async (to, payload) => {
      if (stopped) throw new Error("ext2userscript: the cross-tab bus has stopped");
      const copy: unknown = payload === undefined ? null : JSON.parse(JSON.stringify(payload));
      if (to === me) {
        queueMicrotask(() => deliver(copy, me));
        return;
      }
      const now = Date.now();
      ring.push({ seq: ++seq, t: now, to, payload: copy });
      while (ring.length > RING_SIZE || (ring.length > 1 && ring[0].t < now - RING_MAX_AGE_MS)) ring.shift();
      await gm.setValue(k.out(me), { epoch, msgs: ring });
    },
    onMessage: (fn) => {
      handlers.push(fn);
    },
    get dropped() {
      return dropped;
    },
    stop: async () => {
      stopped = true;
      await Promise.all([...listening.keys()].map((id) => unlisten(id)));
      await gm.deleteValue(k.out(me));
    },
  };
}
