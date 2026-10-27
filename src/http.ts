import { EspressoNotifyAbortError, EspressoNotifyApiError } from "./errors";
import { VERSION } from "./version";

/** What one call may override on the client's defaults. */
export interface RequestOptions {
  /** Aborts the call: the current attempt stops and no other is made. */
  signal?: AbortSignal;
  /** Milliseconds one attempt may take. Defaults to the client's `timeoutMs`. */
  timeoutMs?: number;
  /** Retries after the first attempt. Defaults to the client's `maxRetries`. */
  maxRetries?: number;
  /** Milliseconds the whole call may take, the retries and the waits between them included. Defaults to the client's `deadlineMs`. */
  deadlineMs?: number;
}

export type FetchApi = (url: string, init?: RequestInit) => Promise<Response>;

/** A `fetch` the caller supplies (the WHATWG signature): it gets every request of the library, headers and body as they would go out. */
export type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

/** The settings of one call once the client's defaults are applied. */
export interface TransportConfig {
  maxRetries: number;
  timeoutMs: number;
  /** The whole call, retries and waits included. Without it the call has no bound but the attempts' own. */
  deadlineMs?: number;
  /** The `fetch` that sends every request. Default: the global one. */
  fetch?: FetchFunction;
  signal?: AbortSignal;
}

/** The clock, the dice and the sleep of the retry loop, replaced by the tests of its arithmetic. */
export interface TransportHooks {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** A clock that only moves forward, in milliseconds: the deadline is measured on it. Default `performance.now`. */
  tick?: () => number;
}

/** The statuses the API (or a proxy before it) answers for a failure that a later attempt can get past. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8_000;
export const RETRY_AFTER_CAP_SECONDS = 60;
/** The most a `Retry-After` wait is stretched by: a random 0 to 25% more, so callers that were refused together do not return together. */
export const RETRY_AFTER_JITTER = 0.25;

export function userAgent(): string {
  return `espresso-notify-node/${VERSION} node/${process.version}`;
}

/** Full jitter: a random wait between 0 and 500 ms doubled by every attempt already made, never more than 8 s. */
export function backoffMs(retry: number, random: () => number): number {
  return Math.floor(random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** retry));
}

/** The wait for a `Retry-After`: that many seconds (at most 60) plus a random 0 to 25%, and never more than 60 s in all. */
export function retryAfterWaitMs(seconds: number, random: () => number): number {
  const base = Math.min(seconds, RETRY_AFTER_CAP_SECONDS) * 1000;
  return Math.min(RETRY_AFTER_CAP_SECONDS * 1000, Math.floor(base * (1 + RETRY_AFTER_JITTER * random())));
}

/** `Retry-After` in seconds: a whole number of seconds, or an HTTP date turned into the seconds from `nowMs`. */
export function parseRetryAfterSeconds(value: string | null | undefined, nowMs: number): number | undefined {
  if (value == null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - nowMs) / 1000));
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new EspressoNotifyAbortError(signal.reason));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new EspressoNotifyAbortError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type Attempt = { response: Response } | { failure: unknown; timedOut: boolean };

function looksLikeResponse(value: unknown): value is Response {
  const res = value as Partial<Response> | null | undefined;
  return res != null && typeof res === "object" && typeof res.status === "number" && typeof res.arrayBuffer === "function" && res.headers != null;
}

/** The `fetch` option returned something that is not a Response: a mistake of the caller's function, never retried. */
function notAResponse(): EspressoNotifyApiError {
  return new EspressoNotifyApiError({ status: 0, code: "invalid_response", message: "The fetch option did not return a Response." });
}

/**
 * One attempt. The timer covers the whole attempt, the answer's body included: the body is read here and the caller gets a
 * Response that holds it, so a server that sends headers and then stalls is timed out too.
 */
async function attempt(url: string, init: RequestInit, config: TransportConfig): Promise<Attempt> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  config.signal?.addEventListener("abort", stop, { once: true });
  try {
    // The API does not redirect. A redirect is never followed: it would turn a POST into a GET, or send the body elsewhere.
    const res = await (config.fetch ?? fetch)(url, { ...init, signal: controller.signal, redirect: "manual" });
    if (!looksLikeResponse(res)) return { failure: notAResponse(), timedOut: false };
    const body = await res.arrayBuffer();
    return { response: new Response(body.byteLength > 0 ? body : null, { status: res.status, statusText: res.statusText, headers: res.headers }) };
  } catch (failure) {
    if (config.signal?.aborted) throw new EspressoNotifyAbortError(config.signal.reason);
    return { failure, timedOut };
  } finally {
    clearTimeout(timer);
    config.signal?.removeEventListener("abort", stop);
  }
}

/**
 * What `fetch` throws when the request never left because the request itself is refused (a header value with a line break, an
 * unparsable URL) is a TypeError whose message is not "fetch failed", and it may quote the header, key included. It is not a
 * connection failure, so it is not retried, and neither it nor its message is kept.
 */
function refusedBeforeSending(failure: unknown): boolean {
  return failure instanceof TypeError && failure.message !== "fetch failed";
}

function requestNotSent(): EspressoNotifyApiError {
  return new EspressoNotifyApiError({ status: 0, code: "request_not_sent", message: "The request was refused before it was sent (a header or the URL is not valid)." });
}

function deadlineExceeded(deadlineMs: number, attempts: number, cause: unknown): EspressoNotifyApiError {
  return new EspressoNotifyApiError({
    status: 0,
    code: "deadline_exceeded",
    message: `The call did not finish within ${deadlineMs} ms (${attempts} ${attempts === 1 ? "attempt" : "attempts"}); \`cause\` is the last failure.`,
    cause,
  });
}

function connectionError(failure: unknown, timedOut: boolean, timeoutMs: number): EspressoNotifyApiError {
  const code = failure instanceof Error && failure.cause && typeof (failure.cause as { code?: unknown }).code === "string" ? (failure.cause as { code: string }).code : undefined;
  return new EspressoNotifyApiError({
    status: 0,
    code: "network_error",
    message: timedOut ? `No answer within ${timeoutMs} ms.` : `The request could not be completed${code ? ` (${code})` : ""}.`,
    cause: failure,
  });
}

/**
 * The `fetch` the generated client uses for one call: the User-Agent on every request, a timeout per attempt, the caller's
 * signal, and the retries of a failure that a later attempt can get past. It returns the Response of the last attempt, whatever
 * its status (the client turns an error status into an `EspressoNotifyApiError`), and throws only for a connection that failed
 * on every attempt or for an abort.
 */
export function createFetchApi(config: TransportConfig, hooks: TransportHooks = {}): FetchApi {
  const sleep = hooks.sleep ?? defaultSleep;
  const random = hooks.random ?? Math.random;
  const now = hooks.now ?? Date.now;
  const tick = hooks.tick ?? (() => performance.now());
  const ua = userAgent();

  return async (url, init = {}) => {
    const headers = { ...(init.headers as Record<string, string> | undefined), "User-Agent": ua };
    const deadlineMs = config.deadlineMs;
    const started = tick();
    const left = () => (deadlineMs === undefined ? Number.POSITIVE_INFINITY : deadlineMs - (tick() - started));
    for (let retry = 0; ; retry++) {
      if (config.signal?.aborted) throw new EspressoNotifyAbortError(config.signal.reason);
      const remaining = left();
      if (remaining <= 0) throw deadlineExceeded(deadlineMs!, retry, undefined);
      // An attempt never runs past the deadline: its timer is the shorter of the two.
      const cutByDeadline = remaining < config.timeoutMs;
      const result = await attempt(url, { ...init, headers }, { ...config, timeoutMs: cutByDeadline ? remaining : config.timeoutMs });
      const canRetry = retry < config.maxRetries;

      if ("failure" in result) {
        if (result.failure instanceof EspressoNotifyApiError) throw result.failure;
        if (refusedBeforeSending(result.failure)) throw requestNotSent();
        const error = connectionError(result.failure, result.timedOut, config.timeoutMs);
        if (result.timedOut && cutByDeadline) throw deadlineExceeded(deadlineMs!, retry + 1, error);
        if (!canRetry) throw error;
        const wait = backoffMs(retry, random);
        if (wait >= left()) throw deadlineExceeded(deadlineMs!, retry + 1, error);
        await sleep(wait, config.signal);
        continue;
      }
      if (RETRYABLE_STATUSES.has(result.response.status) && canRetry) {
        const after = parseRetryAfterSeconds(result.response.headers.get("retry-after"), now());
        const wait = after !== undefined ? retryAfterWaitMs(after, random) : backoffMs(retry, random);
        // A wait that does not leave time for the next attempt ends the call now, not at the deadline.
        if (wait >= left()) throw deadlineExceeded(deadlineMs!, retry + 1, await apiErrorFrom(result.response, now()));
        await sleep(wait, config.signal);
        continue;
      }
      return result.response;
    }
  };
}

/** The `EspressoNotifyApiError` for a Response with an error status: the code and text of a JSON body, `unknown` otherwise. */
export async function apiErrorFrom(response: Response, nowMs: number = Date.now()): Promise<EspressoNotifyApiError> {
  let code = "unknown";
  let error: string | undefined;
  if (response.status >= 300 && response.status < 400) {
    // The body of a redirect is not the API's: it is not read, and the Location is not kept.
    return new EspressoNotifyApiError({
      status: response.status,
      code: "unexpected_redirect",
      message: `The API answered ${response.status}, a redirect. A redirect is never followed; check baseUrl.`,
      requestId: response.headers.get("x-request-id") ?? undefined,
    });
  }
  try {
    const body: unknown = JSON.parse(await response.text());
    if (body !== null && typeof body === "object") {
      const fields = body as { code?: unknown; error?: unknown };
      if (typeof fields.code === "string" && fields.code !== "") code = fields.code;
      if (typeof fields.error === "string") error = fields.error;
    }
  } catch {
    // not JSON: the status is all there is
  }
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"), nowMs);
  return new EspressoNotifyApiError({ status: response.status, code, error, requestId, retryAfterSeconds });
}
