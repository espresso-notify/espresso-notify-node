import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EspressoNotifyConfigError, signIdentityToken } from "../src";

// The fixture is shared with the other server libraries and with the Go verifier: in the monorepo it sits in
// sdk-server/fixtures, in the public mirror at its root, in fixtures/ (the same lookup as support/fixtures.ts).
const PACKAGE_DIR = new URL("..", import.meta.url).pathname;
const SHARED_FIXTURES = [join(PACKAGE_DIR, "fixtures"), join(PACKAGE_DIR, "..", "fixtures")].find((dir) => existsSync(join(dir, "sendTransactional.json")));
if (!SHARED_FIXTURES) throw new Error("the shared fixtures are not next to this package");
const FIXTURE = join(SHARED_FIXTURES, "identity-token.json");

const KID = "ik_00112233aabbccdd";
const PROJECT_ID = "5f0c1d52-1e83-4a4c-9d6b-8f3a1c2b7e90";
const EXTERNAL_ID = "user-42";
const SIGNED_AT_MS = Date.UTC(2026, 9, 30, 12, 0, 0);

function p256(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

const pair = p256();

const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/**
 * A verifier written for this test from node:crypto alone, not a copy of the library: three parts, the header and the claims read
 * back from base64url, and the signature checked in the IEEE P1363 form (R then S, 64 bytes) that JWT ES256 requires.
 */
function verifyToken(token: string, publicKey: KeyObject) {
  const parts = token.split(".");
  expect(parts).toHaveLength(3);
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];
  expect(signaturePart).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
  const signature = Buffer.from(signaturePart, "base64url");
  expect(signature.length).toBe(64);
  const valid = verify("sha256", Buffer.from(`${headerPart}.${claimsPart}`, "utf8"), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  return {
    valid,
    header: JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8")) as Record<string, unknown>,
  };
}

const base = { privateKeyPem: pair.privateKeyPem, kid: KID, projectId: PROJECT_ID, externalId: EXTERNAL_ID };
const at = (ms: number) => () => ms;

describe("signIdentityToken", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a three-part token whose header is {alg: ES256, typ: JWT, kid}", () => {
    const token = signIdentityToken({ ...base, now: at(SIGNED_AT_MS) });
    const { header } = verifyToken(token, createPublicKey(pair.privateKeyPem));
    expect(header).toEqual({ alg: "ES256", typ: "JWT", kid: KID });
  });

  it("carries sub, aud, iat and exp = iat + 3600 by default, and nothing else", () => {
    const token = signIdentityToken({ ...base, now: at(SIGNED_AT_MS) });
    const { claims } = verifyToken(token, createPublicKey(pair.privateKeyPem));
    expect(claims).toEqual({ sub: EXTERNAL_ID, aud: PROJECT_ID, iat: SIGNED_AT_MS / 1000, exp: SIGNED_AT_MS / 1000 + 3600 });
  });

  it("sets exp to iat + ttlSeconds when ttlSeconds is given", () => {
    const token = signIdentityToken({ ...base, ttlSeconds: 90, now: at(SIGNED_AT_MS) });
    const { claims } = verifyToken(token, createPublicKey(pair.privateKeyPem));
    expect(claims.exp).toBe(SIGNED_AT_MS / 1000 + 90);
    expect(claims.iat).toBe(SIGNED_AT_MS / 1000);
  });

  it("takes iat from the clock in whole seconds, rounded down", () => {
    const token = signIdentityToken({ ...base, now: at(SIGNED_AT_MS + 999) });
    const { claims } = verifyToken(token, createPublicKey(pair.privateKeyPem));
    expect(claims.iat).toBe(SIGNED_AT_MS / 1000);
  });

  it("uses the current time when no clock is given", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = signIdentityToken(base);
    const after = Math.floor(Date.now() / 1000);
    const { claims } = verifyToken(token, createPublicKey(pair.privateKeyPem));
    expect(claims.iat as number).toBeGreaterThanOrEqual(before);
    expect(claims.iat as number).toBeLessThanOrEqual(after);
  });

  it("is verified by the public key derived from the private PEM, and by no other key", () => {
    const token = signIdentityToken({ ...base, now: at(SIGNED_AT_MS) });
    expect(verifyToken(token, createPublicKey(pair.privateKeyPem)).valid).toBe(true);
    expect(verifyToken(token, createPublicKey(pair.publicKeyPem)).valid).toBe(true);
    expect(verifyToken(token, createPublicKey(p256().publicKeyPem)).valid).toBe(false);
  });

  it("keeps a subject byte for byte: case and inner spaces are not changed", () => {
    const token = signIdentityToken({ ...base, externalId: "User 42/é", now: at(SIGNED_AT_MS) });
    expect(verifyToken(token, createPublicKey(pair.privateKeyPem)).claims.sub).toBe("User 42/é");
  });

  it("writes the token with the claims and the header exactly as base64url of JSON (no padding)", () => {
    const token = signIdentityToken({ ...base, now: at(SIGNED_AT_MS) });
    const [headerPart, claimsPart] = token.split(".") as [string, string];
    expect(headerPart).toBe(b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: KID })));
    expect(claimsPart).toBe(
      b64url(JSON.stringify({ sub: EXTERNAL_ID, aud: PROJECT_ID, iat: SIGNED_AT_MS / 1000, exp: SIGNED_AT_MS / 1000 + 3600 })),
    );
  });

  describe("refuses with EspressoNotifyConfigError", () => {
    const refused = (input: object, code: string) => {
      let caught: unknown;
      try {
        signIdentityToken(input as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EspressoNotifyConfigError);
      expect((caught as EspressoNotifyConfigError).code).toBe(code);
      return (caught as Error).message;
    };

    it.each([
      ["externalId", ""],
      ["externalId", "   "],
      ["externalId", undefined],
      ["externalId", 42],
      ["kid", ""],
      ["kid", "  "],
      ["kid", undefined],
      ["projectId", ""],
      ["projectId", "\t"],
      ["projectId", undefined],
    ])("an empty or missing %s (%j)", (field, value) => {
      refused({ ...base, [field]: value }, "invalid_argument");
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3600", null])("a ttlSeconds that is not a positive whole number (%j)", (ttl) => {
      refused({ ...base, ttlSeconds: ttl }, "invalid_option");
    });

    it("a ttlSeconds that is not a safe integer", () => {
      refused({ ...base, ttlSeconds: 2 ** 60 }, "invalid_option");
    });

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const ed25519 = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    it.each([
      ["an RSA private key", rsa],
      ["a P-384 private key", p384],
      ["an Ed25519 private key", ed25519],
      ["a public key", pair.publicKeyPem],
      ["text that is not a PEM", "not a key"],
      ["an empty string", ""],
      ["a missing key", undefined],
      ["a number", 7],
    ])("a key that is not a P-256 private key: %s", (_name, key) => {
      refused({ ...base, privateKeyPem: key }, "invalid_argument");
    });

    it("never puts the key in the message", () => {
      const body = pair.privateKeyPem.split("\n").filter((line) => line && !line.startsWith("-----"))[0]!;
      const damaged = pair.privateKeyPem.replace("-----END PRIVATE KEY-----", "");
      const message = refused({ ...base, privateKeyPem: damaged }, "invalid_argument");
      expect(message).not.toContain(body);
      expect(message).not.toContain("BEGIN");
      const other = refused({ ...base, privateKeyPem: "not a key" }, "invalid_argument");
      expect(other).not.toContain("not a key");
    });

    it("a call without an object", () => {
      refused(null as never, "invalid_argument");
      refused(undefined as never, "invalid_argument");
    });

    it("a clock that is not a function or returns no finite number", () => {
      refused({ ...base, now: 5 }, "invalid_option");
      refused({ ...base, now: () => Number.NaN }, "invalid_option");
    });
  });

  it("writes nothing to the console, for a good call and for a refused one", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    signIdentityToken({ ...base, now: at(SIGNED_AT_MS) });
    expect(() => signIdentityToken({ ...base, privateKeyPem: "not a key" })).toThrow();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("is exported from the package entry point", async () => {
    const entry = await import("../src");
    expect(entry.signIdentityToken).toBe(signIdentityToken);
  });
});

// Cross-language proof with the server (JWT-33): this test writes the token to a fixture and the Go test of the server's
// verification package reads it and verifies it with `Verify`. ECDSA signatures are random, so the file is written when it is
// missing or when ESPRESSO_WRITE_IDENTITY_FIXTURE=1. The fixture holds the public key and the token only: the file is
// copied to the public mirror of the library, so the private key of the pair is thrown away once the token is signed
// (CIG-09); the signing itself is proved with a pair made by this run.
describe("identity token fixture shared with the server", () => {
  interface Fixture {
    publicKeyPem: string;
    kid: string;
    projectId: string;
    externalId: string;
    signedAt: number;
    ttlSeconds: number;
    token: string;
  }

  if (!existsSync(FIXTURE) || process.env.ESPRESSO_WRITE_IDENTITY_FIXTURE === "1") {
    const fresh = p256();
    const ttlSeconds = 3600;
    const token = signIdentityToken({ privateKeyPem: fresh.privateKeyPem, kid: KID, projectId: PROJECT_ID, externalId: EXTERNAL_ID, ttlSeconds, now: at(SIGNED_AT_MS) });
    mkdirSync(dirname(FIXTURE), { recursive: true });
    const fixture: Fixture = { publicKeyPem: fresh.publicKeyPem, kid: KID, projectId: PROJECT_ID, externalId: EXTERNAL_ID, signedAt: SIGNED_AT_MS / 1000, ttlSeconds, token };
    writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  }

  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture & { privateKeyPem?: string };

  it("holds a token that an independent verifier accepts with every claim", () => {
    const { valid, header, claims } = verifyToken(fixture.token, createPublicKey(fixture.publicKeyPem));
    expect(valid).toBe(true);
    expect(header).toEqual({ alg: "ES256", typ: "JWT", kid: fixture.kid });
    expect(claims).toEqual({ sub: fixture.externalId, aud: fixture.projectId, iat: fixture.signedAt, exp: fixture.signedAt + fixture.ttlSeconds });
  });

  it("holds no private key, since the file is published with the library", () => {
    expect(fixture.privateKeyPem).toBeUndefined();
    expect(readFileSync(FIXTURE, "utf8")).not.toContain("PRIVATE KEY");
  });

  it("signs, with a pair made by this run and the claims of the fixture, the same claims the fixture token carries", () => {
    const fresh = p256();
    const token = signIdentityToken({
      privateKeyPem: fresh.privateKeyPem,
      kid: fixture.kid,
      projectId: fixture.projectId,
      externalId: fixture.externalId,
      ttlSeconds: fixture.ttlSeconds,
      now: at(fixture.signedAt * 1000),
    });
    const mine = verifyToken(token, createPublicKey(fresh.publicKeyPem));
    expect(mine.valid).toBe(true);
    expect(mine.header).toEqual({ alg: "ES256", typ: "JWT", kid: fixture.kid });
    expect(mine.claims).toEqual(verifyToken(fixture.token, createPublicKey(fixture.publicKeyPem)).claims);
    expect(verifyToken(token, createPublicKey(fixture.publicKeyPem)).valid).toBe(false);
  });
});

// feature: server.identity-token-signing
