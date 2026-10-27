import { afterEach, describe, expect, it, vi } from "vitest";
import { EspressoNotify, EspressoNotifyConfigError, VERSION } from "../src";
import { calls } from "./support/calls";
import { allFixtures, type Fixture } from "./support/fixtures";
import { startServer, type TestServer } from "./support/server";

const KEY = "sk_live_" + "ExampleSecretKeyForTests0123456789";

const servers: TestServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serverAnswering(f: Fixture): Promise<TestServer> {
  const s = await startServer(() => ({ status: f.response.status, headers: f.response.headers, body: f.response.body }));
  servers.push(s);
  return s;
}

function dump(value: unknown): string {
  // every property of the error and of its causes, not only the enumerable ones
  const seen = new Set<unknown>();
  const walk = (v: unknown): unknown => {
    if (typeof v !== "object" || v === null || seen.has(v)) return v;
    seen.add(v);
    return Object.fromEntries(Object.getOwnPropertyNames(v).map((k) => [k, walk((v as Record<string, unknown>)[k])]));
  };
  return JSON.stringify(walk(value));
}

describe("the 14 operations send what their fixtures define (SRVL-02 AC1, AC2, AC3, AC4)", () => {
  const fixtures = allFixtures();

  it("has one fixture per operation of the table of calls", () => {
    expect(fixtures.map((f) => f.operationId).sort()).toEqual(Object.keys(calls).sort());
    expect(fixtures).toHaveLength(14);
  });

  for (const f of fixtures) {
    it(`${f.operationId}: ${f.method} ${f.path}`, async () => {
      const server = await serverAnswering(f);
      const client = new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl });

      await calls[f.operationId]!(client, f);

      expect(server.requests).toHaveLength(1);
      const sent = server.requests[0]!;
      expect(sent.method).toBe(f.method);
      expect(sent.url).toBe(f.path);
      if (f.request.body !== undefined) {
        expect(JSON.parse(sent.body)).toEqual(f.request.body);
        expect(sent.headers["content-type"]).toBe(f.request.headers!["Content-Type"]);
      } else {
        expect(sent.body).toBe("");
      }
      expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(sent.headers["user-agent"]).toBe(`espresso-notify-node/${VERSION} node/${process.version}`);
    });
  }

  it("sends to baseUrl and not to the default address, with or without a trailing slash", async () => {
    const f = allFixtures().find((x) => x.operationId === "listVariables")!;
    const server = await serverAnswering(f);
    await new EspressoNotify({ apiKey: KEY, baseUrl: `${server.baseUrl}/` }).variables.list();
    expect(server.requests.map((r) => r.url)).toEqual(["/v1/variables"]);
  });

  it("groups the methods as notifications, users, tokens, conversions, journeys, preferences, categories and variables", () => {
    const client = new EspressoNotify({ apiKey: KEY });
    const shape = (o: object) => Object.getOwnPropertyNames(Object.getPrototypeOf(o)).filter((n) => n !== "constructor").sort();
    expect(shape(client.notifications)).toEqual(["broadcast", "cancel", "get", "personalized", "transactional", "transactionalBatch"]);
    expect(shape(client.users)).toEqual(["create"]);
    expect(shape(client.tokens)).toEqual(["add"]);
    expect(shape(client.conversions)).toEqual(["record"]);
    expect(shape(client.journeys)).toEqual(["enter"]);
    expect(shape(client.preferences)).toEqual(["query", "set"]);
    expect(shape(client.categories)).toEqual(["list"]);
    expect(shape(client.variables)).toEqual(["list"]);
  });
});

describe("the key (SRVL-03 AC5, AC6)", () => {
  for (const [label, apiKey] of [
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["a test key", "sk_test_" + "ExampleSecretKeyForTests0123456789"],
    ["not a key", "hello"],
    ["not a string", 42],
  ] as const) {
    it(`${label} throws invalid_api_key and sends nothing`, async () => {
      const server = await startServer(() => ({ status: 200, body: {} }));
      servers.push(server);
      let thrown: unknown;
      try {
        new EspressoNotify({ apiKey: apiKey as string, baseUrl: server.baseUrl });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(EspressoNotifyConfigError);
      expect((thrown as EspressoNotifyConfigError).code).toBe("invalid_api_key");
      expect(server.requests).toHaveLength(0);
    });
  }

  it("refuses a public key with public_key_not_allowed and says it belongs in the app SDKs", () => {
    let thrown: EspressoNotifyConfigError | undefined;
    try {
      new EspressoNotify({ apiKey: "pk_live_ExamplePublicKeyForTests0123456789" });
    } catch (e) {
      thrown = e as EspressoNotifyConfigError;
    }
    expect(thrown).toBeInstanceOf(EspressoNotifyConfigError);
    expect(thrown!.code).toBe("public_key_not_allowed");
    expect(thrown!.message).toContain("app SDKs");
  });
});

describe("the browser (SRVL-03 AC8)", () => {
  it("refuses to run where window and document both exist", () => {
    Object.assign(globalThis, { window: {}, document: {} });
    let thrown: EspressoNotifyConfigError | undefined;
    try {
      new EspressoNotify({ apiKey: KEY });
    } catch (e) {
      thrown = e as EspressoNotifyConfigError;
    }
    expect(thrown).toBeInstanceOf(EspressoNotifyConfigError);
    expect(thrown!.code).toBe("browser_not_supported");
  });

  it("runs where only one of them exists (a server runtime that defines window alone)", () => {
    Object.assign(globalThis, { window: {} });
    expect(() => new EspressoNotify({ apiKey: KEY })).not.toThrow();
  });
});

describe("secrets stay out of errors and logs (SRVL-03 AC7)", () => {
  it("puts no key text in a construction error, its message or its serialization", () => {
    for (const apiKey of ["sk_test_" + "TopSecretValue987", "pk_live_TopSecretValue987"]) {
      let thrown: unknown;
      try {
        new EspressoNotify({ apiKey });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(EspressoNotifyConfigError);
      expect(dump(thrown)).not.toContain("TopSecretValue987");
      expect(String((thrown as Error).stack)).not.toContain("TopSecretValue987");
    }
  });

  it("puts no key, header or body in the error of a request that cannot connect", async () => {
    const dead = await startServer(() => ({ status: 200 }));
    await dead.close();
    const client = new EspressoNotify({ apiKey: KEY, baseUrl: dead.baseUrl });
    const f = allFixtures().find((x) => x.operationId === "sendTransactional")!;
    const error = await calls.sendTransactional!(client, f).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeDefined();
    expect(dump(error)).not.toContain(KEY);
    expect(dump(error)).not.toContain("Order 8123");
    expect(dump(error)).not.toContain("Authorization");
  });

  it("writes nothing to the console or to the output streams, on success or on failure", async () => {
    const written: string[] = [];
    for (const name of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, name).mockImplementation((...a: unknown[]) => void written.push(a.join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (written.push(String(chunk)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => (written.push(String(chunk)), true));

    const f = allFixtures().find((x) => x.operationId === "sendTransactional")!;
    const ok = await serverAnswering(f);
    await calls.sendTransactional!(new EspressoNotify({ apiKey: KEY, baseUrl: ok.baseUrl }), f);
    const dead = await startServer(() => ({ status: 200 }));
    await dead.close();
    await calls.sendTransactional!(new EspressoNotify({ apiKey: KEY, baseUrl: dead.baseUrl }), f).catch(() => undefined);

    expect(written.join("\n")).not.toContain(KEY);
    expect(written).toEqual([]);
  });
});
