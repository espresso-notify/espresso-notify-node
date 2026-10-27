import { afterEach, describe, expect, it } from "vitest";
import { EspressoNotify, EspressoNotifyApiError, EspressoNotifyConfigError } from "../src";
import { DEFAULT_DEADLINE_MS } from "../src/client";
import { createFetchApi, retryAfterWaitMs, type TransportConfig } from "../src/http";
import { fixture } from "./support/fixtures";
import { startServer, type Answer, type Recorded, type TestServer } from "./support/server";

// SRVL-05 (T24, assessment.md L6): a Retry-After wait is spread so callers that were refused together do not return together,
// and a whole call, retries and waits included, ends at deadlineMs.

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
const call = (client: EspressoNotify, opts?: Parameters<EspressoNotify["notifications"]["transactional"]>[1]) => client.notifications.transactional(send.request.body, opts);
const failureOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as EspressoNotifyApiError);

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the Retry-After wait is spread", () => {
  it("is the value plus 0 to 25%, and never more than 60 s", () => {
    expect(retryAfterWaitMs(10, () => 0)).toBe(10_000);
    expect(retryAfterWaitMs(10, () => 0.5)).toBe(11_250);
    expect(retryAfterWaitMs(10, () => 0.999999)).toBe(12_499);
    expect(retryAfterWaitMs(0, () => 0.9)).toBe(0);
    expect(retryAfterWaitMs(3600, () => 0.99)).toBe(60_000);
    expect(retryAfterWaitMs(59, () => 0.99)).toBe(60_000);
    expect(retryAfterWaitMs(48, () => 0.99)).toBe(59_880);
    expect(retryAfterWaitMs(48, () => 1)).toBe(60_000);
  });

  it("100 concurrent 429s resume over the window, not at one instant", async () => {
    const seen = new Set<string>();
    const server = await serve((r) => {
      const id = String(r.headers["x-call"]);
      if (seen.has(id)) return { status: 200, body: {} };
      seen.add(id);
      return { status: 429, headers: { "Retry-After": "10" } };
    });
    const random = rng(99);
    const slept: number[] = [];
    const config: TransportConfig = { maxRetries: 2, timeoutMs: 5000 };
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        createFetchApi(config, { random, sleep: async (ms) => void slept.push(ms) })(`${server.baseUrl}/v1/x`, { method: "POST", body: "{}", headers: { "x-call": String(i) } }),
      ),
    );
    expect(slept).toHaveLength(100);
    expect(Math.min(...slept)).toBeGreaterThanOrEqual(10_000);
    expect(Math.max(...slept)).toBeLessThanOrEqual(12_500);
    expect(new Set(slept).size).toBeGreaterThan(80); // not one instant, not a few waves
    expect(Math.max(...slept) - Math.min(...slept)).toBeGreaterThan(2000);
    // spread, not bunched: every quarter of the window holds some
    for (let q = 0; q < 4; q++) expect(slept.filter((ms) => ms >= 10_000 + q * 625 && ms < 10_000 + (q + 1) * 625).length, `quarter ${q}`).toBeGreaterThan(10);
  });
});

describe("deadlineMs", () => {
  it("defaults to 60000", () => {
    expect(DEFAULT_DEADLINE_MS).toBe(60_000);
  });

  it("ends a sustained 503 with deadline_exceeded, from the arithmetic of the loop (fake clock)", async () => {
    const server = await serve(() => ({ status: 503 }));
    let clock = 0;
    const slept: number[] = [];
    const fetchApi = createFetchApi(
      { maxRetries: 10, timeoutMs: 5000, deadlineMs: 5000 },
      { random: () => 1 - Number.EPSILON, tick: () => clock, sleep: async (ms) => void ((clock += ms), slept.push(ms)) },
    );
    const error = (await failureOf(fetchApi(`${server.baseUrl}/v1/x`, { method: "POST", body: "{}" }))) as EspressoNotifyApiError;
    expect(error).toBeInstanceOf(EspressoNotifyApiError);
    expect(error.code).toBe("deadline_exceeded");
    expect(error.status).toBe(0);
    expect(error.cause).toBeInstanceOf(EspressoNotifyApiError);
    expect((error.cause as EspressoNotifyApiError).status).toBe(503);
    expect(slept).toEqual([499, 999, 1999]); // the next wait, 3999 ms, does not fit in the 1503 ms left: the call ends then, not after it
    expect(server.requests).toHaveLength(4);
    expect(error.message).toContain("5000 ms");
  });

  it("a sustained 503 with a long Retry-After ends at once, not after waiting it", async () => {
    const server = await serve(() => ({ status: 503, headers: { "Retry-After": "30" } }));
    const started = Date.now();
    const error = await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, deadlineMs: 5000 })));
    expect(error).toMatchObject({ code: "deadline_exceeded", status: 0 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(server.requests).toHaveLength(1);
    expect(((error as EspressoNotifyApiError).cause as EspressoNotifyApiError).retryAfterSeconds).toBe(30);
  });

  it("a sustained 503 ends at the deadline, in real time, whatever maxRetries says", async () => {
    const server = await serve(() => ({ status: 503 }));
    const started = Date.now();
    const error = await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, deadlineMs: 800, maxRetries: 10 })));
    const took = Date.now() - started;
    expect(error).toMatchObject({ code: "deadline_exceeded", status: 0 });
    expect(took).toBeLessThan(1300);
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
  });

  it("stops an attempt that is still in flight when the deadline comes, as deadline_exceeded and not as a timeout", async () => {
    const server = await serve(() => ({ status: 200, body: {}, delayMs: 3000 }));
    const started = Date.now();
    const error = await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, timeoutMs: 20_000, deadlineMs: 300 })));
    expect(error).toMatchObject({ code: "deadline_exceeded", status: 0 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(((error as EspressoNotifyApiError).cause as EspressoNotifyApiError).code).toBe("network_error");
    expect(server.requests).toHaveLength(1);
  });

  it("with no retry left, an attempt cut by the deadline is still deadline_exceeded", async () => {
    const server = await serve(() => ({ status: 200, body: {}, delayMs: 3000 }));
    const error = await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, timeoutMs: 20_000, deadlineMs: 250, maxRetries: 0 })));
    expect(error).toMatchObject({ code: "deadline_exceeded", status: 0 });
  });

  it("a connection that keeps failing ends at the deadline too, with the connection failure as the cause", async () => {
    const server = await serve(() => ({ status: 200, drop: true }));
    const started = Date.now();
    const error = await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, deadlineMs: 700, maxRetries: 10 })));
    expect(error).toMatchObject({ code: "deadline_exceeded", status: 0 });
    expect(((error as EspressoNotifyApiError).cause as EspressoNotifyApiError).code).toBe("network_error");
    expect(Date.now() - started).toBeLessThan(1300);
    expect(server.requests.length).toBeGreaterThanOrEqual(1);
  });

  it("a wait that would use exactly what is left ends the call without sleeping", async () => {
    const server = await serve(() => ({ status: 200, drop: true }));
    let clock = 0;
    const slept: number[] = [];
    const fetchApi = createFetchApi(
      { maxRetries: 5, timeoutMs: 5000, deadlineMs: 499 },
      { random: () => 1 - Number.EPSILON, tick: () => clock, sleep: async (ms) => void ((clock += ms), slept.push(ms)) },
    );
    const error = await failureOf(fetchApi(`${server.baseUrl}/v1/x`, { method: "POST", body: "{}" }));
    expect(error).toMatchObject({ code: "deadline_exceeded" });
    expect(slept).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it("the same for a retryable status: a wait that uses exactly what is left is not slept", async () => {
    const server = await serve(() => ({ status: 503 }));
    let clock = 0;
    const slept: number[] = [];
    const fetchApi = createFetchApi(
      { maxRetries: 5, timeoutMs: 5000, deadlineMs: 499 },
      { random: () => 1 - Number.EPSILON, tick: () => clock, sleep: async (ms) => void ((clock += ms), slept.push(ms)) },
    );
    const error = await failureOf(fetchApi(`${server.baseUrl}/v1/x`, { method: "POST", body: "{}" }));
    expect(error).toMatchObject({ code: "deadline_exceeded" });
    expect(slept).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it("leaves a timeout that comes before the deadline as network_error", async () => {
    const server = await serve(() => ({ status: 200, body: {}, delayMs: 3000 }));
    const error = await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, timeoutMs: 150, maxRetries: 0 })));
    expect(error).toMatchObject({ code: "network_error", status: 0 });
  });

  it("does not touch a call that finishes in time, retries included", async () => {
    const server = await serve((_r, n) => (n < 3 ? { status: 503, headers: { "Retry-After": "0" } } : { status: send.response.status, body: send.response.body }));
    await expect(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, deadlineMs: 5000 }))).resolves.toBeDefined();
    expect(server.requests).toHaveLength(3);
  });

  it("can be set for one call, which wins over the client", async () => {
    const server = await serve(() => ({ status: 503, headers: { "Retry-After": "30" } }));
    const client = new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, deadlineMs: 600_000 });
    const error = await failureOf(call(client, { deadlineMs: 2000 }));
    expect(error).toMatchObject({ code: "deadline_exceeded" });
  });

  it("is checked like the other numeric options", async () => {
    for (const value of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, "60000", 2 ** 31]) {
      expect(() => new EspressoNotify({ apiKey: KEY, deadlineMs: value as number })).toThrow(EspressoNotifyConfigError);
      try {
        new EspressoNotify({ apiKey: KEY, deadlineMs: value as number });
      } catch (e) {
        expect((e as EspressoNotifyConfigError).code).toBe("invalid_option");
        expect((e as Error).message).toContain("deadlineMs");
      }
      const client = new EspressoNotify({ apiKey: KEY });
      await expect(call(client, { deadlineMs: value as number })).rejects.toMatchObject({ code: "invalid_option" });
    }
  });

  it("an abort still wins and is an abort", async () => {
    const server = await serve(() => ({ status: 200, body: {}, delayMs: 3000 }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await failureOf(call(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, deadlineMs: 5000 }), { signal: controller.signal }));
    expect(error).toMatchObject({ code: "aborted" });
  });
});
