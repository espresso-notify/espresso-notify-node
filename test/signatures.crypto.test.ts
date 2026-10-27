import { describe, expect, it, vi } from "vitest";

// The comparison of an HMAC goes through crypto.timingSafeEqual (SRVL-07 AC5): the module is wrapped so the call is seen.
const calls: Array<[number, number]> = [];
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return {
    ...real,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      calls.push([a.byteLength, b.byteLength]);
      return real.timingSafeEqual(a, b);
    },
  };
});

import { verifySignature } from "../src";
import { signatureCases } from "./support/fixtures";

describe("constant-time comparison", () => {
  const run = (name: string) => {
    const c = signatureCases().find((x) => x.name === name)!;
    calls.length = 0;
    expect(verifySignature({ body: c.input.body, headers: c.input.headers, secret: c.input.secrets, now: () => c.input.now * 1000 })).toEqual(c.expected.payload);
  };

  // two sets (current and previous secret) are sent and one secret is held: both sets are compared, whichever matches
  it.each(["hmac_rotation_current_secret", "hmac_rotation_previous_secret"])("compares the 32-byte digests with timingSafeEqual and keeps comparing after a match (%s)", (name) => {
    run(name);
    expect(calls).toEqual([
      [32, 32],
      [32, 32],
    ]);
  });
});
