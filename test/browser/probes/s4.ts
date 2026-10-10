// Spike S4 probe (spec §11): registry + bus + election on real pages, with scaled-down timings.
// Reports on <html data-ready | data-leader | data-received | data-delivered | data-dropped | data-sent>.
// data-received counts distinct messages; data-delivered counts every delivery, so a duplicate shows as delivered > received.
import { startBus } from "../../../src/runtime/bus.ts";
import { startElection } from "../../../src/runtime/elect.ts";
import { createGm } from "../../../src/runtime/gm.ts";
import { startRegistry } from "../../../src/runtime/registry.ts";

const html = document.documentElement;
const params = new URLSearchParams(location.search);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

if (location.pathname === "/s4.html") main().catch((error: unknown) => html.setAttribute("data-error", String(error)));

async function main() {
  const gm = createGm();
  const ns = `s4-${params.get("run")}`;
  const me = Number(params.get("id"));
  const registry = await startRegistry(gm, ns, me, () => ({ url: location.href, title: document.title }), { heartbeatMs: 200, staleMs: 3_000 });
  const bus = await startBus(gm, ns, registry);
  html.setAttribute("data-leader", "0");
  startElection(registry, { acquire: () => html.setAttribute("data-leader", "1"), lose: () => html.setAttribute("data-leader", "0") }, { graceMs: 300 });
  addEventListener("pagehide", () => {
    void registry.leave();
  });
  addEventListener("pageshow", (event) => {
    if (event.persisted) void registry.rejoin();
  });

  const received = new Set<string>();
  let delivered = 0;
  bus.onMessage((payload, from) => {
    html.setAttribute("data-delivered", String(++delivered));
    received.add(`${from}:${(payload as { n: number }).n}`);
    html.setAttribute("data-received", String(received.size));
    html.setAttribute("data-dropped", String(bus.dropped));
  });
  html.setAttribute("data-ready", "1");

  const to = params.get("sendTo");
  if (!to) return;
  const target = Number(to);
  while (!registry.live().some((tab) => tab.id === target)) await sleep(50);
  await sleep(1_000); // the target has heard this tab's roster ring by now and is reading its outbox
  const count = Number(params.get("count"));
  const spacingMs = Number(params.get("spacingMs"));
  for (let n = 1; n <= count; n++) {
    await bus.send(target, { n });
    if (spacingMs > 0) await sleep(spacingMs);
  }
  html.setAttribute("data-sent", String(count));
}
