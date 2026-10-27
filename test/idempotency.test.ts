import { afterEach, describe, expect, it } from "vitest";
import { EspressoNotify } from "../src";
import { withIdempotencyKey, withIdempotencyKeys } from "../src/idempotency";
import { calls } from "./support/calls";
import { allFixtures, fixture, type Fixture } from "./support/fixtures";
import { startServer, type Answer, type Recorded, type TestServer } from "./support/server";

const KEY = "sk_live_" + "ExampleSecretKeyForTests0123456789";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SENDS = ["sendBroadcast", "sendPersonalized", "sendTransactional"] as const;

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(answer: (r: Recorded, attempt: number) => Answer): Promise<TestServer> {
  const s = await startServer(answer);
  servers.push(s);
  return s;
}

/** The fixture with its idempotency_key taken out, so the library has to make one. */
function withoutKey(f: Fixture): Fixture {
  const { idempotency_key: _dropped, ...rest } = f.request.body;
  return { ...f, request: { ...f.request, body: rest } };
}

const answerOf = (f: Fixture): Answer => ({ status: f.response.status, headers: f.response.headers, body: f.response.body });
const sentKeys = (s: TestServer) => s.requests.map((r) => JSON.parse(r.body).idempotency_key as string);

describe("a send without idempotency_key gets one and keeps it across retries (SRVL-06 AC5)", () => {
  for (const id of SENDS) {
    it(`${id}: 503, 503, then accepted sends three requests with the same UUID v4`, async () => {
      const f = fixture(id);
      const server = await serve((_r, n) => (n < 3 ? { status: 503, headers: { "Retry-After": "0" } } : answerOf(f)));
      const client = new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl });

      const result = await calls[id]!(client, withoutKey(f));

      expect(result).toEqual(f.response.body);
      const keys = sentKeys(server);
      expect(keys).toHaveLength(3);
      expect(keys[0]).toMatch(UUID_V4);
      expect(new Set(keys).size).toBe(1);
      // nothing else in the body changed
      const { idempotency_key: _k, ...firstBody } = JSON.parse(server.requests[0]!.body);
      const { idempotency_key: _f, ...fixtureBody } = f.request.body;
      expect(firstBody).toEqual(fixtureBody);
    });
  }

  it("makes a new key for every call", async () => {
    const f = fixture("sendTransactional");
    const server = await serve(() => answerOf(f));
    const client = new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl });
    await calls.sendTransactional!(client, withoutKey(f));
    await calls.sendTransactional!(client, withoutKey(f));
    const keys = sentKeys(server);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("does not change the object the caller passed", async () => {
    const f = withoutKey(fixture("sendTransactional"));
    const before = JSON.stringify(f.request.body);
    const server = await serve(() => answerOf(fixture("sendTransactional")));
    await calls.sendTransactional!(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }), f);
    expect(JSON.stringify(f.request.body)).toBe(before);
    expect(f.request.body.idempotency_key).toBeUndefined();
  });
});

describe("a key the caller chose is sent unchanged on every attempt (SRVL-06 AC6)", () => {
  for (const id of SENDS) {
    it(`${id}: the fixture's key on all three attempts`, async () => {
      const f = fixture(id);
      const server = await serve((_r, n) => (n < 3 ? { status: 503, headers: { "Retry-After": "0" } } : answerOf(f)));
      await calls[id]!(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }), f);
      expect(sentKeys(server)).toEqual([f.request.body.idempotency_key, f.request.body.idempotency_key, f.request.body.idempotency_key]);
    });
  }
});

describe("a batch: the key is per item (SRVL-06 AC5, AC6)", () => {
  it("gives a key to each item without one, keeps the keys the caller chose, and repeats all of them on a retry", async () => {
    const f = fixture("sendTransactionalBatch");
    const items = f.request.body.items as Array<Record<string, unknown>>;
    const body = { items: items.map((item, i) => (i === 0 ? item : (({ idempotency_key: _k, ...rest }) => rest)(item))) };
    const server = await serve((_r, n) => (n === 1 ? { status: 503, headers: { "Retry-After": "0" } } : answerOf(f)));

    await new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }).notifications.transactionalBatch(body as never);

    expect(server.requests).toHaveLength(2);
    const [first, second] = server.requests.map((r) => JSON.parse(r.body).items as Array<{ idempotency_key: string }>);
    expect(first![0]!.idempotency_key).toBe(items[0]!.idempotency_key);
    for (const item of first!.slice(1)) expect(item.idempotency_key).toMatch(UUID_V4);
    expect(new Set(first!.map((i) => i.idempotency_key)).size).toBe(first!.length);
    expect(second).toEqual(first);
  });

  it("leaves an item otherwise as it is and does not change the caller's items", () => {
    // The item is the first one of the backend's fixture, without its key (SRVL-08 AC2: no hand-written request of a covered operation).
    const [{ idempotency_key: _own, ...item }] = fixture("sendTransactionalBatch").request.body.items as Array<Record<string, unknown> & { idempotency_key?: string }>;
    const body = { items: [item as { idempotency_key?: string }] };
    const out = withIdempotencyKeys(body);
    expect(out.items[0]).toMatchObject(item);
    expect(out.items[0]!.idempotency_key).toMatch(UUID_V4);
    expect(body.items[0]!.idempotency_key).toBeUndefined();
    expect(withIdempotencyKey({ idempotency_key: "mine" }).idempotency_key).toBe("mine");
  });
});

describe("only the sends get a key (SRVL-06 AC5)", () => {
  const others = allFixtures().filter((f) => !["sendBroadcast", "sendPersonalized", "sendTransactional", "sendTransactionalBatch"].includes(f.operationId));

  it("has the ten other operations to check", () => {
    expect(others).toHaveLength(10);
  });

  for (const f of others) {
    it(`${f.operationId} sends no idempotency_key`, async () => {
      const server = await serve(() => answerOf(f));
      await calls[f.operationId]!(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }), f);
      expect(server.requests[0]!.body).not.toContain("idempotency_key");
    });
  }
});
