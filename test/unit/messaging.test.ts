import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { startBus } from "../../src/runtime/bus.ts";
import { createLogger, readLastError } from "../../src/runtime/chrome.ts";
import { leaderOf } from "../../src/runtime/elect.ts";
import { createGm } from "../../src/runtime/gm.ts";
import { createMessaging, NO_RECEIVER, PORT_CLOSED, type Port } from "../../src/runtime/messaging.ts";
import { startRegistry } from "../../src/runtime/registry.ts";
import { createHub, type Hub } from "../support/gm-hub.ts";
import { eventually, sleep } from "../support/time.ts";

type Listener = (message: unknown, sender: { tab?: { id: number }; url?: string }, sendResponse: (response?: unknown) => void) => unknown;
type Runtime = {
  sendMessage(...args: unknown[]): Promise<unknown> | undefined;
  onMessage: { addListener(fn: Listener): void };
  connect(info?: { name?: string }): Port;
  onConnect: { addListener(fn: (port: Port) => void): void };
};

/** One page: registry, bus and router over the shared hub, with fast timings. */
async function page(t: TestContext, hub: Hub, id: number, control: (op: string, args: unknown) => Promise<unknown> = async () => null) {
  const gm = createGm(hub.tab());
  const registry = await startRegistry(gm, "t", id, () => ({ url: `https://site.test/${id}`, title: `page ${id}`, frame: false, active: false, activeAt: 0 }), { heartbeatMs: 20, staleMs: 5_000 });
  const messaging = createMessaging({
    extensionId: "ext",
    log: createLogger("test"),
    leader: () => leaderOf(registry),
    exists: (other) => other === id || registry.live().some((tab) => tab.id === other),
    sender: (from) => (from === "content" ? { id: "ext", url: `https://site.test/${id}`, tab: { id } } : { id: "ext", url: "chrome-extension://ext/sw.js" }),
    control,
  });
  const bus = await startBus(gm, "t", registry, messaging.handle);
  messaging.attach((to, wire) => bus.send(to, wire));
  registry.onRemoved((gone) => messaging.peerGone(gone));
  t.after(async () => {
    await bus.stop();
    await registry.stop();
  });
  return {
    registry,
    messaging,
    content: messaging.runtime("content") as unknown as Runtime,
    background: messaging.runtime("background") as unknown as Runtime,
  };
}

describe("messaging", () => {
  it("reads sendMessage's arguments as Chrome does: an undefined callback or an options object isn't the message", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    leader.messaging.setBackgroundReady(true);
    const seen: unknown[] = [];
    leader.background.onMessage.addListener((message, _sender, sendResponse) => {
      seen.push(message);
      sendResponse("ok");
    });
    assert.equal(await leader.content.sendMessage({ type: "hello" }, undefined), "ok");
    assert.equal(await leader.content.sendMessage({ type: "options" }, { includeTlsChannelId: false }), "ok");
    assert.equal(await leader.content.sendMessage("ext", { type: "with id" }), "ok");
    assert.equal(await leader.content.sendMessage("ext", { type: "with id and options" }, {}), "ok");
    assert.deepEqual(seen, [{ type: "hello" }, { type: "options" }, { type: "with id" }, { type: "with id and options" }]);
  });

  it("delivers a content script's message to the leader's background and returns its synchronous response", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    await sleep(5);
    const other = await page(t, hub, 2);
    leader.messaging.setBackgroundReady(true);
    other.messaging.setBackgroundReady(true);
    leader.background.onMessage.addListener((message, sender, sendResponse) => sendResponse({ echo: message, from: sender.tab?.id }));
    assert.deepEqual(await other.content.sendMessage({ hi: 1 }), { echo: { hi: 1 }, from: 2 });
    assert.deepEqual(await leader.content.sendMessage("same tab"), { echo: "same tab", from: 1 });
  });

  it("waits for a response when a listener returns true or a promise", async (t) => {
    const hub = createHub();
    const tab = await page(t, hub, 1);
    tab.messaging.setBackgroundReady(true);
    tab.background.onMessage.addListener((message, _sender, sendResponse) => {
      if (message === "later") {
        setTimeout(() => sendResponse("done later"), 20);
        return true;
      }
      return undefined;
    });
    // Not an async function: a returned promise always answers, even with undefined, in Chrome as here.
    tab.background.onMessage.addListener((message) => (message === "promise" ? Promise.resolve("from a promise") : undefined));
    assert.equal(await tab.content.sendMessage("later"), "done later");
    assert.equal(await tab.content.sendMessage("promise"), "from a promise");
  });

  it("resolves undefined when nobody responds, and calls back with lastError set", async (t) => {
    const hub = createHub();
    const tab = await page(t, hub, 1);
    tab.messaging.setBackgroundReady(true);
    tab.background.onMessage.addListener(() => undefined);
    assert.equal(await tab.content.sendMessage("ignored"), undefined);
    const lastError = await new Promise((resolve) => tab.content.sendMessage("ignored", () => resolve(readLastError()?.message)));
    assert.equal(lastError, PORT_CLOSED);
  });

  it("fails with 'Receiving end does not exist' when nothing listens", async (t) => {
    const hub = createHub();
    const tab = await page(t, hub, 1);
    tab.messaging.setBackgroundReady(true);
    await assert.rejects(tab.content.sendMessage("nobody") as Promise<unknown>, new RegExp(NO_RECEIVER.replace(/\./g, "\\.")));
    // The background reaches extension pages, and there are none.
    await assert.rejects(tab.background.sendMessage("pages?") as Promise<unknown>, /Receiving end does not exist/);
  });

  it("holds a message for the background until it is ready", async (t) => {
    const hub = createHub();
    const tab = await page(t, hub, 1);
    const reply = tab.content.sendMessage("early");
    await sleep(30);
    tab.background.onMessage.addListener((_message, _sender, sendResponse) => sendResponse("started"));
    tab.messaging.setBackgroundReady(true);
    assert.equal(await reply, "started");
  });

  it("sends a background message again when the page it went to goes away unanswered", async (t) => {
    const hub = createHub();
    // A ghost leader: an old tab whose key outlived it. It never answers; the next oldest page should.
    const ghost = await page(t, hub, 1);
    await sleep(5);
    const live = await page(t, hub, 2);
    live.messaging.setBackgroundReady(true);
    live.background.onMessage.addListener((_message, _sender, sendResponse) => sendResponse("from the live leader"));
    await eventually(() => live.registry.live().length === 1, 1000);
    const reply = live.content.sendMessage("hello");
    await sleep(30);
    await ghost.registry.leave();
    assert.equal(await reply, "from the live leader");
  });

  it("delivers tabs.sendMessage from the background to one tab's content scripts", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    const other = await page(t, hub, 2);
    other.content.onMessage.addListener((message, sender, sendResponse) => sendResponse(`tab 2 got ${message} from ${sender.url}`));
    await eventually(() => leader.registry.live().length === 1, 1000);
    const reply = await (leader.messaging.tabs.sendMessage(2, "ping") as Promise<unknown>);
    assert.equal(reply, "tab 2 got ping from chrome-extension://ext/sw.js");
    await assert.rejects(leader.messaging.tabs.sendMessage(99, "nobody") as Promise<unknown>, /Receiving end does not exist/);
  });

  it("settles a pending request as closed when the other page goes away", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    const other = await page(t, hub, 2);
    other.content.onMessage.addListener(() => true); // keeps the channel open and never answers
    await eventually(() => leader.registry.live().length === 1, 1000);
    const reply = leader.messaging.tabs.sendMessage(2, "hello") as Promise<unknown>;
    await sleep(30);
    await other.registry.leave();
    assert.equal(await reply, undefined);
  });

  it("connects ports both ways, with names, messages and disconnects", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    const other = await page(t, hub, 2);
    leader.messaging.setBackgroundReady(true);
    const backgroundSaw: unknown[] = [];
    leader.background.onConnect.addListener((port) => {
      backgroundSaw.push(`connect ${port.name} from ${(port.sender as { tab: { id: number } }).tab.id}`);
      port.onMessage.addListener((message) => port.postMessage({ echo: message }));
      port.onDisconnect.addListener(() => backgroundSaw.push("disconnected"));
    });
    await eventually(() => other.registry.live().length === 1, 1000);
    const port = other.content.connect({ name: "chan" });
    const replies: unknown[] = [];
    port.onMessage.addListener((message) => replies.push(message));
    port.postMessage(1);
    port.postMessage(2);
    await eventually(() => replies.length === 2, 1000);
    assert.deepEqual(replies, [{ echo: 1 }, { echo: 2 }]);
    port.disconnect();
    await eventually(() => backgroundSaw.length === 2, 1000);
    assert.deepEqual(backgroundSaw, ["connect chan from 2", "disconnected"]);
    assert.throws(() => port.postMessage(3), /disconnected port/);
  });

  it("keeps a port's first messages while its background is starting", async (t) => {
    const hub = createHub();
    const tab = await page(t, hub, 1);
    const port = tab.content.connect({ name: "early" });
    const replies: unknown[] = [];
    port.onMessage.addListener((message) => replies.push(message));
    port.postMessage("first");
    await sleep(30);
    tab.background.onConnect.addListener((opened) => opened.onMessage.addListener((message) => opened.postMessage(`got ${message}`)));
    tab.messaging.setBackgroundReady(true);
    await eventually(() => replies.length === 1, 1000);
    assert.deepEqual(replies, ["got first"]);
  });

  it("opens a port again at the new leader when the first page leaves before taking it", async (t) => {
    const hub = createHub();
    const ghost = await page(t, hub, 1);
    await sleep(5);
    const live = await page(t, hub, 2);
    live.messaging.setBackgroundReady(true);
    live.background.onConnect.addListener((opened) => opened.onMessage.addListener((message) => opened.postMessage(`live got ${message}`)));
    await eventually(() => live.registry.live().length === 1, 1000);
    const port = live.content.connect();
    const replies: unknown[] = [];
    port.onMessage.addListener((message) => replies.push(message));
    port.postMessage("hi");
    await sleep(30);
    await ghost.registry.leave();
    await eventually(() => replies.length === 1, 1000);
    assert.deepEqual(replies, ["live got hi"]);
  });

  it("disconnects a port whose other end has no onConnect listener, with lastError set", async (t) => {
    const hub = createHub();
    const tab = await page(t, hub, 1);
    tab.messaging.setBackgroundReady(true);
    const port = tab.content.connect();
    const error = await new Promise((resolve) => port.onDisconnect.addListener(() => resolve(readLastError()?.message)));
    assert.equal(error, NO_RECEIVER);
  });

  it("disconnects ports when the other page goes away", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    const other = await page(t, hub, 2);
    leader.messaging.setBackgroundReady(true);
    leader.background.onConnect.addListener(() => {});
    await eventually(() => other.registry.live().length === 1, 1000);
    const port = other.content.connect();
    let disconnected = false;
    port.onDisconnect.addListener(() => (disconnected = true));
    await sleep(30);
    await leader.registry.leave();
    await eventually(() => disconnected, 1000);
  });

  it("runs another page's control requests and returns their result", async (t) => {
    const hub = createHub();
    const leader = await page(t, hub, 1);
    const seen: unknown[] = [];
    await page(t, hub, 2, async (op, args) => {
      seen.push([op, args]);
      if (op === "fail") throw new Error("can't");
      return "ok";
    });
    await eventually(() => leader.registry.live().length === 1, 1000);
    assert.equal(await leader.messaging.control(2, "navigate", { url: "https://x.test/" }), "ok");
    await assert.rejects(leader.messaging.control(2, "fail", null), /can't/);
    assert.deepEqual(seen, [["navigate", { url: "https://x.test/" }], ["fail", null]]);
  });
});
