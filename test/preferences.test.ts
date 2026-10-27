import { afterEach, describe, expect, it } from "vitest";
import { EspressoNotify, type Preference, type SetPreferencesRequest, type QueryPreferencesRequest } from "../src";
import { fixture } from "./support/fixtures";
import { startServer, type TestServer } from "./support/server";

// SRVL-02 (T27, owner decision 2026-10-27): with the secret key a user is named by external_id alone, so preferences.set and
// preferences.query take a body without push_token; the preferences then apply to the user, that is to every device.

const KEY = "sk_live_" + "ExampleSecretKeyForTests0123456789";
const set = fixture("setPreferences");
const query = fixture("queryPreferences");
const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("preferences by user", () => {
  it("the fixtures of the backend name the user by external_id alone, and the backend accepted them", () => {
    expect(set.request.body).not.toHaveProperty("push_token");
    expect(query.request.body).not.toHaveProperty("push_token");
    expect(set.response.status).toBe(200);
    expect(query.response.status).toBe(200);
  });

  it("types and sends a body with external_id alone, and one with a push_token", async () => {
    const server = await startServer((r) => (r.url.endsWith("/query") ? { status: 200, body: query.response.body } : { status: 200, body: set.response.body }));
    servers.push(server);
    const client = new EspressoNotify({ apiKey: KEY, baseUrl: server.baseUrl });

    // The values come from the fixtures of the backend; the object literals are there to be type-checked without a push_token.
    const externalId: string = set.request.body.external_id;
    const aloneSet: SetPreferencesRequest = { external_id: externalId, preferences: set.request.body.preferences };
    const aloneQuery: QueryPreferencesRequest = { external_id: query.request.body.external_id };
    const withDevice: SetPreferencesRequest = { ...aloneSet, push_token: "ExponentPushToken[abc]" };

    await expect(client.preferences.set(aloneSet)).resolves.toEqual({ updated: 1 });
    const read: Preference[] = await client.preferences.query(aloneQuery);
    expect(read).toEqual([{ category_identifier: "offer_actions", opted_out: true }]);
    await client.preferences.set(withDevice);
    await client.preferences.query({ ...aloneQuery, push_token: "ExponentPushToken[abc]" });

    const sent = server.requests.map((r) => JSON.parse(r.body));
    expect(sent[0]).toEqual(aloneSet);
    expect(sent[1]).toEqual(aloneQuery);
    expect(sent[2]).toEqual(withDevice);
    expect(sent[3]).toEqual({ external_id: externalId, push_token: "ExponentPushToken[abc]" });
    expect(Object.keys(sent[0])).not.toContain("push_token");
    expect(server.requests.map((r) => r.url)).toEqual(["/v1/preferences", "/v1/preferences/query", "/v1/preferences", "/v1/preferences/query"]);
  });

  it("still needs the external_id and the preferences (a type error, not a runtime check)", () => {
    // @ts-expect-error external_id is required
    const noUser: QueryPreferencesRequest = { push_token: "x" };
    // @ts-expect-error preferences is required
    const noPreferences: SetPreferencesRequest = { external_id: "u" };
    expect([noUser, noPreferences]).toHaveLength(2);
  });
});
