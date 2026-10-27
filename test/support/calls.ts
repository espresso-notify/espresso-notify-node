import type { EspressoNotify, RequestOptions } from "../../src";
import type { Fixture } from "./fixtures";

/** The path of the facade method that runs each operation, from the client: `client.notifications.broadcast` is "notifications.broadcast". */
export const methodOf: Record<string, string> = {
  sendBroadcast: "notifications.broadcast",
  sendPersonalized: "notifications.personalized",
  sendTransactional: "notifications.transactional",
  sendTransactionalBatch: "notifications.transactionalBatch",
  getNotification: "notifications.get",
  cancelNotification: "notifications.cancel",
  createUser: "users.create",
  addToken: "tokens.add",
  recordConversion: "conversions.record",
  enterJourney: "journeys.enter",
  setPreferences: "preferences.set",
  queryPreferences: "preferences.query",
  listCategories: "categories.list",
  listVariables: "variables.list",
};

/**
 * How each of the 14 operations is called on the client, from the request of its fixture. The key of this table is the
 * operationId of the contract; the guard test of the contract sweep compares it with sdk-server/operations.txt.
 */
export const calls: Record<string, (client: EspressoNotify, f: Fixture, opts?: RequestOptions) => Promise<unknown>> = {
  sendBroadcast: (c, f, o) => c.notifications.broadcast(f.request.body, o),
  sendPersonalized: (c, f, o) => c.notifications.personalized(f.request.body, o),
  sendTransactional: (c, f, o) => c.notifications.transactional(f.request.body, o),
  sendTransactionalBatch: (c, f, o) => c.notifications.transactionalBatch(f.request.body, o),
  getNotification: (c, f, o) => c.notifications.get(f.pathParams!.id!, o),
  cancelNotification: (c, f, o) => c.notifications.cancel(f.pathParams!.id!, o),
  createUser: (c, f, o) => c.users.create(f.request.body, o),
  addToken: (c, f, o) => c.tokens.add(f.request.body, o),
  recordConversion: (c, f, o) => c.conversions.record(f.request.body, o),
  enterJourney: (c, f, o) => c.journeys.enter(f.pathParams!.public_id!, f.request.body, o),
  setPreferences: (c, f, o) => c.preferences.set(f.request.body, o),
  queryPreferences: (c, f, o) => c.preferences.query(f.request.body, o),
  listCategories: (c, _f, o) => c.categories.list(o),
  listVariables: (c, _f, o) => c.variables.list(o),
};
