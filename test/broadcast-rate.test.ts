import { describe, expect, it } from "vitest";
import { BroadcastRequestFromJSON, BroadcastRequestToJSON } from "../src/generated/models/BroadcastRequest";

// plans-team T56 (PLAN-23): the broadcast takes send_rate_per_minute, 100 to 100000 messages a minute. The range and the plan are the server's to
// judge (402 plan_feature_required, 422 invalid_send_rate); the library carries the number as it is, both ways.
describe("BroadcastRequest send_rate_per_minute", () => {
  it("is written to the body", () => {
    const body = BroadcastRequestToJSON({ title: "t", body: "b", send_rate_per_minute: 1000 });
    expect(body.send_rate_per_minute).toBe(1000);
  });

  it("is read back from a JSON body", () => {
    const request = BroadcastRequestFromJSON({ title: "t", body: "b", send_rate_per_minute: 250 });
    expect(request.send_rate_per_minute).toBe(250);
  });

  it("survives a round trip through JSON", () => {
    const sent = { title: "t", body: "b", send_rate_per_minute: 100000 };
    const wire = JSON.parse(JSON.stringify(BroadcastRequestToJSON(sent)));
    expect(BroadcastRequestFromJSON(wire).send_rate_per_minute).toBe(100000);
  });

  it("is absent from the body when the campaign has no rate", () => {
    const wire = JSON.parse(JSON.stringify(BroadcastRequestToJSON({ title: "t", body: "b" })));
    expect("send_rate_per_minute" in wire).toBe(false);
    expect(BroadcastRequestFromJSON(wire).send_rate_per_minute).toBeUndefined();
  });
});

// feature: server.notifications-send
