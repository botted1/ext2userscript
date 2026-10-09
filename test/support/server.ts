// A small HTTP server for browser tests. Routes are Fetch-API handlers keyed by path.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (request: Request) => Response | Promise<Response>;
export type Server = { origin: string; port: number; close(): Promise<void> };

const SKIPPED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"]);

export async function startServer(routes: Record<string, Handler>, port = 0): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const handler = routes[url.pathname];
      if (!handler) {
        res.writeHead(404).end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string" && !SKIPPED_HEADERS.has(name)) headers.set(name, value);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(url, { method: req.method, headers, body: hasBody ? new Uint8Array(Buffer.concat(chunks)) : undefined });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${actual}`,
    port: actual,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
