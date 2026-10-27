import { afterEach, describe, expect, it } from "vitest";
import { EspressoNotify, EspressoNotifyConfigError, EspressoNotifySignatureError, verifySignature } from "../src";
import { calls } from "./support/calls";
import { allFixtures, fixture, signatureCases } from "./support/fixtures";
import { startServer, type TestServer } from "./support/server";

// SRVL-05 and SRVL-07 (T22, validation.md security M2 and L4): a numeric option that is not a usable number is refused with
// invalid_option naming it, instead of turning a limit off (a NaN tolerance accepts a replay, an infinite retry count never stops).

const KEY = "sk_live_" + "ExampleSecretKeyForTests0123456789";
const send = fixture("sendTransactional");
const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function configError(run: () => unknown): EspressoNotifyConfigError {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(EspressoNotifyConfigError);
    return e as EspressoNotifyConfigError;
  }
  throw new Error("nothing was thrown");
}

describe("the options of the client", () => {
  const notNumbers: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "2", null, true, {}, []];

  for (const value of [...notNumbers, -1, 1.5, 11, 1000]) {
    it(`refuses maxRetries ${String(value)} (${typeof value})`, () => {
      const error = configError(() => new EspressoNotify({ apiKey: KEY, maxRetries: value as number }));
      expect(error.code).toBe("invalid_option");
      expect(error.message).toContain("maxRetries");
    });
  }
  for (const value of [...notNumbers, 0, -5, 2 ** 31, 3e9]) {
    it(`refuses timeoutMs ${String(value)} (${typeof value})`, () => {
      const error = configError(() => new EspressoNotify({ apiKey: KEY, timeoutMs: value as number }));
      expect(error.code).toBe("invalid_option");
      expect(error.message).toContain("timeoutMs");
    });
  }
  it("accepts the ends of the ranges and leaves the defaults when nothing is given", () => {
    for (const maxRetries of [0, 1, 10]) expect(() => new EspressoNotify({ apiKey: KEY, maxRetries })).not.toThrow();
    for (const timeoutMs of [1, 0.5, 30000, 2 ** 31 - 1]) expect(() => new EspressoNotify({ apiKey: KEY, timeoutMs })).not.toThrow();
    expect(() => new EspressoNotify({ apiKey: KEY })).not.toThrow();
  });
});

describe("the options of one call", () => {
  it("rejects (it does not throw) with invalid_option naming the option, and sends nothing", async () => {
    const api = await startServer(() => ({ status: send.response.status, body: send.response.body }));
    servers.push(api);
    const client = new EspressoNotify({ apiKey: KEY, baseUrl: api.baseUrl });
    for (const [options, name] of [
      [{ maxRetries: Number.POSITIVE_INFINITY }, "maxRetries"],
      [{ maxRetries: Number.NaN }, "maxRetries"],
      [{ maxRetries: 2.5 }, "maxRetries"],
      [{ timeoutMs: Number.NaN }, "timeoutMs"],
      [{ timeoutMs: -1 }, "timeoutMs"],
    ] as const) {
      const pending = calls.sendTransactional!(client, send, options as never);
      await expect(pending, name).rejects.toBeInstanceOf(EspressoNotifyConfigError);
      await expect(pending).rejects.toMatchObject({ code: "invalid_option", message: expect.stringContaining(name) });
    }
    expect(api.requests).toHaveLength(0);
  });

  it("is checked for every operation", async () => {
    const client = new EspressoNotify({ apiKey: KEY });
    for (const f of allFixtures()) {
      await expect(calls[f.operationId]!(client, f, { maxRetries: -1 }), f.operationId).rejects.toMatchObject({ code: "invalid_option" });
    }
  });
});

describe("verifySignature: the tolerance and the clock", () => {
  const c = signatureCases().find((x) => x.name === "hmac_single")!;
  const at = c.input.now * 1000;
  const verify = (extra: Record<string, unknown>) =>
    verifySignature({ body: c.input.body, headers: c.input.headers, secret: c.input.secrets, now: () => at, ...extra } as never);

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, "300", null, true]) {
    it(`refuses toleranceSeconds ${String(value)} (${typeof value})`, () => {
      const error = configError(() => verify({ toleranceSeconds: value }));
      expect(error.code).toBe("invalid_option");
      expect(error.message).toContain("toleranceSeconds");
    });
  }
  it("accepts 0 and a large finite tolerance", () => {
    expect(verify({ toleranceSeconds: 0 })).toEqual(c.expected.payload);
    expect(verify({ toleranceSeconds: 1e6 })).toEqual(c.expected.payload);
  });

  for (const reading of [Number.NaN, Number.POSITIVE_INFINITY, "1700000000000", undefined, null]) {
    it(`refuses a clock that returns ${String(reading)}`, () => {
      const error = configError(() => verify({ now: () => reading }));
      expect(error.code).toBe("invalid_option");
      expect(error.message).toContain("now");
    });
  }
  it("refuses a clock that is not a function", () => {
    expect(configError(() => verify({ now: 1700000000000 })).code).toBe("invalid_option");
  });

  it("never accepts a request signed 10^7 seconds ago, whatever the option: the usable values refuse it, the unusable ones throw", () => {
    const old = { now: () => at + 1e7 * 1000 };
    for (const toleranceSeconds of [undefined, 0, 1, 300, 3600]) {
      expect(() => verify({ ...old, toleranceSeconds })).toThrow(EspressoNotifySignatureError);
      try {
        verify({ ...old, toleranceSeconds });
      } catch (e) {
        expect((e as EspressoNotifySignatureError).code).toBe("timestamp_out_of_tolerance");
      }
    }
    for (const toleranceSeconds of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => verify({ ...old, toleranceSeconds })).toThrow(EspressoNotifyConfigError);
    }
    expect(() => verify({ now: () => Number.NaN })).toThrow(EspressoNotifyConfigError);
  });
});
