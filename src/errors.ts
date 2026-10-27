/** Every error the library throws extends this one. `code` is a stable string to branch on, never the message. */
export class EspressoNotifyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export type ConfigErrorCode =
  | "invalid_api_key"
  | "public_key_not_allowed"
  | "browser_not_supported"
  | "invalid_base_url"
  | "invalid_option"
  | "invalid_argument"
  | "missing_verification_key"
  | "invalid_verification_key";

/** The client cannot be built, a call was given an argument it cannot use (an option out of range, an id that is empty, `.` or `..`), or a verification was asked without a usable key. Nothing was sent. */
export class EspressoNotifyConfigError extends EspressoNotifyError {
  declare readonly code: ConfigErrorCode;

  constructor(code: ConfigErrorCode, message: string) {
    super(code, message);
  }
}

/**
 * The API answered with a status from 400 to 599 (after the retries, for a status that is retried), or the connection failed
 * or timed out on every attempt (`status` 0, `code` `network_error`), or a 2xx answer was not JSON (`invalid_response`, with the status). `code` is the `code` of the body, which is stable; it is
 * `unknown` when the body is not JSON or names none. Branch on `status` and `code`, never on `error` or the message.
 */
export class EspressoNotifyApiError extends EspressoNotifyError {
  /** The HTTP status, or 0 when no answer arrived. */
  readonly status: number;
  /** The `error` text of the body, as the API wrote it. */
  readonly error?: string;
  /** The `x-request-id` of the answer, to give to support. */
  readonly requestId?: string;
  /** The `Retry-After` of the answer, in seconds. */
  readonly retryAfterSeconds?: number;

  constructor(init: { status: number; code: string; error?: string; requestId?: string; retryAfterSeconds?: number; message?: string; cause?: unknown }) {
    super(init.code, init.message ?? `Espresso Notify API answered ${init.status} ${init.code}${init.error ? `: ${init.error}` : ""}`);
    this.status = init.status;
    if (init.error !== undefined) this.error = init.error;
    if (init.requestId !== undefined) this.requestId = init.requestId;
    if (init.retryAfterSeconds !== undefined) this.retryAfterSeconds = init.retryAfterSeconds;
    if (init.cause !== undefined) this.cause = init.cause;
  }
}

/** The caller's `AbortSignal` fired: the attempt in flight was stopped and no other was made. */
export class EspressoNotifyAbortError extends EspressoNotifyError {
  constructor(cause?: unknown) {
    super("aborted", "The call was aborted by the AbortSignal.");
    if (cause !== undefined) this.cause = cause;
  }
}

export type SignatureErrorCode = "signature_mismatch" | "timestamp_out_of_tolerance" | "missing_header" | "raw_body_required" | "invalid_body";

/**
 * A signed request of the platform (webhook, journey webhook, event stream) must not be trusted. Answer it with a 400 and drop it.
 * `code` is `signature_mismatch` (no signature set matches), `timestamp_out_of_tolerance` (too old or too new, which also stops a
 * replay), `missing_header` (the message names the header, or says the request has no headers), `raw_body_required` (the body was
 * parsed before it was verified) or `invalid_body` (the signature is right but the body is not JSON).
 */
export class EspressoNotifySignatureError extends EspressoNotifyError {
  declare readonly code: SignatureErrorCode;

  constructor(code: SignatureErrorCode, message: string) {
    super(code, message);
  }
}
