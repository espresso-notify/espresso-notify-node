import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EspressoNotify, EspressoNotifyApiError } from "../src";
import type { Operation } from "../src/operations";
import { RETRY_POLICY } from "../src/retry-policy";
import { calls } from "./support/calls";
import { allFixtures, type Fixture } from "./support/fixtures";
import { startServer, type TestServer } from "./support/server";

// SRVL-05 (T26, assessment.md M3): an operation is retried only when doing it twice is the same as doing it once. The table
// below is the decision, written out; it is compared with the code, and with the API where the API's source is at hand.

const KEY = "sk_live_" + "ExampleSecretKeyForTests0123456789";
const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** The decision per operation, the evidence in the API (file:line, as of 2026-10-27) and a text that must be in that file. */
const DECIDED: Record<Operation, { retry: boolean; evidence: string; text: string }> = {
  sendBroadcast: { retry: true, evidence: "backend/internal/api/idempotency_body.go:64", text: "func answerIdempotentRepeat" },
  sendPersonalized: { retry: true, evidence: "backend/internal/api/idempotency_body.go:64", text: "func answerIdempotentRepeat" },
  sendTransactional: { retry: true, evidence: "backend/internal/api/idempotency_body.go:64", text: "func answerIdempotentRepeat" },
  sendTransactionalBatch: { retry: true, evidence: "backend/internal/service/transactional_batch.go:146", text: "TxBatchDuplicateIgnore" },
  getNotification: { retry: true, evidence: "backend/cmd/server/notification_schedule_routes.go:41", text: 'external.GET("/notifications/:id"' },
  cancelNotification: { retry: true, evidence: "backend/internal/service/notification_schedule.go:139", text: "out.AlreadyCancelled = true" },
  createUser: { retry: true, evidence: "backend/internal/api/user_controller.go:81", text: "createUserWithOptOuts(ctrl.db, &user, clause.OnConflict{" },
  addToken: { retry: true, evidence: "backend/internal/api/user_controller.go:233", text: "ctrl.db.Clauses(clause.OnConflict{" },
  recordConversion: { retry: true, evidence: "backend/internal/api/notification_controller.go:2725", text: "DoNothing: true" },
  enterJourney: { retry: false, evidence: "backend/internal/service/journey_service.go:528", text: 'default: // "always" ou vazio' },
  setPreferences: { retry: true, evidence: "backend/internal/api/preferences_upsert.go:25", text: "DoUpdates: clause.AssignmentColumns([]string{\"opted_out\"" },
  queryPreferences: { retry: true, evidence: "backend/internal/api/preferences_controller.go:208", text: "func (ctrl *PreferencesController) QueryPreferences" },
  listCategories: { retry: true, evidence: "backend/cmd/server/main.go:959", text: 'external.GET("/notifications/categories"' },
  listVariables: { retry: true, evidence: "backend/cmd/server/main.go:956", text: 'external.GET("/variables"' },
};

const fixtures = allFixtures();
const byId = (id: string): Fixture => fixtures.find((f) => f.operationId === id)!;
const retried = fixtures.filter((f) => DECIDED[f.operationId as Operation]?.retry);
const once = fixtures.filter((f) => DECIDED[f.operationId as Operation] && !DECIDED[f.operationId as Operation].retry);

describe("the retry policy per operation", () => {
  it("decides every operation of the contract, and nothing else", () => {
    expect(fixtures.map((f) => f.operationId).sort()).toEqual(Object.keys(DECIDED).sort());
    expect(Object.keys(RETRY_POLICY).sort()).toEqual(Object.keys(DECIDED).sort());
  });

  it("is the table above, with its evidence", () => {
    for (const [operation, decided] of Object.entries(DECIDED)) {
      const rule = RETRY_POLICY[operation as Operation];
      expect(rule.retry, operation).toBe(decided.retry);
      expect(rule.evidence, operation).toBe(decided.evidence);
      expect(rule.why.length, operation).toBeGreaterThan(5);
    }
    expect(Object.entries(DECIDED).filter(([, d]) => !d.retry).map(([o]) => o)).toEqual(["enterJourney"]);
  });

  // In the monorepo the evidence is checked against the source of the API; in the public mirror there is no backend/ and this is skipped.
  const root = join(new URL("../../..", import.meta.url).pathname);
  const hasBackend = existsSync(join(root, "backend", "internal", "api", "user_controller.go"));
  it.skipIf(!hasBackend)("cites files of the API that exist, are long enough and say what the table says", () => {
    for (const [operation, decided] of Object.entries(DECIDED)) {
      const [file, line] = decided.evidence.split(":") as [string, string];
      const text = readFileSync(join(root, file), "utf8");
      expect(text.split("\n").length, `${operation} ${decided.evidence}`).toBeGreaterThanOrEqual(Number(line));
      expect(text, `${operation} ${decided.evidence}`).toContain(decided.text);
    }
  });
});

describe("what the policy does to a call", () => {
  async function serveFailingOnce(f: Fixture, failure: { status: number; headers?: Record<string, string> } | "drop") {
    const server = await startServer((_r, n) => (n === 1 ? (failure === "drop" ? { status: 200, drop: true } : { ...failure, body: { error: "later" } }) : { status: f.response.status, headers: f.response.headers, body: f.response.body }));
    servers.push(server);
    return server;
  }

  for (const f of retried) {
    it(`${f.operationId}: a 503 is retried`, async () => {
      const server = await serveFailingOnce(f, { status: 503, headers: { "Retry-After": "0" } });
      const client = new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl });
      await expect(calls[f.operationId]!(client, f)).resolves.toBeDefined();
      expect(server.requests).toHaveLength(2);
    });
  }

  for (const f of once) {
    for (const [label, failure] of [
      ["a 503", { status: 503, headers: { "Retry-After": "0" } }],
      ["a 429", { status: 429, headers: { "Retry-After": "0" } }],
      ["a dropped connection", "drop"],
    ] as const) {
      it(`${f.operationId}: ${label} gets exactly one attempt, and the failure reaches the caller`, async () => {
        const server = await serveFailingOnce(f, failure);
        const client = new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl, maxRetries: 5 });
        const error = (await calls[f.operationId]!(client, f).then(() => undefined, (e: unknown) => e)) as EspressoNotifyApiError;
        expect(error).toBeInstanceOf(EspressoNotifyApiError);
        expect(error.status).toBe(failure === "drop" ? 0 : failure.status);
        expect(server.requests).toHaveLength(1);
      });
    }

    it(`${f.operationId}: a call that sets maxRetries itself is retried as it says`, async () => {
      const server = await serveFailingOnce(f, { status: 503, headers: { "Retry-After": "0" } });
      const client = new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl });
      await expect(calls[f.operationId]!(client, f, { maxRetries: 2 })).resolves.toBeDefined();
      expect(server.requests).toHaveLength(2);
    });

    it(`${f.operationId}: a call that sets maxRetries to 0 makes one attempt too`, async () => {
      const server = await serveFailingOnce(f, { status: 503 });
      const client = new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl });
      await expect(calls[f.operationId]!(client, f, { maxRetries: 0 })).rejects.toMatchObject({ status: 503 });
      expect(server.requests).toHaveLength(1);
    });
  }

  it("a send still keeps its idempotency key across the retries it makes", async () => {
    const f = byId("sendTransactional");
    const server = await serveFailingOnce(f, { status: 503, headers: { "Retry-After": "0" } });
    await calls.sendTransactional!(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }), { ...f, request: { ...f.request, body: { ...f.request.body, idempotency_key: undefined } } });
    const keys = server.requests.map((r) => JSON.parse(r.body).idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
  });
});
