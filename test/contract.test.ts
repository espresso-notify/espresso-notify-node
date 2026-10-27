import { afterEach, describe, expect, it } from "vitest";
import { EspressoNotify, EspressoNotifyApiError } from "../src";
import { calls, methodOf } from "./support/calls";
import { allErrorFixtures, allFixtures, includeList } from "./support/fixtures";
import { startServer, type TestServer } from "./support/server";

const KEY = "sk_live_" + "ExampleSecretKeyForTests0123456789";

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const resolve = (client: object, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], client);

// SRVL-08 AC1, AC2: every operation of the contract is driven against a server that answers what the backend answered,
// and the request is what the backend accepted. No request or answer is written in this file: all of it is in the fixtures.
describe("the contract sweep: one test per fixture", () => {
  for (const f of allFixtures()) {
    it(`${f.operationId}: sends ${f.method} ${f.path} and returns the answer of the backend`, async () => {
      const server = await startServer(() => ({ status: f.response.status, headers: f.response.headers, body: f.response.body }));
      servers.push(server);
      const client = new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl });

      const result = await calls[f.operationId]!(client, f);

      expect(result).toEqual(f.response.body);
      expect(server.requests).toHaveLength(1);
      const sent = server.requests[0]!;
      expect([sent.method, sent.url]).toEqual([f.method, f.path]);
      expect(sent.body === "" ? undefined : JSON.parse(sent.body)).toEqual(f.request.body);
      expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
    });
  }

  it("has every fixture made with the secret key, the only key the library accepts", () => {
    expect(allFixtures().filter((f) => f.key !== "secret").map((f) => f.operationId)).toEqual([]);
  });

  it("turns every error fixture of the backend into an EspressoNotifyApiError with its status", async () => {
    for (const f of allErrorFixtures().filter((x) => x.response.status !== 429 && x.response.status !== 503)) {
      const server = await startServer(() => ({ status: f.response.status, headers: f.response.headers, body: f.response.body }));
      servers.push(server);
      const run = calls[f.operationId]!(new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl }), f);
      await expect(run).rejects.toBeInstanceOf(EspressoNotifyApiError);
      await expect(run).rejects.toMatchObject({ status: f.response.status });
    }
  });
});

// SRVL-01 AC4: an operation added to or removed from the include list without a matching facade method fails here, by name.
describe("the include list and the facade agree", () => {
  const client = new EspressoNotify({ apiKey: KEY });
  const listed = includeList();

  it("lists 14 operations", () => {
    expect(listed).toHaveLength(14);
  });

  for (const operationId of listed) {
    it(`${operationId} has a facade method, a table entry and a fixture`, () => {
      expect(methodOf[operationId], `${operationId} is in sdk-server/operations.txt but test/support/calls.ts has no method for it`).toBeDefined();
      expect(typeof resolve(client, methodOf[operationId]!), `${operationId}: client.${methodOf[operationId]} is not a method of the client`).toBe("function");
      expect(calls[operationId], `${operationId} has no call in test/support/calls.ts`).toBeDefined();
      expect(allFixtures().map((f) => f.operationId), `${operationId} has no fixture`).toContain(operationId);
    });
  }

  it("has no facade method, table entry or fixture for an operation that is not in the list", () => {
    expect(Object.keys(methodOf).sort()).toEqual([...listed].sort());
    expect(Object.keys(calls).sort()).toEqual([...listed].sort());
    expect(allFixtures().map((f) => f.operationId).sort()).toEqual([...listed].sort());
  });

  it("has no public method on a group that the list does not account for", () => {
    const facade = Object.entries(client)
      .filter(([, group]) => typeof group === "object" && group !== null)
      .flatMap(([name, group]) => Object.getOwnPropertyNames(Object.getPrototypeOf(group)).filter((m) => m !== "constructor").map((m) => `${name}.${m}`));
    expect(facade.sort()).toEqual(listed.map((id) => methodOf[id]!).sort());
  });
});
