import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Closes the socket without answering, to look like a dropped connection. */
  drop?: boolean;
  /** Waits this long before answering, to look like a slow server. */
  delayMs?: number;
}

export interface TestServer {
  baseUrl: string;
  requests: Recorded[];
  close(): Promise<void>;
}

/** A real HTTP server on a random local port. `answer` is called for every request, with the attempt number (from 1). */
export async function startServer(answer: (request: Recorded, attempt: number) => Answer | Promise<Answer>): Promise<TestServer> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const recorded: Recorded = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(recorded);
      const a = await answer(recorded, requests.length);
      if (a.delayMs) await new Promise((resolve) => setTimeout(resolve, a.delayMs));
      if (a.drop) {
        req.socket.destroy();
        return;
      }
      const hasBody = a.body !== undefined;
      res.writeHead(a.status, { ...(hasBody ? { "Content-Type": "application/json; charset=utf-8" } : {}), ...a.headers });
      res.end(hasBody ? (typeof a.body === "string" ? a.body : JSON.stringify(a.body)) : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
