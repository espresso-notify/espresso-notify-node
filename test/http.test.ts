import { afterEach, describe, expect, it } from "vitest";
import { EspressoNotify, EspressoNotifyAbortError, EspressoNotifyApiError } from "../src";
import { backoffMs, createFetchApi, parseRetryAfterSeconds, type TransportConfig } from "../src/http";
import { allErrorFixtures, errorFixture, fixture, type Fixture } from "./support/fixtures";
import { startServer, type Answer, type Recorded, type TestServer } from "./support/server";

const KEY = "sk_live_" + "ExampleSecretKeyForTests0123456789";
const send = fixture("sendTransactional");

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(answer: (r: Recorded, attempt: number) => Answer): Promise<TestServer> {
  const s = await startServer(answer);
  servers.push(s);
  return s;
}

const accepted = (): Answer => ({ status: send.response.status, headers: send.response.headers, body: send.response.body });
const refused = (f: Fixture, headers?: Record<string, string>): Answer => ({ status: f.response.status, headers: { ...f.response.headers, ...headers }, body: f.response.body });
const call = (client: EspressoNotify, opts?: Parameters<EspressoNotify["notifications"]["transactional"]>[1]) => client.notifications.transactional(send.request.body, opts);
const failureOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

// A retry waits Retry-After seconds when the answer carries one; 0 keeps these tests quick without changing the logic.
const NOW = { "Retry-After": "0" };

describe("an error status becomes EspressoNotifyApiError (SRVL-04 AC1)", () => {
  it("carries status, code, error, request id and Retry-After", async () => {
    const f = errorFixture("error_422_idempotency_key_reused");
    const server = await serve(() => refused(f, { "X-Request-Id": "req_8f2c1", "Retry-After": "5" }));
    const error = (await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl })))) as EspressoNotifyApiError;
    expect(error).toBeInstanceOf(EspressoNotifyApiError);
    expect(error.status).toBe(422);
    expect(error.code).toBe(f.response.body.code);
    expect(error.error).toBe(f.response.body.error);
    expect(error.requestId).toBe("req_8f2c1");
    expect(error.retryAfterSeconds).toBe(5);
  });

  it("answers every 4xx and 5xx fixture with its own status and code", async () => {
    for (const f of allErrorFixtures().filter((x) => x.response.status !== 429 && x.response.status !== 503)) {
      const server = await serve(() => refused(f));
      const error = (await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl })))) as EspressoNotifyApiError;
      expect(error, f.response.status.toString()).toBeInstanceOf(EspressoNotifyApiError);
      expect(error.status).toBe(f.response.status);
      expect(error.code).toBe(f.response.body.code ?? "unknown");
      expect(error.error).toBe(f.response.body.error);
    }
  });

  it("gives code unknown to a body that is not JSON, with the status", async () => {
    const server = await serve(() => ({ status: 502, body: "<html><body>Bad gateway</body></html>", headers: { "Content-Type": "text/html", ...NOW } }));
    const error = (await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, maxRetries: 0 })))) as EspressoNotifyApiError;
    expect(error).toBeInstanceOf(EspressoNotifyApiError);
    expect(error.status).toBe(502);
    expect(error.code).toBe("unknown");
    expect(error.error).toBeUndefined();
  });

  it("gives code unknown to a JSON body that names none, and keeps its error text", async () => {
    const f = errorFixture("error_401_invalid_key");
    const server = await serve(() => refused(f));
    const error = (await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl })))) as EspressoNotifyApiError;
    expect(error.code).toBe("unknown");
    expect(error.error).toBe(f.response.body.error);
  });

  it("puts no key and no request body in the error", async () => {
    const server = await serve(() => refused(errorFixture("error_400_title_required")));
    const error = await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl })));
    const text = JSON.stringify(error, Object.getOwnPropertyNames(error)) + String((error as Error).stack);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("Order 8123");
  });
});

describe("which statuses are retried (SRVL-05 AC2, AC4)", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    it(`${status} is retried and the call resolves with the answer of the next attempt`, async () => {
      const server = await serve((_r, n) => (n === 1 ? { status, headers: NOW } : accepted()));
      const result = await call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }));
      expect(server.requests).toHaveLength(2);
      expect(result).toEqual(send.response.body);
    });
  }

  for (const f of [400, 401, 402, 403, 404, 409, 422].map((status) => allErrorFixtures().find((x) => x.response.status === status)!)) {
    it(`${f.response.status} is not retried`, async () => {
      const server = await serve(() => refused(f, NOW));
      const error = (await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl })))) as EspressoNotifyApiError;
      expect(server.requests).toHaveLength(1);
      expect(error.status).toBe(f.response.status);
    });
  }
});

describe("how many attempts (SRVL-05 AC2, AC7)", () => {
  it("makes 3 attempts by default and rejects with the last answer", async () => {
    const f = errorFixture("error_503_billing_check_unavailable");
    const server = await serve(() => refused(f, NOW));
    const error = (await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl })))) as EspressoNotifyApiError;
    expect(server.requests).toHaveLength(3);
    expect(error.status).toBe(503);
    expect(error.code).toBe("billing_check_unavailable");
  });

  it("makes exactly one attempt when maxRetries is 0", async () => {
    const server = await serve(() => ({ status: 503, headers: NOW }));
    const error = (await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, maxRetries: 0 })))) as EspressoNotifyApiError;
    expect(server.requests).toHaveLength(1);
    expect(error.status).toBe(503);
  });

  it("takes maxRetries of one call over the client's", async () => {
    const server = await serve(() => ({ status: 503, headers: NOW }));
    await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }), { maxRetries: 0 }));
    expect(server.requests).toHaveLength(1);
    await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, maxRetries: 0 }), { maxRetries: 3 }));
    expect(server.requests).toHaveLength(5);
  });
});

describe("connection failures and timeouts (SRVL-05 AC2, AC8)", () => {
  it("retries a dropped connection", async () => {
    const server = await serve((_r, n) => (n === 1 ? { status: 200, drop: true } : accepted()));
    const result = await call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }));
    expect(server.requests).toHaveLength(2);
    expect(result).toEqual(send.response.body);
  });

  it("rejects with status 0 and code network_error when every attempt fails to connect", async () => {
    const dead = await startServer(() => ({ status: 200 }));
    await dead.close();
    const error = (await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: dead.baseUrl, maxRetries: 1 })))) as EspressoNotifyApiError;
    expect(error).toBeInstanceOf(EspressoNotifyApiError);
    expect(error.status).toBe(0);
    expect(error.code).toBe("network_error");
  });

  it("aborts an attempt that exceeds timeoutMs and retries it", async () => {
    const server = await serve((_r, n) => (n === 1 ? { ...accepted(), delayMs: 2000 } : accepted()));
    const started = Date.now();
    const result = await call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, timeoutMs: 100 }));
    expect(server.requests).toHaveLength(2);
    expect(result).toEqual(send.response.body);
    expect(Date.now() - started).toBeLessThan(1500); // the 2 s answer was not waited for (100 ms + a back-off of at most 500 ms)
  });

  it("rejects with network_error when every attempt times out", async () => {
    const server = await serve(() => ({ ...accepted(), delayMs: 600 }));
    const error = (await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, timeoutMs: 80, maxRetries: 1 })))) as EspressoNotifyApiError;
    expect(server.requests).toHaveLength(2);
    expect(error.status).toBe(0);
    expect(error.code).toBe("network_error");
  });

  it("takes timeoutMs of one call over the client's", async () => {
    const server = await serve(() => ({ ...accepted(), delayMs: 400 }));
    const error = (await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, timeoutMs: 30_000, maxRetries: 0 }), { timeoutMs: 60 }))) as EspressoNotifyApiError;
    expect(error.code).toBe("network_error");
  });
});

describe("abort (SRVL-05 AC9)", () => {
  it("stops the attempt in flight at once, makes no other, and rejects with EspressoNotifyAbortError", async () => {
    const server = await serve(() => ({ ...accepted(), delayMs: 3000 }));
    const controller = new AbortController();
    const started = Date.now();
    const pending = failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }), { signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    const error = await pending;
    expect(error).toBeInstanceOf(EspressoNotifyAbortError);
    expect((error as EspressoNotifyAbortError).code).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1500);
    await new Promise((resolve) => setTimeout(resolve, 700)); // longer than any back-off before a second attempt
    expect(server.requests).toHaveLength(1);
  });

  it("stops while it waits to retry", async () => {
    const server = await serve(() => ({ status: 503, headers: { "Retry-After": "30" } }));
    const controller = new AbortController();
    const started = Date.now();
    const pending = failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }), { signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    const error = await pending;
    expect(error).toBeInstanceOf(EspressoNotifyAbortError);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(server.requests).toHaveLength(1);
  });

  it("sends nothing when the signal has already fired", async () => {
    const server = await serve(() => accepted());
    const error = await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }), { signal: AbortSignal.abort() }));
    expect(error).toBeInstanceOf(EspressoNotifyAbortError);
    expect(server.requests).toHaveLength(0);
  });
});

// The waits, from the arithmetic of the loop with the sleep and the dice replaced (SRVL-05 AC2, AC3).
describe("back-off and Retry-After", () => {
  const config: TransportConfig = { maxRetries: 7, timeoutMs: 5000 };

  async function waits(answers: (n: number) => Answer, hooks: { random?: () => number; now?: () => number }, retries = 7): Promise<number[]> {
    const server = await serve((_r, n) => answers(n));
    const slept: number[] = [];
    const fetchApi = createFetchApi({ ...config, maxRetries: retries }, { ...hooks, sleep: async (ms) => void slept.push(ms) });
    await fetchApi(`${server.baseUrl}/v1/notifications/transactional`, { method: "POST", body: "{}" });
    return slept;
  }

  it("doubles from 500 ms and stops at 8 s (the longest wait of the full jitter)", async () => {
    expect(await waits(() => ({ status: 503 }), { random: () => 0.999999 })).toEqual([499, 999, 1999, 3999, 7999, 7999, 7999]);
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, () => 1 - Number.EPSILON))).toEqual([499, 999, 1999, 3999, 7999, 7999, 7999]);
  });

  it("waits anywhere from 0 up to that bound (full jitter)", async () => {
    expect(await waits(() => ({ status: 503 }), { random: () => 0 }, 3)).toEqual([0, 0, 0]);
    expect(await waits(() => ({ status: 503 }), { random: () => 0.5 }, 3)).toEqual([250, 500, 1000]);
  });

  it("waits Retry-After seconds instead of the back-off", async () => {
    expect(await waits((n) => (n === 1 ? { status: 429, headers: { "Retry-After": "7" } } : { status: 200 }), { random: () => 0 })).toEqual([7000]); // random 0: no jitter on the Retry-After, see test/deadline.test.ts
  });

  it("waits at most 60 s whatever Retry-After says", async () => {
    expect(await waits((n) => (n === 1 ? { status: 503, headers: { "Retry-After": "3600" } } : { status: 200 }), {})).toEqual([60_000]);
  });

  it("turns an HTTP date in Retry-After into seconds from now", async () => {
    const now = Date.UTC(2026, 9, 26, 12, 0, 0);
    const date = new Date(now + 10_500).toUTCString(); // an HTTP date has whole seconds: 10 s after now, rounded by the clock
    const slept = await waits((n) => (n === 1 ? { status: 503, headers: { "Retry-After": date } } : { status: 200 }), { now: () => now, random: () => 0 });
    expect(slept).toEqual([10_000]);
  });

  it("reads Retry-After as seconds or as a date, and nothing else", () => {
    const now = Date.UTC(2026, 9, 26, 12, 0, 0);
    expect(parseRetryAfterSeconds("30", now)).toBe(30);
    expect(parseRetryAfterSeconds("0", now)).toBe(0);
    expect(parseRetryAfterSeconds(new Date(now + 90_000).toUTCString(), now)).toBe(90);
    expect(parseRetryAfterSeconds(new Date(now - 90_000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfterSeconds("soon", now)).toBeUndefined();
    expect(parseRetryAfterSeconds(null, now)).toBeUndefined();
  });
});
