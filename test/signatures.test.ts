import { describe, expect, it } from "vitest";
import { EspressoNotifyConfigError, EspressoNotifySignatureError, verifySignature } from "../src";
import { signatureCases, type SignatureCase } from "./support/fixtures";

const cases = signatureCases();

function verify(c: SignatureCase, overrides: { headers?: Record<string, string> | Headers; body?: string | Buffer } = {}) {
  return verifySignature({
    body: "body" in overrides ? (overrides.body as string) : c.input.body,
    headers: overrides.headers ?? c.input.headers,
    secret: c.input.secrets,
    publicKey: c.input.publicKeys,
    toleranceSeconds: c.input.toleranceSeconds,
    now: () => c.input.now * 1000,
  });
}

function outcome(run: () => unknown): { value?: unknown; error?: EspressoNotifySignatureError } {
  try {
    return { value: run() };
  } catch (error) {
    if (error instanceof EspressoNotifySignatureError) return { error };
    throw error;
  }
}

const lowerCased = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

// Node hands over lower-case names, a Fetch Request hands over a Headers: the answer is the same for every shape and for
// a body given as a string or as the Buffer read off the socket.
const shapes: Array<[string, (c: SignatureCase) => Parameters<typeof verify>[1]]> = [
  ["headers as the platform wrote them", () => ({})],
  ["lower-case header names (Node)", (c) => ({ headers: lowerCased(c.input.headers) })],
  ["a Headers object (Fetch)", (c) => ({ headers: new Headers(c.input.headers) })],
  ["the body as a Buffer", (c) => ({ body: Buffer.from(c.input.body, "utf8") })],
];

describe("every signature fixture of the backend gives its expected result (SRVL-07 AC1 to AC4, AC6, AC7)", () => {
  it("has the fixtures", () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });

  for (const c of cases) {
    for (const [label, shape] of shapes) {
      it(`${c.name}: ${c.expected.valid ? "valid" : c.expected.error} (${label})`, () => {
        const { value, error } = outcome(() => verify(c, shape(c)));
        if (c.expected.valid) {
          expect(error).toBeUndefined();
          expect(value).toEqual(c.expected.payload);
        } else {
          expect(error).toBeInstanceOf(EspressoNotifySignatureError);
          expect(error!.code).toBe(c.expected.error);
          for (const name of c.expected.messageContains ?? []) expect(error!.message).toContain(name);
        }
      });
    }
  }
});

describe("the raw body (SRVL-07 edge cases)", () => {
  const valid = cases.find((c) => c.name === "hmac_single")!;

  it("refuses a parsed object, an array, a number and nothing at all with raw_body_required", () => {
    for (const parsed of [JSON.parse(valid.input.body), [valid.input.body], 42, undefined, null]) {
      const { error } = outcome(() => verify(valid, { body: parsed as never }));
      expect(error, String(parsed)).toBeInstanceOf(EspressoNotifySignatureError);
      expect(error!.code).toBe("raw_body_required");
    }
  });

  it("verifies the bytes it was given: the same JSON laid out differently is another body", () => {
    const reserialized = JSON.stringify(JSON.parse(valid.input.body), null, 2);
    expect(JSON.parse(reserialized)).toEqual(JSON.parse(valid.input.body));
    const { error } = outcome(() => verify(valid, { body: reserialized }));
    expect(error!.code).toBe("signature_mismatch");
  });
});

describe("the clock and the keys", () => {
  const valid = cases.find((c) => c.name === "hmac_single")!;
  const ed = cases.find((c) => c.name === "ed25519_single")!;

  it("uses the current time when no clock is given, so an old delivery is out of tolerance (SRVL-07 AC3)", () => {
    const { error } = outcome(() => verifySignature({ body: valid.input.body, headers: valid.input.headers, secret: valid.input.secrets }));
    expect(error!.code).toBe("timestamp_out_of_tolerance");
  });

  it("never accepts a request when it was given nothing to verify with", () => {
    expect(() => verifySignature({ body: valid.input.body, headers: valid.input.headers, now: () => valid.input.now * 1000 })).toThrow(EspressoNotifyConfigError);
    try {
      verifySignature({ body: valid.input.body, headers: valid.input.headers, now: () => valid.input.now * 1000 });
    } catch (e) {
      expect((e as EspressoNotifyConfigError).code).toBe("missing_verification_key");
    }
  });

  it("tells a public key it cannot read from a signature that does not match", () => {
    try {
      verifySignature({ body: ed.input.body, headers: ed.input.headers, publicKey: "not a key", now: () => ed.input.now * 1000 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EspressoNotifyConfigError);
      expect((e as EspressoNotifyConfigError).code).toBe("invalid_verification_key");
    }
  });

  it("takes the public key as the base64 of its DER as well as PEM", () => {
    const der = ed.input.publicKeys![0]!.replace(/-----[A-Z ]+-----|\s/g, "");
    const result = verifySignature({ body: ed.input.body, headers: ed.input.headers, publicKey: der, now: () => ed.input.now * 1000 });
    expect(result).toEqual(ed.expected.payload);
  });

  it("needs the key ids in the order of the signatures: the Nth id names the key of the Nth signature", () => {
    const rotation = cases.find((c) => c.name === "ed25519_rotation_current_key")!;
    const ids = rotation.input.headers["X-Espresso-Key-Id"]!.split(" ");
    expect(ids).toHaveLength(2);
    const swapped = { ...rotation.input.headers, "X-Espresso-Key-Id": [ids[1], ids[0]].join(" ") };
    const { error } = outcome(() => verify(rotation, { headers: swapped }));
    expect(error!.code).toBe("signature_mismatch");
  });

  it("accepts a request that either the secret or the public key verifies when both are given", () => {
    const hmacOnly = cases.find((c) => c.name === "hmac_single")!;
    const withKey = verifySignature({
      body: hmacOnly.input.body,
      headers: hmacOnly.input.headers,
      secret: hmacOnly.input.secrets,
      publicKey: ed.input.publicKeys,
      now: () => hmacOnly.input.now * 1000,
    });
    expect(withKey).toEqual(hmacOnly.expected.payload);
  });
});

// An unset environment variable becomes "" or undefined; the HMAC of any body under the empty key is computable by anyone, so
// an empty key must be refused before anything is computed (security review of T9).
describe("empty verification keys are refused", () => {
  const valid = cases.find((c) => c.name === "hmac_single")!;
  const ed = cases.find((c) => c.name === "ed25519_single")!;
  const run = (extra: { secret?: unknown; publicKey?: unknown }, c: SignatureCase = valid) =>
    verifySignature({ body: c.input.body, headers: c.input.headers, now: () => c.input.now * 1000, ...extra } as never);
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(EspressoNotifyConfigError);
      return (e as EspressoNotifyConfigError).code;
    }
    return "accepted";
  };

  it.each([
    ["an empty secret", ""],
    ["a blank secret", "   "],
    ["a valid secret and an empty one", [valid.input.secrets![0], ""]],
    ["an empty one and a valid secret", ["", valid.input.secrets![0]]],
    ["undefined inside a list", [valid.input.secrets![0], undefined]],
    ["a number", 123],
    ["null", null],
  ])("%s throws invalid_verification_key", (_label, secret) => {
    expect(code(() => run({ secret }))).toBe("invalid_verification_key");
  });

  it.each([
    ["an empty publicKey", ""],
    ["a blank publicKey", "  "],
    ["a valid key and an empty one", [ed.input.publicKeys![0], ""]],
    ["undefined inside a list", [ed.input.publicKeys![0], undefined]],
  ])("%s throws invalid_verification_key", (_label, publicKey) => {
    expect(code(() => run({ publicKey }, ed))).toBe("invalid_verification_key");
  });

  it("refuses an empty key even when a valid public key is also given", () => {
    expect(code(() => run({ secret: "", publicKey: ed.input.publicKeys }, ed))).toBe("invalid_verification_key");
  });

  it("does not accept a request forged with the empty key", async () => {
    const { createHmac } = await import("node:crypto");
    const ts = valid.input.headers["X-Espresso-Timestamp"]!;
    const id = valid.input.headers["X-Espresso-Delivery-Id"]!;
    const forgedBody = JSON.stringify({ event: "notification.sent", forged: true });
    const forged = createHmac("sha256", "").update(`${ts}.${id}.${forgedBody}`).digest("hex");
    const headers = { ...valid.input.headers, "X-Espresso-Signature": `t=${ts},v1=${forged}` };
    expect(code(() => verifySignature({ body: forgedBody, headers, secret: "", now: () => valid.input.now * 1000 }))).toBe("invalid_verification_key");
    // and the same request is no better with a real secret held by the consumer
    expect(() => verifySignature({ body: forgedBody, headers, secret: valid.input.secrets, now: () => valid.input.now * 1000 })).toThrow(EspressoNotifySignatureError);
  });

  it("still says missing_verification_key for an unset value", () => {
    expect(code(() => run({ secret: undefined }))).toBe("missing_verification_key");
  });
});
