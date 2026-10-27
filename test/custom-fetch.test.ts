import { afterEach, describe, expect, it, vi } from "vitest";
import { EspressoNotify, EspressoNotifyAbortError, EspressoNotifyApiError, EspressoNotifyConfigError, type FetchFunction } from "../src";
import { calls } from "./support/calls";
import { allFixtures, fixture } from "./support/fixtures";
import { startServer, type Recorded, type TestServer } from "./support/server";

// SRVL-02 (T25, assessment.md): a caller can hand the library its own fetch (a proxy, a custom undici dispatcher, a logger) and
// every request of every operation goes through it, with the same headers and body as the global one would send.

const KEY = "sk_live_" + "ExampleSecretKeyForTests0123456789";
const send = fixture("sendTransactional");
const servers: TestServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function serve(answer: Parameters<typeof startServer>[0]): Promise<TestServer> {
  const s = await startServer(answer);
  servers.push(s);
  return s;
}
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const shape = (r: Recorded) => ({ method: r.method, url: r.url, body: r.body.replace(UUID, "<uuid>"), headers: { ...r.headers, host: undefined, "idempotency-key": undefined } });
const accepted = () => ({ status: send.response.status, headers: send.response.headers, body: send.response.body });

describe("the fetch option", () => {
  it("receives every request of the 14 operations, and the server sees what it would have seen without it", async () => {
    const answerFor = (r: Recorded) => {
      const f = allFixtures().find((x) => x.method === r.method && new RegExp(`^${x.pathTemplate.replace(/\{[^}]+\}/g, "[^/?]+")}$`).test(r.url.split("?")[0]!))!;
      return { status: f.response.status, headers: f.response.headers, body: f.response.body };
    };
    const plain = await serve(answerFor);
    const viaCustom = await serve(answerFor);
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const spy: FetchFunction = (url, init) => {
      seen.push({ url, init: init! });
      return fetch(url, init);
    };
    const a = new EspressoNotify({ apiKey: KEY, baseUrl: plain.baseUrl });
    const b = new EspressoNotify({ apiKey: KEY, baseUrl: viaCustom.baseUrl, fetch: spy });
    for (const f of allFixtures()) {
      await calls[f.operationId]!(a, f);
      await calls[f.operationId]!(b, f);
    }
    expect(seen).toHaveLength(14);
    expect(viaCustom.requests.map(shape)).toEqual(plain.requests.map(shape));
    for (const { url, init } of seen) {
      const headers = init.headers as Record<string, string>;
      expect(url.startsWith(viaCustom.baseUrl + "/v1/")).toBe(true);
      expect(headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(headers["User-Agent"]).toMatch(/^espresso-notify-node\//);
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    const body = seen.find((s) => s.url.endsWith("/notifications/transactional"))!.init.body;
    expect(String(body)).toContain(send.request.body.title);
  });

  it("is used for every attempt of a retried call, and the global fetch is not touched", async () => {
    const server = await serve((_r, n) => (n === 1 ? { status: 503, headers: { "Retry-After": "0" } } : accepted()));
    const global = vi.spyOn(globalThis, "fetch");
    let used = 0;
    const client = new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, fetch: (url, init) => (used++, fetch(url, init)) });
    global.mockClear();
    await client.notifications.transactional(send.request.body);
    expect(used).toBe(2);
    expect(global).toHaveBeenCalledTimes(2); // only through the custom function, which calls the global one itself
  });

  it("when it is left out, the global fetch sends the request", async () => {
    const server = await serve(() => accepted());
    const global = vi.spyOn(globalThis, "fetch");
    await new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }).notifications.transactional(send.request.body);
    expect(global).toHaveBeenCalledTimes(1);
    expect(String(global.mock.calls[0]![0])).toBe(`${server.baseUrl}/v1/notifications/transactional`);
  });

  it("can stand for a proxy: the library calls the public address and the function sends it elsewhere", async () => {
    const server = await serve(() => accepted());
    const client = new EspressoNotify({
      apiKey: KEY,
      fetch: (url, init) => fetch(url.replace("https://api.espressonotify.com", server.baseUrl), init),
    });
    await expect(client.notifications.transactional(send.request.body)).resolves.toBeDefined();
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("must be a function, or the client is not built", () => {
    for (const bad of ["fetch", 5, null, {}, true]) {
      const error = (() => {
        try {
          new EspressoNotify({ apiKey: KEY, fetch: bad as never });
        } catch (e) {
          return e as EspressoNotifyConfigError;
        }
      })();
      expect(error, String(bad)).toBeInstanceOf(EspressoNotifyConfigError);
      expect(error!.code).toBe("invalid_option");
      expect(error!.message).toContain("fetch");
    }
    expect(() => new EspressoNotify({ apiKey: KEY, fetch: undefined })).not.toThrow();
  });

  describe("what the function does wrong is still an error of the library", () => {
    const client = (fetchFn: unknown, extra: object = {}) => new EspressoNotify({ apiKey: KEY, fetch: fetchFn as FetchFunction, maxRetries: 2, ...extra });
    const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as EspressoNotifyApiError);

    it("an answer that is not a Response is invalid_response, and is not retried", async () => {
      for (const value of [undefined, null, "ok", { status: "200" }]) {
        let n = 0;
        const error = await failure(client(async () => (n++, value as never)).notifications.transactional(send.request.body));
        expect(error, String(value)).toMatchObject({ code: "invalid_response", status: 0 });
        expect(n).toBe(1);
      }
    });

    it("a connection error is retried like the global fetch's", async () => {
      let n = 0;
      const cause = Object.assign(new Error("reset"), { code: "ECONNRESET" });
      const error = await failure(client(async () => (n++, Promise.reject(Object.assign(new TypeError("fetch failed"), { cause })))).notifications.transactional(send.request.body));
      expect(error).toMatchObject({ code: "network_error", status: 0 });
      expect(n).toBe(3);
    });

    it("an error that is not a TypeError is a connection failure too", async () => {
      let n = 0;
      const error = await failure(client(async () => (n++, Promise.reject(new Error("proxy refused")))).notifications.transactional(send.request.body));
      expect(error).toMatchObject({ code: "network_error" });
      expect(n).toBe(3);
    });

    it("a TypeError about the request itself is request_not_sent, and its text is not kept", async () => {
      let n = 0;
      const error = await failure(client(async () => (n++, Promise.reject(new TypeError(`Invalid value "Bearer ${KEY}" for header`)))).notifications.transactional(send.request.body));
      expect(error).toMatchObject({ code: "request_not_sent", status: 0 });
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(KEY);
      expect(n).toBe(1);
    });

    it("gets the signal of the attempt: the timeout stops a function that waits for it", async () => {
      const hangs: FetchFunction = (_url, init) =>
        new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      const error = await failure(client(hangs, { timeoutMs: 100, maxRetries: 0 }).notifications.transactional(send.request.body));
      expect(error).toMatchObject({ code: "network_error" });
    });

    it("gets the abort of the caller", async () => {
      const hangs: FetchFunction = (_url, init) =>
        new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const error = await failure(client(hangs).notifications.transactional(send.request.body, { signal: controller.signal }));
      expect(error).toBeInstanceOf(EspressoNotifyAbortError);
    });
  });
});
