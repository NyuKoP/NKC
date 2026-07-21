import { describe, expect, it } from "vitest";
import { resolveMessageDeliveryStatus } from "./messageDeliveryStatus";

describe("resolveMessageDeliveryStatus", () => {
  it("maps the outgoing lifecycle from queued to read", () => {
    expect(resolveMessageDeliveryStatus({ delivered: false, read: false, readReceiptsEnabled: true })).toBe("queued");
    expect(resolveMessageDeliveryStatus({ delivered: false, read: false, readReceiptsEnabled: true, outboxStatus: "pending" })).toBe("sent");
    expect(resolveMessageDeliveryStatus({ delivered: false, read: false, readReceiptsEnabled: true, outboxStatus: "in_flight" })).toBe("sent");
    expect(resolveMessageDeliveryStatus({ delivered: true, read: false, readReceiptsEnabled: true, outboxStatus: "acked" })).toBe("delivered");
    expect(resolveMessageDeliveryStatus({ delivered: true, read: true, readReceiptsEnabled: true, outboxStatus: "acked" })).toBe("read");
  });

  it("does not expose read state when read receipts are disabled", () => {
    expect(resolveMessageDeliveryStatus({ delivered: true, read: true, readReceiptsEnabled: false, outboxStatus: "acked" })).toBe("delivered");
  });
});
