/** The operations of the server API, by the operationId of the contract (`sdk-server/operations.txt`). */
export type Operation =
  | "sendBroadcast"
  | "sendPersonalized"
  | "sendTransactional"
  | "sendTransactionalBatch"
  | "getNotification"
  | "cancelNotification"
  | "createUser"
  | "addToken"
  | "recordConversion"
  | "enterJourney"
  | "setPreferences"
  | "queryPreferences"
  | "listCategories"
  | "listVariables";
