import type { Operation } from "./operations";

/** Whether the library retries an operation, and what backs the decision in the API. */
export interface RetryRule {
  /** True when a second identical request cannot do the work twice, so a lost answer may be retried. */
  retry: boolean;
  /** Why, in one line. */
  why: string;
  /** Where in the repository of the API this is true (file:line, as of 2026-10-27). */
  evidence: string;
}

/**
 * A retry sends the same request again, and the first one may have been done even when its answer was lost. So an operation is
 * retried only when doing it twice is the same as doing it once. An operation that is not gets one attempt (its `maxRetries`
 * is 0) unless the call itself passes `maxRetries`, which says the caller has its own protection against a repeat.
 */
export const RETRY_POLICY: Readonly<Record<Operation, RetryRule>> = {
  sendBroadcast: { retry: true, why: "the idempotency_key (made once per call) collapses a repeat into duplicate_ignored", evidence: "backend/internal/api/idempotency_body.go:64" },
  sendPersonalized: { retry: true, why: "the idempotency_key (made once per call) collapses a repeat into duplicate_ignored", evidence: "backend/internal/api/idempotency_body.go:64" },
  sendTransactional: { retry: true, why: "the idempotency_key (made once per call) collapses a repeat into duplicate_ignored", evidence: "backend/internal/api/idempotency_body.go:64" },
  sendTransactionalBatch: { retry: true, why: "every item has its own idempotency_key and a repeated one is answered duplicate_ignored", evidence: "backend/internal/service/transactional_batch.go:146" },
  getNotification: { retry: true, why: "a read", evidence: "backend/cmd/server/notification_schedule_routes.go:41" },
  cancelNotification: { retry: true, why: "cancelling a cancelled send answers 200 with already_cancelled", evidence: "backend/internal/service/notification_schedule.go:139" },
  createUser: { retry: true, why: "an upsert on (project_id, external_id)", evidence: "backend/internal/api/user_controller.go:81" },
  addToken: { retry: true, why: "an upsert on (tenant_id, token), guarded to the project", evidence: "backend/internal/api/user_controller.go:233" },
  recordConversion: { retry: true, why: "a repeated external_txn_id is ignored (200 duplicate) by a unique index", evidence: "backend/internal/api/notification_controller.go:2725" },
  enterJourney: {
    retry: false,
    why: "the re-entry rule of the journey decides, and its default (always) starts a second run, which sends the journey twice",
    evidence: "backend/internal/service/journey_service.go:528",
  },
  setPreferences: { retry: true, why: "sets the values it is given (an upsert), so a repeat writes the same", evidence: "backend/internal/api/preferences_upsert.go:25" },
  queryPreferences: { retry: true, why: "a read", evidence: "backend/internal/api/preferences_controller.go:208" },
  listCategories: { retry: true, why: "a read", evidence: "backend/cmd/server/main.go:959" },
  listVariables: { retry: true, why: "a read", evidence: "backend/cmd/server/main.go:956" },
};
