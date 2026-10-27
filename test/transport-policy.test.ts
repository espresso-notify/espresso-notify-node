import { afterEach, describe, expect, it } from "vitest";
import { EspressoNotify, EspressoNotifyApiError, EspressoNotifyConfigError } from "../src";
import { calls } from "./support/calls";
import { fixture } from "./support/fixtures";
import { startServer, type TestServer } from "./support/server";

// SRVL-02 AC4 (T21, validation.md security M1): the library owns the transport policy: a redirect is never followed, and the
// key only travels over https (plain http only to a loopback host).

const KEY = "sk_live_" + "ExampleSecretKeyForTests0123456789";
const send = fixture("sendTransactional");

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("a redirect is never followed", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`${status} rejects with unexpected_redirect, makes no second request and is not retried`, async () => {
      const elsewhere = await startServer(() => ({ status: send.response.status, body: send.response.body }));
      servers.push(elsewhere);
      const api = await startServer(() => ({ status: status, headers: { Location: `${elsewhere.baseUrl}/v1/notifications/transactional`, "X-Request-Id": "req_77" } }));
      servers.push(api);

      const error = (await calls.sendTransactional!(new EspressoNotify({ apiKey: KEY, baseUrl: api.baseUrl }), send).then(
        () => undefined,
        (e: unknown) => e,
      )) as EspressoNotifyApiError;

      expect(error).toBeInstanceOf(EspressoNotifyApiError);
      expect(error.code).toBe("unexpected_redirect");
      expect(error.status).toBe(status);
      expect(error.requestId).toBe("req_77");
      expect(api.requests, "no retry").toHaveLength(1);
      expect(elsewhere.requests, "the Location was not followed").toHaveLength(0);
      expect(error.message).not.toContain(elsewhere.baseUrl);
    });
  }

  it("does not turn a redirected read into a success either", async () => {
    const api = await startServer(() => ({ status: 302, headers: { Location: "/login" }, body: "<html>login</html>" }));
    servers.push(api);
    const error = (await new EspressoNotify({ apiKey: KEY, baseUrl: api.baseUrl }).variables.list().catch((e: unknown) => e)) as EspressoNotifyApiError;
    expect(error.code).toBe("unexpected_redirect");
  });
});

describe("baseUrl", () => {
  const refused = ["http://example.com", "http://api.espressonotify.com", "http://127.0.0.1.example.com", "ftp://api.example.test", "file:///etc/passwd", "api.espressonotify.com", "not a url", "", "javascript:alert(1)"];
  for (const baseUrl of refused) {
    it(`refuses ${JSON.stringify(baseUrl)} with invalid_base_url`, () => {
      let thrown: unknown;
      try {
        new EspressoNotify({ apiKey: KEY, baseUrl });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(EspressoNotifyConfigError);
      expect((thrown as EspressoNotifyConfigError).code).toBe("invalid_base_url");
      expect(String((thrown as Error).message)).not.toContain("example.com");
    });
  }

  for (const baseUrl of ["https://api.espressonotify.com", "https://api.example.test:8443/", "http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:9000/"]) {
    it(`accepts ${baseUrl}`, () => {
      expect(() => new EspressoNotify({ apiKey: KEY, baseUrl })).not.toThrow();
    });
  }

  it("sends to a loopback http address, as every other test of the package does", async () => {
    const api = await startServer(() => ({ status: send.response.status, body: send.response.body }));
    servers.push(api);
    expect(api.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
    await calls.sendTransactional!(new EspressoNotify({ apiKey: KEY, baseUrl: api.baseUrl }), send);
    expect(api.requests).toHaveLength(1);
  });
});
