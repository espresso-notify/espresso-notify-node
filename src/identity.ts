import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { EspressoNotifyConfigError } from "./errors";
import { assertClock, assertClockReading } from "./guards";

export interface SignIdentityTokenInput {
  /** The private key the dashboard showed once when you generated the key, as a PEM (`-----BEGIN PRIVATE KEY-----`). It stays on your server. */
  privateKeyPem: string;
  /** The `kid` of that key, shown in the dashboard next to it. It travels in the header of every token. */
  kid: string;
  /** The public id of the project (the identifier the dashboard shows). It becomes the `aud` claim. */
  projectId: string;
  /** The id of the user, exactly as the app gives it to the SDK. It becomes the `sub` claim. */
  externalId: string;
  /** How long the token is valid, in seconds. A whole number above 0; the default is 3600 (one hour). */
  ttlSeconds?: number;
  /** The current time in milliseconds. Default `Date.now`. */
  now?: () => number;
}

const DEFAULT_TTL_SECONDS = 3600;

function invalidArgument(message: string): never {
  throw new EspressoNotifyConfigError("invalid_argument", message);
}

/** A text that names something: not empty, not only blanks. */
function assertText(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return invalidArgument(`${name} must be a non-empty string.`);
  return value;
}

/**
 * The private key, parsed. The messages never hold the key or what OpenSSL says about it, which can quote the input. A key of
 * another type or another curve parses and would fail only when it signs, so it is refused here, before a token is made.
 */
function parsePrivateKey(value: unknown): KeyObject {
  const refuse = (): never => invalidArgument("privateKeyPem must be the P-256 private key (PEM) that the dashboard showed when the key was generated.");
  if (typeof value !== "string" || value.trim() === "") return refuse();
  let key: KeyObject;
  try {
    key = createPrivateKey(value);
  } catch {
    return refuse();
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return refuse();
  return key;
}

function ttl(value: unknown): number {
  if (value === undefined) return DEFAULT_TTL_SECONDS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new EspressoNotifyConfigError("invalid_option", "ttlSeconds must be a whole number above 0.");
  }
  return value;
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/**
 * Signs the identity token your backend hands to the app after the user logs in. The app gives it to the SDK, and Espresso Notify
 * accepts a request that links a device to that user, erases a device or reads preferences only with a token signed by the key of
 * the project. The token is an `ES256` JWT: the header holds `kid`, and the claims are `sub` (the user id), `aud` (the project id),
 * `iat` and `exp` (`iat` plus `ttlSeconds`, one hour by default). It is made with `node:crypto` alone and the key is not logged.
 *
 * ```ts
 * const token = signIdentityToken({
 *   privateKeyPem: process.env.ESPRESSO_IDENTITY_PRIVATE_KEY!, // shown once in the dashboard
 *   kid: 'ik_0123456789abcdef',
 *   projectId: '5f0c1d52-1e83-4a4c-9d6b-8f3a1c2b7e90',
 *   externalId: 'user-1001',
 * })
 * ```
 *
 * It throws `EspressoNotifyConfigError` when an argument cannot be used: an empty `externalId`, `kid` or `projectId`, a
 * `ttlSeconds` that is not a whole number above 0, or a key that is not a P-256 private key.
 */
export function signIdentityToken(input: SignIdentityTokenInput): string {
  if (input === null || typeof input !== "object") {
    return invalidArgument("signIdentityToken needs one object: { privateKeyPem, kid, projectId, externalId }.");
  }
  const kid = assertText("kid", input.kid);
  const projectId = assertText("projectId", input.projectId);
  const externalId = assertText("externalId", input.externalId);
  const lifetime = ttl(input.ttlSeconds);
  const clock = assertClock(input.now);
  const key = parsePrivateKey(input.privateKeyPem);

  const issuedAt = Math.floor(assertClockReading(clock()) / 1000);
  const signingInput = `${encode({ alg: "ES256", typ: "JWT", kid })}.${encode({ sub: externalId, aud: projectId, iat: issuedAt, exp: issuedAt + lifetime })}`;
  // JWT wants the signature as R then S, 64 bytes; node:crypto writes DER unless it is told this form.
  const signature = sign("sha256", Buffer.from(signingInput, "utf8"), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}
