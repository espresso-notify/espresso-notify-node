import { createHmac, createPublicKey, createHash, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { EspressoNotifyConfigError, EspressoNotifySignatureError } from "./errors";
import { assertClock, assertClockReading, assertNonNegative } from "./guards";

type HeaderValue = string | string[] | undefined;
export type HeadersInput = Headers | Record<string, HeaderValue>;

export interface VerifySignatureInput {
  /**
   * The body exactly as it arrived: a string or a Buffer read from the request before any JSON parsing. A parsed object is
   * refused, because the signature covers the bytes and a re-serialized object is other bytes.
   */
  body: string | Uint8Array;
  /** The headers of the request: a Fetch `Headers` or a Node headers object (any case of name). */
  headers: HeadersInput;
  /** The HMAC secret of the webhook, journey webhook or event stream. A list is accepted for the window of a secret rotation. */
  secret?: string | string[];
  /** The Ed25519 public key of the webhook (PEM, or the base64 of its DER). A list is accepted for the window of a key rotation. */
  publicKey?: string | string[];
  /** How far from the current time the signed timestamp may be, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** The current time in milliseconds. Default `Date.now`. */
  now?: () => number;
}

const SIGNATURE = "X-Espresso-Signature";
const SIGNATURE_ED25519 = "X-Espresso-Signature-Ed25519";
const KEY_ID = "X-Espresso-Key-Id";
const TIMESTAMP = "X-Espresso-Timestamp";
const DELIVERY_ID = "X-Espresso-Delivery-Id";
const BATCH_ID = "X-Espresso-Batch-Id";
const DEFAULT_TOLERANCE_SECONDS = 300;

/** A header value is a string, or a list of strings (Node joins repeated headers into one string, or keeps a list for some). Anything else counts as absent. */
function headerText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value.join(" ");
  return undefined;
}

function header(headers: HeadersInput, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return headerText((headers as Headers).get(name));
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, HeaderValue>)) {
    if (key.toLowerCase() !== wanted) continue;
    const text = headerText(value);
    if (text !== undefined) return text;
  }
  return undefined;
}

function missing(...names: string[]): EspressoNotifySignatureError {
  return new EspressoNotifySignatureError("missing_header", `The request has no ${names.join(" or ")} header.`);
}

const mismatch = () => new EspressoNotifySignatureError("signature_mismatch", "The signature does not match the body, the secret or the key.");

/**
 * The keys a caller passed, each one checked. An empty key must never reach the HMAC: anyone can compute an HMAC with the empty
 * key, so an app whose environment variable is unset and passes "" would accept forged requests. Every entry of a list is
 * checked, so one empty entry throws instead of being skipped.
 */
function keyList(value: unknown, what: "secret" | "publicKey"): string[] {
  if (value === undefined) return [];
  const entries: unknown[] = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new EspressoNotifyConfigError("invalid_verification_key", `${what} must be a non-empty string (or a list of them); an empty or unset value would let anyone forge a request.`);
    }
  }
  return entries as string[];
}

function equalHex(expected: Buffer, candidate: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(candidate)) return false;
  return timingSafeEqual(expected, Buffer.from(candidate, "hex"));
}

/** The v1 values of the signature sets (`t=<ts>,v1=<hex>`, separated by spaces). `v0` and anything else is ignored. */
function v1Values(signature: string): string[] {
  const values: string[] = [];
  for (const set of signature.split(/\s+/).filter(Boolean)) {
    for (const part of set.split(",")) {
      if (part.startsWith("v1=")) values.push(part.slice(3));
    }
  }
  return values;
}

const NOT_ED25519 = () => new EspressoNotifyConfigError("invalid_verification_key", "publicKey is not an Ed25519 public key (PEM, or the base64 of its DER).");

function parsePublicKey(value: string): KeyObject {
  let key: KeyObject;
  try {
    const text = value.trim();
    key = text.startsWith("-----BEGIN") ? createPublicKey(text) : createPublicKey({ key: Buffer.from(text, "base64"), format: "der", type: "spki" });
  } catch {
    throw NOT_ED25519();
  }
  // A key of another type (X25519, RSA, EC) parses, and would fail only when it is used, with an error of OpenSSL.
  if (key.asymmetricKeyType !== "ed25519") throw NOT_ED25519();
  return key;
}

function keyIdOf(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return `fp-${createHash("sha256").update(der).digest("hex").slice(0, 16)}`;
}

function verifyHmac(secrets: string[], signature: string, signed: Buffer, prefix: Buffer): boolean {
  const candidates = v1Values(signature);
  let ok = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(prefix).update(signed).digest();
    for (const candidate of candidates) ok = equalHex(expected, candidate) || ok; // every pair is compared: no early exit on a match
  }
  return ok;
}

function verifyEd25519(keys: KeyObject[], signatures: string, keyIds: string, message: Buffer): boolean {
  const ids = keyIds.split(/\s+/).filter(Boolean);
  const sets = signatures.split(/\s+/).filter(Boolean);
  const known = new Map(keys.map((key) => [keyIdOf(key), key]));
  let ok = false;
  sets.forEach((set, position) => {
    const key = known.get(ids[position] ?? "");
    if (!key || !set.startsWith("ed25519_v1=")) return;
    const signature = Buffer.from(set.slice("ed25519_v1=".length), "base64");
    try {
      ok = verify(null, message, key, signature) || ok;
    } catch {
      // a signature OpenSSL cannot read is a signature that does not match
    }
  });
  return ok;
}

/**
 * Checks a signed request of the platform and returns its parsed JSON body. It throws `EspressoNotifySignatureError` when the
 * request must not be trusted. An HMAC check needs `secret`, an Ed25519 check needs `publicKey`; with both, the request is
 * valid when either one verifies. The comparison of HMACs is constant time.
 *
 * ```ts
 * app.post("/webhooks/espresso", express.raw({ type: "application/json" }), (req, res) => {
 *   try {
 *     const event = verifySignature({ body: req.body, headers: req.headers, secret: process.env.ESPRESSO_WEBHOOK_SECRET! });
 *     res.sendStatus(200);
 *   } catch {
 *     res.sendStatus(400);
 *   }
 * });
 * ```
 */
export function verifySignature(input: VerifySignatureInput): unknown {
  if (input === null || typeof input !== "object") {
    throw new EspressoNotifyConfigError("invalid_option", "verifySignature needs one object: { body, headers, secret or publicKey }.");
  }
  const { body, headers } = input;
  const secrets = keyList(input.secret, "secret");
  const publicKeys = keyList(input.publicKey, "publicKey");
  // A tolerance or a clock that is not a usable number would turn the check of the age off (NaN is never greater than anything).
  const tolerance = input.toleranceSeconds === undefined ? DEFAULT_TOLERANCE_SECONDS : assertNonNegative("toleranceSeconds", input.toleranceSeconds);
  const clock = assertClock(input.now);
  if (typeof body !== "string" && !(body instanceof Uint8Array)) {
    throw new EspressoNotifySignatureError("raw_body_required", "verifySignature needs the raw body (a string or a Buffer), not a parsed object.");
  }
  if (headers === null || typeof headers !== "object") {
    throw new EspressoNotifySignatureError("missing_header", "The request has no headers to verify.");
  }
  if (secrets.length === 0 && publicKeys.length === 0) {
    throw new EspressoNotifyConfigError("missing_verification_key", "verifySignature needs a secret (HMAC) or a publicKey (Ed25519).");
  }
  const keys = publicKeys.map(parsePublicKey);

  const timestamp = header(headers, TIMESTAMP);
  const id = header(headers, DELIVERY_ID) ?? header(headers, BATCH_ID);
  const hmacSignature = header(headers, SIGNATURE);
  const edSignature = header(headers, SIGNATURE_ED25519);
  const keyIds = header(headers, KEY_ID);

  // Only the header the key at hand is checked against is required: an Ed25519 request still carries the HMAC set, but a
  // consumer that holds only the public key does not need it.
  if (secrets.length > 0 && keys.length === 0 && !hmacSignature) throw missing(SIGNATURE);
  if (keys.length > 0 && secrets.length === 0 && !edSignature) throw missing(SIGNATURE_ED25519);
  if (timestamp === undefined) throw missing(TIMESTAMP);
  if (id === undefined) throw missing(DELIVERY_ID, BATCH_ID);
  if (keys.length > 0 && !keyIds && (secrets.length === 0 || !hmacSignature)) throw missing(KEY_ID);

  const stamp = /^\d+$/.test(timestamp) ? Number(timestamp) : Number.NaN;
  if (Number.isNaN(stamp)) throw mismatch();
  const nowSeconds = Math.floor(assertClockReading(clock()) / 1000);
  if (Math.abs(nowSeconds - stamp) > tolerance) {
    throw new EspressoNotifySignatureError("timestamp_out_of_tolerance", `The signed timestamp is more than ${tolerance} seconds from the current time.`);
  }

  const raw = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const prefix = Buffer.from(`${timestamp}.${id}.`, "utf8");

  const hmacOk = secrets.length > 0 && hmacSignature !== undefined && verifyHmac(secrets, hmacSignature, raw, prefix);
  const edOk = keys.length > 0 && edSignature !== undefined && keyIds !== undefined && verifyEd25519(keys, edSignature, keyIds, Buffer.concat([prefix, raw]));
  if (!hmacOk && !edOk) throw mismatch();

  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    // The signature is right and the body is not JSON. The body is not quoted: it is the sender's.
    throw new EspressoNotifySignatureError("invalid_body", "The signature is valid but the body is not JSON.");
  }
}
