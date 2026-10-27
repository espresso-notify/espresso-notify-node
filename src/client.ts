import {
  BaseAPI,
  Configuration,
  EventsAndConversionsApi,
  FetchError,
  JourneysApi,
  NotificationsApi,
  PreferencesApi,
  ResponseError,
  UsersAndDevicesApi,
  type ApiResponse,
} from "./generated/index";
import { EspressoNotifyApiError, EspressoNotifyConfigError, EspressoNotifyError } from "./errors";
import { assertPathId, assertMaxRetries, assertSecretKey, assertServerRuntime, assertTimeoutMs, normalizeBaseUrl } from "./guards";
import { withIdempotencyKey, withIdempotencyKeys } from "./idempotency";
import { apiErrorFrom, createFetchApi, type FetchFunction, type RequestOptions } from "./http";
import type { Operation } from "./operations";
import { RETRY_POLICY } from "./retry-policy";
import type {
  AddedToken,
  AddTokenRequest,
  BroadcastRequest,
  BroadcastResult,
  CancelResult,
  Category,
  ConversionResult,
  CreatedUser,
  CreateUserRequest,
  EnterJourneyRequest,
  EnterJourneyResult,
  NotificationStatus,
  PersonalizedRequest,
  PersonalizedResult,
  Preference,
  QueryPreferencesRequest,
  RecordConversionRequest,
  SetPreferencesRequest,
  SetPreferencesResult,
  TransactionalBatchRequest,
  TransactionalBatchResult,
  TransactionalRequest,
  TransactionalResult,
  Variable,
} from "./types";

export const DEFAULT_BASE_URL = "https://api.espressonotify.com";
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_DEADLINE_MS = 60_000;

export interface EspressoNotifyOptions {
  /** The secret key of the project (`sk_live_...`). */
  apiKey: string;
  /** Where the API is. Defaults to `https://api.espressonotify.com`. */
  baseUrl?: string;
  /** Retries after the first attempt of a call. Default 2, so 3 attempts. 0 makes one attempt. */
  maxRetries?: number;
  /** Milliseconds one attempt may take. Default 30000. */
  timeoutMs?: number;
  /** Milliseconds a whole call may take, the retries and the waits between them included. Default 60000. A call that reaches it rejects with `deadline_exceeded`. */
  deadlineMs?: number;
  /**
   * The `fetch` that sends every request, with the same headers and body as the global one would. Use it for a proxy or a
   * custom dispatcher (undici `ProxyAgent`), or to count and log requests. Default: the global `fetch`.
   */
  fetch?: FetchFunction;
}

/** What every method needs from the client: to run one generated call with the settings of that call, and get the JSON back. */
interface Transport {
  run<A extends BaseAPI, T>(
    Api: new (configuration: Configuration) => A,
    operation: Operation,
    options: RequestOptions | undefined,
    call: (api: A) => Promise<ApiResponse<unknown>>,
  ): Promise<T>;
}

/**
 * The generated client reports an error status as its own ResponseError and wraps what the library `fetch` throws in a
 * FetchError; the caller gets the library's errors instead.
 */
async function libraryError(error: unknown): Promise<unknown> {
  if (error instanceof ResponseError) return apiErrorFrom(error.response);
  if (error instanceof FetchError && error.cause instanceof EspressoNotifyError) return error.cause;
  return error;
}

/** Awaits one generated call and returns the JSON of the answer as the API wrote it. */
async function json<T>(call: () => Promise<ApiResponse<unknown>>): Promise<T> {
  let answer: ApiResponse<unknown>;
  try {
    answer = await call();
  } catch (error) {
    throw await libraryError(error);
  }
  const text = await answer.raw.text();
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // The answer text is not kept: it is not the API's, so it may be anything, and the error is for logs.
    throw new EspressoNotifyApiError({
      status: answer.raw.status,
      code: "invalid_response",
      message: `The API answered ${answer.raw.status} with a body that is not JSON; check baseUrl.`,
      requestId: answer.raw.headers.get("x-request-id") ?? undefined,
    });
  }
}

class Notifications {
  constructor(private readonly transport: Transport) {}

  /** Sends to every device of the project (or of an audience). A send without `idempotency_key` gets one, kept across retries. */
  broadcast(body: BroadcastRequest, opts?: RequestOptions): Promise<BroadcastResult> {
    return this.transport.run(NotificationsApi, "sendBroadcast", opts, (api) => api.sendBroadcastRaw({ broadcastRequest: withIdempotencyKey(body) }));
  }

  /** Sends to the devices of the users you list. */
  personalized(body: PersonalizedRequest, opts?: RequestOptions): Promise<PersonalizedResult> {
    return this.transport.run(NotificationsApi, "sendPersonalized", opts, (api) => api.sendPersonalizedRaw({ personalizedRequest: withIdempotencyKey(body) }));
  }

  /** Sends a high-priority notification to one user. */
  transactional(body: TransactionalRequest, opts?: RequestOptions): Promise<TransactionalResult> {
    return this.transport.run(NotificationsApi, "sendTransactional", opts, (api) => api.sendTransactionalRaw({ transactionalRequest: withIdempotencyKey(body) }));
  }

  /** Sends up to 500 transactional notifications in one request; each item is answered at its position and gets its own `idempotency_key` when it has none. */
  transactionalBatch(body: TransactionalBatchRequest, opts?: RequestOptions): Promise<TransactionalBatchResult> {
    return this.transport.run(NotificationsApi, "sendTransactionalBatch", opts, (api) => api.sendTransactionalBatchRaw({ transactionalBatchRequest: withIdempotencyKeys(body) }));
  }

  /** Reads the status of a notification by its numeric id or its `public_id`. */
  get(id: string | number, opts?: RequestOptions): Promise<NotificationStatus> {
    return this.transport.run(NotificationsApi, "getNotification", opts, (api) => api.getNotificationRaw({ id: assertPathId("id", id) }));
  }

  /** Cancels a notification that has not started, or stops one that is being delivered. */
  cancel(id: string | number, opts?: RequestOptions): Promise<CancelResult> {
    return this.transport.run(NotificationsApi, "cancelNotification", opts, (api) => api.cancelNotificationRaw({ id: assertPathId("id", id) }));
  }
}

class Users {
  constructor(private readonly transport: Transport) {}

  /** Creates a user, or updates the one with the same `external_id`. */
  create(body: CreateUserRequest, opts?: RequestOptions): Promise<CreatedUser> {
    return this.transport.run(UsersAndDevicesApi, "createUser", opts, (api) => api.createUserRaw({ createUserRequest: body }));
  }
}

class Tokens {
  constructor(private readonly transport: Transport) {}

  /** Adds a push token to a user. */
  add(body: AddTokenRequest, opts?: RequestOptions): Promise<AddedToken> {
    return this.transport.run(UsersAndDevicesApi, "addToken", opts, (api) => api.addTokenRaw({ addTokenRequest: body }));
  }
}

class Conversions {
  constructor(private readonly transport: Transport) {}

  /** Reports a conversion (a purchase) so it is credited to the notification that led to it. */
  record(body: RecordConversionRequest, opts?: RequestOptions): Promise<ConversionResult> {
    return this.transport.run(EventsAndConversionsApi, "recordConversion", opts, (api) => api.recordConversionRaw({ recordConversionRequest: body }));
  }
}

class Journeys {
  constructor(private readonly transport: Transport) {}

  /** Enters a user or a device into a journey that an API call starts. */
  enter(publicId: string, body: EnterJourneyRequest, opts?: RequestOptions): Promise<EnterJourneyResult> {
    return this.transport.run(JourneysApi, "enterJourney", opts, (api) => api.enterJourneyRaw({ publicId: assertPathId("publicId", publicId), enterJourneyRequest: body }));
  }
}

class Preferences {
  constructor(private readonly transport: Transport) {}

  /** Sets a user's opt-outs by notification category. */
  set(body: SetPreferencesRequest, opts?: RequestOptions): Promise<SetPreferencesResult> {
    return this.transport.run(PreferencesApi, "setPreferences", opts, (api) => api.setPreferencesRaw({ setPreferencesRequest: body }));
  }

  /** Reads a user's opt-outs. */
  query(body: QueryPreferencesRequest, opts?: RequestOptions): Promise<Preference[]> {
    return this.transport.run(PreferencesApi, "queryPreferences", opts, (api) => api.queryPreferencesRaw({ queryPreferencesRequest: body }));
  }
}

class Categories {
  constructor(private readonly transport: Transport) {}

  /** Lists the notification categories of the project. */
  list(opts?: RequestOptions): Promise<Category[]> {
    return this.transport.run(PreferencesApi, "listCategories", opts, (api) => api.listCategoriesRaw());
  }
}

class Variables {
  constructor(private readonly transport: Transport) {}

  /** Lists the variables a title or body can use. */
  list(opts?: RequestOptions): Promise<Variable[]> {
    return this.transport.run(PreferencesApi, "listVariables", opts, (api) => api.listVariablesRaw());
  }
}

/**
 * The client for the server operations of the Espresso Notify `/v1` API.
 *
 * ```ts
 * const client = new EspressoNotify({ apiKey: process.env.ESPRESSO_NOTIFY_SECRET_KEY! });
 * await client.notifications.transactional({ to: { external_id: "user-1001" }, title: "Hi", body: "Order shipped" });
 * ```
 */
export class EspressoNotify {
  readonly notifications: Notifications;
  readonly users: Users;
  readonly tokens: Tokens;
  readonly conversions: Conversions;
  readonly journeys: Journeys;
  readonly preferences: Preferences;
  readonly categories: Categories;
  readonly variables: Variables;

  constructor(options: EspressoNotifyOptions) {
    assertServerRuntime();
    const apiKey = assertSecretKey(options?.apiKey);
    const basePath = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    const defaults = {
      timeoutMs: assertTimeoutMs("timeoutMs", options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs),
      maxRetries: assertMaxRetries("maxRetries", options.maxRetries === undefined ? DEFAULT_MAX_RETRIES : options.maxRetries),
      deadlineMs: assertTimeoutMs("deadlineMs", options.deadlineMs === undefined ? DEFAULT_DEADLINE_MS : options.deadlineMs),
    };

    if (options.fetch !== undefined && typeof options.fetch !== "function") {
      throw new EspressoNotifyConfigError("invalid_option", "fetch must be a function with the signature of the global fetch.");
    }
    const sender = options.fetch;

    const transport: Transport = {
      run: (Api, operation, callOptions, call) =>
        json(() => {
          const checked = checkedCallOptions(callOptions);
          const settings = { ...defaults, ...checked };
          // An operation that is not safe to repeat gets one attempt, whatever the client's maxRetries; a call that sets its own does as it says.
          if (!RETRY_POLICY[operation].retry && checked.maxRetries === undefined) settings.maxRetries = 0;
          const configuration = new Configuration({ basePath, accessToken: apiKey, fetchApi: createFetchApi(sender ? { ...settings, fetch: sender } : settings) });
          return call(new Api(configuration));
        }),
    };
    this.notifications = new Notifications(transport);
    this.users = new Users(transport);
    this.tokens = new Tokens(transport);
    this.conversions = new Conversions(transport);
    this.journeys = new Journeys(transport);
    this.preferences = new Preferences(transport);
    this.categories = new Categories(transport);
    this.variables = new Variables(transport);
  }
}

/** The options of one call that are set, each one checked like the option of the client of the same name. */
function checkedCallOptions(options: RequestOptions | undefined): RequestOptions {
  const out: RequestOptions = {};
  if (options?.signal !== undefined) out.signal = options.signal;
  if (options?.timeoutMs !== undefined) out.timeoutMs = assertTimeoutMs("timeoutMs", options.timeoutMs);
  if (options?.maxRetries !== undefined) out.maxRetries = assertMaxRetries("maxRetries", options.maxRetries);
  if (options?.deadlineMs !== undefined) out.deadlineMs = assertTimeoutMs("deadlineMs", options.deadlineMs);
  return out;
}
