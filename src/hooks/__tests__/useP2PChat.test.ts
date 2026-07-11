import { describe, expect, it } from "vitest";
import {
  applyP2PChatEvent,
  toChatMessage,
  upsertChatMessage,
  type ChatMessage,
} from "../useP2PChat";

const baseMessage = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  convId: "c1",
  senderId: "u1",
  text: "hello",
  ts: 10,
  createdAt: 10,
  kind: "text",
  status: "PENDING",
  ...patch,
});

describe("useP2PChat helpers", () => {
  it("normalizes repo messages for groupMessages", () => {
    expect(
      toChatMessage({
        id: "m1",
        convId: "c1",
        senderId: "u1",
        text: "hello",
        ts: 10,
      })
    ).toMatchObject({
      id: "m1",
      convId: "c1",
      createdAt: 10,
      kind: "text",
      status: "SENT",
    });
  });

  it("upserts messages and keeps timeline order stable", () => {
    const current = [baseMessage({ id: "late", createdAt: 20, ts: 20 })];
    const inserted = upsertChatMessage(current, baseMessage({ id: "early", createdAt: 5, ts: 5 }));
    const updated = upsertChatMessage(inserted, baseMessage({ id: "late", status: "SENT" }));

    expect(inserted.map((message) => message.id)).toEqual(["early", "late"]);
    expect(updated.find((message) => message.id === "late")?.status).toBe("SENT");
  });

  it("applies ACK and failure events without duplicating messages", () => {
    const pending = [baseMessage()];
    const acked = applyP2PChatEvent(pending, {
      type: "MESSAGE_ACK",
      message: baseMessage({ status: "PENDING" }),
    });
    const failed = applyP2PChatEvent(acked, {
      type: "MESSAGE_FAILED",
      messageId: "m1",
      error: "send_failed",
    });

    expect(acked).toHaveLength(1);
    expect(acked[0].status).toBe("SENT");
    expect(failed[0].status).toBe("FAILED");
  });
});
