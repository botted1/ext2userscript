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

export async function startBus(gm: Gm, ns: string, registry: Registry): Promise<Bus> {
  const k = keys(ns);
  const me = registry.me;
  const startedAt = Date.now();
  const epoch = Math.random().toString(36).slice(2);
  const handlers: Array<(payload: unknown, from: number) => void> = [];
  const ring: Envelope[] = [];
  // Per sender. Kept after a tab leaves, so a tab that comes back isn't replayed from the start.
  const read = new Map<number, { epoch: string; seq: number }>();
  const listening = new Map<number, Promise<number | string>>();
  let seq = 0;
  let dropped = 0;
  let warned = false;

  const deliver = (payload: unknown, from: number) => {
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
    if (!outbox) return;
    const previous = read.get(from);
    const continuing = previous !== undefined && previous.epoch === outbox.epoch ? previous.seq : undefined;
    if (continuing !== undefined && outbox.msgs[0].seq > continuing + 1) {
      dropped += outbox.msgs[0].seq - continuing - 1;
      if (!warned) {
        warned = true;
        console.warn(`[ext2userscript] missed cross-tab messages from tab ${from}: its outbox moved on before this tab read it`);
      }
    }
    for (const env of outbox.msgs) {
      // Same epoch: anything newer than what was read. New epoch (the sender navigated): all of it.
      // First contact: only what was sent after this tab started.
      const fresh = continuing !== undefined ? env.seq > continuing : previous !== undefined || env.t >= startedAt;
      if (fresh && (env.to === me || env.to === "*")) deliver(env.payload, from);
    }
    read.set(from, { epoch: outbox.epoch, seq: outbox.msgs[outbox.msgs.length - 1].seq });
  };

  const listen = (id: number) => {
    if (listening.has(id)) return;
    listening.set(
      id,
      (async () => {
        const listener = await gm.addValueChangeListener(k.out(id), (_key, _old, value) => receive(id, value));
        receive(id, await gm.getValue(k.out(id))); // catch up on anything sent before this tab was listening
        return listener;
      })(),
    );
  };
  const unlisten = (id: number) => {
    const listener = listening.get(id);
    listening.delete(id);
    void listener?.then((l) => gm.removeValueChangeListener(l));
  };

  registry.onAdded((tab) => listen(tab.id));
  registry.onRemoved(unlisten);
  for (const tab of registry.live()) listen(tab.id);
  await Promise.all(listening.values());

  return {
    send: async (to, payload) => {
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
      for (const id of [...listening.keys()]) unlisten(id);
      await gm.deleteValue(k.out(me));
    },
  };
}
