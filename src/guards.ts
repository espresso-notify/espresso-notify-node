import { EspressoNotifyConfigError } from "./errors";

const PUBLIC_KEY_PREFIX = "pk_";
// The whole key, not only its start: `sk_live_` and then the characters an API key is made of (the API writes hex). A key with a
// space, a control character or a letter outside this set never reaches a header, where `fetch` would refuse it and throw an
// error that quotes the key.
const SECRET_KEY = /^sk_live_[A-Za-z0-9_-]+$/;

/**
 * The only key the server operations take is a secret key, and the API issues only `sk_live_` ones (AD-181). A public key
 * belongs in the app SDKs and is refused with its own code. The key text is never put in a message.
 */
export function assertSecretKey(apiKey: unknown): string {
  if (typeof apiKey === "string" && apiKey.startsWith(PUBLIC_KEY_PREFIX)) {
    throw new EspressoNotifyConfigError(
      "public_key_not_allowed",
      "apiKey is a public key (pk_...). The public key belongs in the app SDKs; a server uses the secret key of the project (sk_live_...).",
    );
  }
  if (typeof apiKey !== "string" || !SECRET_KEY.test(apiKey)) {
    throw new EspressoNotifyConfigError(
      "invalid_api_key",
      "apiKey is missing or is not a secret key. Pass the secret key of the project as it is: it starts with sk_live_ and has no space, line break or other character after it that a key is not made of.",
    );
  }
  return apiKey;
}

/** A secret key must never ship to a browser: refuse to run where both `window` and `document` exist. */
export function assertServerRuntime(): void {
  const scope = globalThis as { window?: unknown; document?: unknown };
  if (scope.window !== undefined && scope.document !== undefined) {
    throw new EspressoNotifyConfigError(
      "browser_not_supported",
      "This library carries a secret key and must run on a server, not in a browser. Use the Espresso Notify web SDK in the browser.",
    );
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Where the API is. The key travels in every request, so the address must be `https:`; plain `http:` is accepted only for a
 * loopback host (a local mock or a tunnel to the API), and anything that is not a URL is refused here, at construction, instead
 * of failing every call later. The value is never put in the message. A trailing slash is dropped.
 */
export function normalizeBaseUrl(value: unknown): string {
  const refuse = (): never => {
    throw new EspressoNotifyConfigError(
      "invalid_base_url",
      "baseUrl must be an https URL (plain http is accepted only for localhost, 127.0.0.1 and [::1]).",
    );
  };
  if (typeof value !== "string") return refuse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse();
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return refuse();
  return value.replace(/\/+$/, "");
}

const MAX_TIMER_MS = 2 ** 31 - 1; // a longer timer fires at once in Node

function invalidOption(name: string, rule: string): never {
  throw new EspressoNotifyConfigError("invalid_option", `${name} must be ${rule}.`);
}

/** `maxRetries`: a whole number from 0 to 10. Anything else (NaN, Infinity, a string) would retry forever or never. */
export function assertMaxRetries(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10) return invalidOption(name, "an integer from 0 to 10");
  return value;
}

/** `timeoutMs`: a finite number above 0, and not above what a timer holds. */
export function assertTimeoutMs(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    return invalidOption(name, `a number above 0 and at most ${MAX_TIMER_MS}`);
  }
  return value;
}

/** A finite number that is not negative (`toleranceSeconds`). */
export function assertNonNegative(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return invalidOption(name, "a finite number, 0 or more");
  return value;
}

/** The clock of a verification: a function, or nothing for `Date.now`. */
export function assertClock(value: unknown): () => number {
  if (value === undefined) return Date.now;
  if (typeof value !== "function") return invalidOption("now", "a function that returns the current time in milliseconds");
  return value as () => number;
}

/** What the clock returned: a finite number, or the age of a request cannot be told. */
export function assertClockReading(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return invalidOption("now", "a function that returns a finite number of milliseconds");
  return value;
}

/**
 * An id that goes into the path of a call: a positive whole number, or a string that names something. Empty, blank, `.` and `..`
 * are refused: the URL standard folds those two segments away, so `get("..")` would reach `/v1/` and not `/v1/notifications/..`.
 */
export function assertPathId(name: string, value: unknown): string {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) return String(value);
  } else if (typeof value === "string" && value.trim() !== "" && value !== "." && value !== "..") {
    return value;
  }
  throw new EspressoNotifyConfigError("invalid_argument", `${name} must be a non-empty id (not "." or "..").`);
}
