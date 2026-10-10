// Spike S4 (spec §11): election and outbox protocol under churn. Emulator by default; release tier with
// X2U_BACKENDS=tm,vm. S4_CHURN_MS sets the churn phase (default 60s, as the spec asks).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext, Page } from "playwright";
import { backendsFromEnv, startSession } from "../../bench/session.ts";
import { GRANTS } from "../../src/runtime/gm.ts";
import { readAttr, waitForAttr } from "../support/dom.ts";
import { startServer, type Server } from "../support/server.ts";
import { sleep } from "../support/time.ts";
import { buildUserscript } from "../support/userscript.ts";

const CHURN_MS = Number(process.env.S4_CHURN_MS ?? 60_000);
/** Staleness + heartbeat + grace + slack, in case a close skipped pagehide. */
const SETTLE_MS = 3_000 + 200 + 300 + 1_000;
const s4Page = () => new Response("<!doctype html><html><head><title>s4</title></head><body>s4</body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });

for (const backend of backendsFromEnv()) {
  describe(`S4 cross-tab protocol on ${backend}`, () => {
    let siteA: Server;
    let siteB: Server;
    let userscript: string;

    before(async () => {
      siteA = await startServer({ "/s4.html": s4Page });
      siteB = await startServer({ "/s4.html": s4Page });
      userscript = await buildUserscript(`${import.meta.dirname}/probes/s4.ts`, {
        name: "ext2userscript S4",
        match: [`${siteA.origin}/*`, `${siteB.origin}/*`],
        grant: Object.values(GRANTS).flat(),
        runAt: "document-end",
        isolated: true,
      });
    });

    after(async () => {
      await siteA.close();
      await siteB.close();
    });

    async function open(context: BrowserContext, url: string): Promise<Page> {
      const tab = await context.newPage();
      await tab.goto(url);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [ready, error] = await Promise.all([readAttr(tab, "data-ready"), readAttr(tab, "data-error")]);
        if (error !== null) throw new Error(`S4 probe failed: ${error}`);
        if (ready === "1") return tab;
        if (Date.now() > deadline) throw new Error(`Timed out after 10000ms waiting for <html data-ready="1"> (last value: ${ready})`);
        await tab.waitForTimeout(100);
      }
    }

    /** data-delivered counts every delivery, data-received only distinct messages. */
    async function assertNoDuplicates(receiver: Page) {
      const [delivered, received] = await Promise.all([readAttr(receiver, "data-delivered"), readAttr(receiver, "data-received")]);
      assert.equal(delivered, received, "a message was delivered more than once");
    }

    it("delivers 1,000 spaced messages and a 50-message burst without loss", async () => {
      const session = await startSession(backend, userscript);
      try {
        const run = `m${Date.now()}`;
        const receiver = await open(session.context, `${siteB.origin}/s4.html?run=${run}&id=2`);
        const sender = await open(session.context, `${siteA.origin}/s4.html?run=${run}&id=1&sendTo=2&count=1000&spacingMs=5`);
        await waitForAttr(sender, "data-sent", "1000", 90_000);
        await waitForAttr(receiver, "data-received", "1000", 15_000);
        await assertNoDuplicates(receiver);
        assert.equal(await readAttr(receiver, "data-dropped"), "0");
        await open(session.context, `${siteA.origin}/s4.html?run=${run}&id=3&sendTo=2&count=50&spacingMs=0`);
        await waitForAttr(receiver, "data-received", "1050", 30_000);
        await assertNoDuplicates(receiver);
        assert.equal(await readAttr(receiver, "data-dropped"), "0");
        console.log(`[${backend}] S4 messages: received ${await readAttr(receiver, "data-received")}, dropped ${await readAttr(receiver, "data-dropped")}`);
      } finally {
        await session.close();
      }
    });

    it("has exactly one leader after each settle period, through tab churn", async () => {
      const session = await startSession(backend, userscript);
      try {
        const run = `e${Date.now()}`;
        const tabs = new Map<number, Page>();
        let nextId = 1;
        const openTab = async () => {
          const id = nextId++;
          const origin = id % 2 === 0 ? siteB.origin : siteA.origin;
          tabs.set(id, await open(session.context, `${origin}/s4.html?run=${run}&id=${id}`));
        };
        const countLeaders = async () => {
          const flags = await Promise.all([...tabs.values()].map((tab) => readAttr(tab, "data-leader")));
          return flags.filter((flag) => flag === "1").length;
        };
        for (let i = 0; i < 5; i++) await openTab();
        const end = Date.now() + CHURN_MS;
        let checks = 0;
        let single = 0;
        do {
          for (let i = 0; i < 5; i++) {
            const ids = [...tabs.keys()];
            const victim = ids[Math.floor(Math.random() * ids.length)];
            // Half the closes run unload handlers (the pagehide delete); the rest leave the key to go stale.
            await tabs.get(victim)?.close({ runBeforeUnload: Math.random() < 0.5 });
            tabs.delete(victim);
            await openTab();
            await sleep(200 + Math.random() * 600);
          }
          await sleep(SETTLE_MS);
          checks++;
          assert.equal(await countLeaders(), 1, `expected exactly one leader after settling (check ${checks})`);
          single++;
        } while (Date.now() < end);
        console.log(`[${backend}] S4 churn: ${checks} settle checks, ${single} with exactly one leader`);
      } finally {
        await session.close();
      }
    });
  });
}
