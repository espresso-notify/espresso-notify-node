import type * as G from "./generated/models/index";

/**
 * What a model looks like once it has been through `JSON.parse`: a date is the string the API wrote, not a `Date`.
 * The library returns the JSON of the API unchanged, so its result types are these.
 */
export type Wire<T> = T extends Date
  ? string
  : T extends ReadonlyArray<infer U>
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

// What a call takes. Dates are sent as ISO 8601 strings.
export type {
  AddTokenRequest,
  BroadcastRequest,
  CreateUserRequest,
  EnterJourneyRequest,
  PersonalizedRequest,
  QueryPreferencesRequest,
  RecordConversionRequest,
  SendFields,
  SetPreferencesRequest,
  SetPreferencesRequestPreferencesInner as PreferenceChange,
  TransactionalBatchRequest,
  TransactionalRequest,
  TransactionalRequestAllOfTo as TransactionalRecipient,
} from "./generated/models/index";

// What a call answers. A send answers 202 when it is accepted and 200 when `dry_run` is true.
export type BroadcastResult = Wire<G.SendBroadcast202Response> | Wire<G.DryRunAnswer>;
export type PersonalizedResult = Wire<G.SendPersonalized202Response> | Wire<G.DryRunPersonalizedAnswer>;
export type TransactionalResult = Wire<G.SendTransactional202Response> | Wire<G.DryRunAnswer>;
export type TransactionalBatchResult = Wire<G.TransactionalBatchAnswer> | Wire<G.TransactionalBatchDryRunAnswer>;
export type NotificationStatus = Wire<G.NotificationStatus>;
export type CancelResult = Wire<G.CancelNotification200Response>;
export type CreatedUser = Wire<G.CreateUser201Response>;
export type AddedToken = Record<string, unknown>;
export type ConversionResult = Wire<G.RecordConversion201Response> | Wire<G.RecordConversion200Response>;
export type EnterJourneyResult = Wire<G.EnterJourney202Response>;
export type SetPreferencesResult = Wire<G.SetPreferences200Response>;
export type Preference = Wire<G.QueryPreferences200ResponseInner>;

/** A notification category an app registers on the device. */
export type Category = Wire<G.ListCategories200ResponseInner>;

/** A variable a title or body can use. */
export type Variable = Wire<G.ListVariables200ResponseInner>;
