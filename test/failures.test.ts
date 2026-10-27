import { createPrivateKey, createPublicKey, generateKeyPairSync, createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { EspressoNotify, EspressoNotifyApiError, EspressoNotifyConfigError, EspressoNotifyError, EspressoNotifySignatureError, verifySignature } from "../src";
import { calls } from "./support/calls";
import { allFixtures, fixture, signatureCases } from "./support/fixtures";
import { startServer, type TestServer } from "./support/server";

// SRVL-02, SRVL-04 and SRVL-07 (T23, validation.md security L2 and L3): whatever the network or the caller hands the library,
// what comes out is a value or an error of the library, never a SyntaxError or a TypeError, and a path id never changes the route.

const KEY = "sk_live_" + "ExampleSecretKeyForTests0123456789";
const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A small deterministic generator (mulberry32), so a failure of the fuzz can be replayed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("a 2xx answer that is not JSON", () => {
  const bodies = ["<html>maintenance</html>", "not json", "{", '{"a":', "undefined", "NaN", "\u0000\u0001", "ok"];
  for (const body of bodies) {
    it(`rejects with invalid_response and does not carry the text (${JSON.stringify(body).slice(0, 24)})`, async () => {
      const f = fixture("sendTransactional");
      const api = await startServer(() => ({ status: 202, headers: { "x-request-id": "req-77" }, body }));
      servers.push(api);
      const client = new EspressoNotify({ apiKey: KEY, baseUrl: api.baseUrl, maxRetries: 0 });
      const error = (await calls.sendTransactional!(client, f).catch((e) => e)) as EspressoNotifyApiError;
      expect(error).toBeInstanceOf(EspressoNotifyApiError);
      expect(error.code).toBe("invalid_response");
      expect(error.status).toBe(202);
      expect(error.requestId).toBe("req-77");
      expect(error.message).not.toContain(body.trim() || "ok-never");
      expect(error.cause).toBeUndefined();
      expect(api.requests).toHaveLength(1); // a bad answer is not retried: the send was accepted
    });
  }
  it("still resolves an empty 2xx body and a JSON null", async () => {
    const f = fixture("listCategories");
    for (const body of [undefined, "null"]) {
      const api = await startServer(() => ({ status: 200, body }));
      servers.push(api);
      const client = new EspressoNotify({ apiKey: KEY, baseUrl: api.baseUrl });
      await expect(calls.listCategories!(client, f)).resolves.toBe(body === undefined ? undefined : null);
    }
  });
});

describe("a fuzz of malformed answers", () => {
  it("only ever gives a value or an error of the library, for every operation", async () => {
    const random = rng(2026);
    const statuses = [200, 201, 202, 204, 301, 302, 307, 400, 401, 402, 403, 404, 409, 410, 413, 415, 422, 500, 502];
    const pieces = ["{", "}", "[", "]", '"', ":", ",", "null", "true", "1e999", "\\u", "<", "\u0000", "\ud800", "é", " ", '{"code":1}', '{"code":"x","error":{}}'];
    const make = () => {
      let text = "";
      for (let i = Math.floor(random() * 8); i > 0; i--) text += pieces[Math.floor(random() * pieces.length)];
      return text;
    };
    const api = await startServer((_r, n) => ({
      status: statuses[Math.floor(random() * statuses.length)]!,
      headers: random() < 0.3 ? ({ "retry-after": make().replace(/[^\x20-\x7e]/g, "") || "x", "x-request-id": make().replace(/[^\x20-\x7e]/g, "") } as Record<string, string>) : ({} as Record<string, string>),
      body: random() < 0.15 ? undefined : make(),
      ...(n % 50 === 0 ? { drop: true } : {}),
    }));
    servers.push(api);
    const client = new EspressoNotify({ apiKey: KEY, baseUrl: api.baseUrl, maxRetries: 0, timeoutMs: 2000 });
    const fixtures = allFixtures();
    let library = 0;
    let values = 0;
    for (let round = 0; round < 12; round++) {
      for (const f of fixtures) {
        try {
          await calls[f.operationId]!(client, f);
          values++;
        } catch (error) {
          expect(error, `${f.operationId} #${round}`).toBeInstanceOf(EspressoNotifyError);
          library++;
        }
      }
    }
    expect(library + values).toBe(12 * fixtures.length);
    expect(library).toBeGreaterThan(50);
  });
});

describe("a path id", () => {
  const bad: unknown[] = ["", " ", "\t\n", ".", "..", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, null, undefined, {}, []];
  const outcomes = async (run: (client: EspressoNotify, id: never) => Promise<unknown>) => {
    const api = await startServer(() => ({ status: 200, body: {} }));
    servers.push(api);
    const client = new EspressoNotify({ apiKey: KEY, baseUrl: api.baseUrl });
    for (const id of bad) {
      const error = (await run(client, id as never).catch((e) => e)) as EspressoNotifyConfigError;
      expect(error, String(id)).toBeInstanceOf(EspressoNotifyConfigError);
      expect(error.code).toBe("invalid_argument");
    }
    expect(api.requests).toHaveLength(0);
  };
  it("is refused by notifications.get, sending nothing", () => outcomes((c, id) => c.notifications.get(id)));
  it("is refused by notifications.cancel, sending nothing", () => outcomes((c, id) => c.notifications.cancel(id)));
  it("is refused by journeys.enter, sending nothing", () => outcomes((c, id) => c.journeys.enter(id, fixture("enterJourney").request.body)));

  it("still lets a numeric id, a public id and an id with odd characters through, encoded", async () => {
    const api = await startServer(() => ({ status: 200, body: {} }));
    servers.push(api);
    const client = new EspressoNotify({ apiKey: KEY, baseUrl: api.baseUrl });
    await client.notifications.get(42);
    await client.notifications.get("ntf_abc");
    await client.notifications.get("a/b?c#d");
    await client.notifications.get(".a");
    await client.notifications.get("...");
    expect(api.requests.map((r) => r.url)).toEqual([
      "/v1/notifications/42",
      "/v1/notifications/ntf_abc",
      "/v1/notifications/a%2Fb%3Fc%23d",
      "/v1/notifications/.a",
      "/v1/notifications/...",
    ]);
  });
});

describe("verifySignature turns every bad input into an error of the library", () => {
  const c = signatureCases().find((x) => x.name === "hmac_single")!;
  const good = () => ({ body: c.input.body, headers: c.input.headers, secret: c.input.secrets, now: () => c.input.now * 1000 });
  const code = (input: unknown) => {
    try {
      verifySignature(input as never);
    } catch (e) {
      expect(e).toBeInstanceOf(EspressoNotifyError);
      return (e as EspressoNotifyError).code;
    }
    return "verified";
  };

  it("the good input verifies (control)", () => {
    expect(code(good())).toBe("verified");
  });

  it("a validly signed body that is not JSON is invalid_body, and the text is not in the error", () => {
    const secret = "whsec_example";
    const body = "<<not json>>";
    const t = String(c.input.now);
    const sig = createHmac("sha256", secret).update(`${t}.d1.`).update(body).digest("hex");
    const headers = { "X-Espresso-Timestamp": t, "X-Espresso-Delivery-Id": "d1", "X-Espresso-Signature": `t=${t},v1=${sig}` };
    try {
      verifySignature({ body, headers, secret, now: () => c.input.now * 1000 });
      throw new Error("verified");
    } catch (e) {
      expect(e).toBeInstanceOf(EspressoNotifySignatureError);
      expect((e as EspressoNotifySignatureError).code).toBe("invalid_body");
      expect((e as Error).message).not.toContain("not json");
    }
  });

  it("headers that are null, undefined or not an object are missing_header", () => {
    for (const headers of [null, undefined, "x", 5, true]) expect(code({ ...good(), headers })).toBe("missing_header");
  });
  it("header values that are not strings count as absent", () => {
    for (const bad of [5, null, {}, true, [1], [null]]) {
      const headers = { ...c.input.headers, "X-Espresso-Signature": bad, "x-espresso-signature": bad };
      expect(code({ ...good(), headers })).toBe("missing_header");
    }
    const headers = { ...c.input.headers, "X-Espresso-Timestamp": 1700000000 };
    expect(code({ ...good(), headers })).toBe("missing_header");
  });
  it("an input that is not an object is a config error", () => {
    for (const input of [null, undefined, "x", 5]) expect(code(input)).toBe("invalid_option");
  });
  it("a body that is not a string or bytes is raw_body_required", () => {
    for (const body of [null, 5, {}, [], undefined]) expect(code({ ...good(), body })).toBe("raw_body_required");
  });

  it("a public key of another type is refused as invalid_verification_key, not an error of OpenSSL", () => {
    const pems = [
      generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" }) as string,
      generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }) as string,
      generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }) as string,
    ];
    for (const publicKey of pems) {
      expect(code({ ...good(), secret: undefined, publicKey, headers: { ...c.input.headers, "X-Espresso-Signature-Ed25519": "ed25519_v1=AAAA", "X-Espresso-Key-Id": "fp-x" } })).toBe("invalid_verification_key");
    }
    const ed = generateKeyPairSync("ed25519").publicKey;
    expect(createPublicKey(ed.export({ type: "spki", format: "pem" }) as string).asymmetricKeyType).toBe("ed25519");
    expect(createPrivateKey).toBeDefined();
  });

  it("a fuzz of inputs only ever throws errors of the library, and no random input verifies", () => {
    const random = rng(7);
    const junk = () => {
      const pool: unknown[] = [undefined, null, 0, 1, -1, Number.NaN, "", "x", "t=1,v1=zz", "v1=" + "a".repeat(64), {}, [], ["x"], [null], true, () => 1, Symbol("s"), 1n, new Uint8Array(3), Buffer.from("{}")];
      return pool[Math.floor(random() * pool.length)];
    };
    let verified = 0;
    for (let i = 0; i < 4000; i++) {
      const names = ["X-Espresso-Signature", "X-Espresso-Signature-Ed25519", "X-Espresso-Key-Id", "X-Espresso-Timestamp", "X-Espresso-Delivery-Id", "X-Espresso-Batch-Id"];
      const headers: Record<string, unknown> = {};
      for (const n of names) if (random() < 0.7) headers[random() < 0.5 ? n : n.toLowerCase()] = junk();
      const input = { body: junk(), headers: random() < 0.9 ? headers : junk(), secret: random() < 0.8 ? junk() : "s3cret", publicKey: random() < 0.3 ? junk() : undefined, toleranceSeconds: random() < 0.8 ? undefined : junk(), now: random() < 0.9 ? undefined : junk() };
      try {
        verifySignature(input as never);
        verified++;
      } catch (e) {
        expect(e, JSON.stringify(Object.keys(headers))).toBeInstanceOf(EspressoNotifyError);
      }
    }
    expect(verified).toBe(0);
  });
});
