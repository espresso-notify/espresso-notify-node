import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { EspressoNotify, EspressoNotifyApiError, EspressoNotifyConfigError } from "../src";
import { createFetchApi } from "../src/http";
import { allFixtures } from "./support/fixtures";
import { calls } from "./support/calls";
import { startServer, type TestServer } from "./support/server";

// SRVL-03 AC5 and AC7 (T20, validation.md Gap 1): the whole key is checked at construction, and a key never reaches an error,
// not even the one `fetch` throws when it refuses a header.

const REAL_SHAPE = `sk_live_${"0123456789abcdef".repeat(4)}`; // what the API issues: sk_live_ and 64 hex characters
const SECRET = "TopSecretPartOfTheKey42";

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function everywhere(value: unknown): string {
  const seen = new Set<unknown>();
  const walk = (v: unknown): unknown => {
    if (typeof v !== "object" || v === null || seen.has(v)) return v;
    seen.add(v);
    return Object.fromEntries(Object.getOwnPropertyNames(v).map((k) => [k, walk((v as Record<string, unknown>)[k])]));
  };
  return [JSON.stringify(walk(value)), inspect(value, { depth: 10, showHidden: true }), String((value as Error)?.stack), String(value)].join("\n");
}

describe("the whole key is checked at construction", () => {
  const bad: Array<[string, string]> = [
    ["an inner line break", `sk_live_${SECRET}\nX-Evil: 1`],
    ["an inner carriage return", `sk_live_${SECRET}\rX`],
    ["a trailing line break", `sk_live_${SECRET}\n`],
    ["an inner tab", `sk_live_${SECRET}\tX`],
    ["an inner space", `sk_live_${SECRET} X`],
    ["a leading space", ` sk_live_${SECRET}`],
    ["a non-ASCII character", `sk_live_${SECRET}ç`],
    ["a NUL", `sk_live_${SECRET}\u0000`],
    ["a quote", `sk_live_${SECRET}"`],
    ["nothing after the prefix", "sk_live_"],
  ];

  for (const [label, apiKey] of bad) {
    it(`refuses ${label} with invalid_api_key, sends nothing and quotes nothing`, async () => {
      const server = await startServer(() => ({ status: 200, body: {} }));
      servers.push(server);
      let thrown: unknown;
      try {
        new EspressoNotify({ apiKey, baseUrl: server.baseUrl });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(EspressoNotifyConfigError);
      expect((thrown as EspressoNotifyConfigError).code).toBe("invalid_api_key");
      expect(everywhere(thrown)).not.toContain(SECRET);
      expect(server.requests).toHaveLength(0);
    });
  }

  it("accepts the shape the API issues and the characters of the examples", () => {
    expect(() => new EspressoNotify({ apiKey: REAL_SHAPE })).not.toThrow();
    expect(() => new EspressoNotify({ apiKey: "sk_live_Example_Key-0123" })).not.toThrow();
  });
});

describe("a refusal of fetch never keeps the key", () => {
  const Authorization = `Bearer sk_live_${SECRET}\nX-Evil: 1`;

  it("is not retried, is not a network error and carries no cause or text of the original", async () => {
    const server = await startServer(() => ({ status: 200, body: {} }));
    servers.push(server);
    const slept: number[] = [];
    const fetchApi = createFetchApi({ maxRetries: 3, timeoutMs: 5000 }, { sleep: async (ms) => void slept.push(ms) });

    const error = await fetchApi(`${server.baseUrl}/v1/users`, { method: "POST", headers: { Authorization } }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(EspressoNotifyApiError);
    expect((error as EspressoNotifyApiError).status).toBe(0);
    expect((error as EspressoNotifyApiError).code).toBe("request_not_sent");
    expect((error as Error).cause).toBeUndefined();
    expect(everywhere(error)).not.toContain(SECRET);
    expect(slept, "no retry was waited for").toEqual([]);
    expect(server.requests, "nothing reached the server").toHaveLength(0);
  });

  it("still treats a real connection failure as a retried network_error with its cause", async () => {
    const dead = await startServer(() => ({ status: 200 }));
    await dead.close();
    const slept: number[] = [];
    const fetchApi = createFetchApi({ maxRetries: 2, timeoutMs: 5000 }, { sleep: async (ms) => void slept.push(ms) });
    const error = (await fetchApi(`${dead.baseUrl}/v1/users`, { method: "POST" }).catch((e: unknown) => e)) as EspressoNotifyApiError;
    expect(error.code).toBe("network_error");
    expect(error.cause).toBeDefined();
    expect(slept).toHaveLength(2);
  });

  it("holds for every operation: no call with a well-formed key ever produces an error that contains it", async () => {
    const dead = await startServer(() => ({ status: 200 }));
    await dead.close();
    const client = new EspressoNotify({ apiKey: `sk_live_${SECRET}`, baseUrl: dead.baseUrl, maxRetries: 0 });
    for (const f of allFixtures()) {
      const error = await calls[f.operationId]!(client, f).catch((e: unknown) => e);
      expect(everywhere(error), f.operationId).not.toContain(SECRET);
    }
  });
});
