import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testApplyEnvelopeEvents, __testResetSyncState, __testSetPeerContext } from "../syncEngine";
import { encodeBase64Url } from "../../security/base64url";
import type { Conversation } from "../../db/repo";

vi.mock("../../db/repo", () => {
  const conv: Conversation = {
    id: "c1",
    type: "direct",
    name: "Test",
    pinned: false,
    unread: 0,
    hidden: false,
    muted: false,
    blocked: false,
    lastTs: 0,
    lastMessage: "",
    participants: ["local", "peer"],
  };
  return {
    listConversations: vi.fn(async () => [conv]),
    getEvent: vi.fn(async () => null),
    saveEvent: vi.fn(async () => {}),
    saveConversation: vi.fn(async () => {}),
    saveProfile: vi.fn(async () => {}),
  };
});

vi.mock("../../security/deviceRole", () => {
  return {
    getOrCreateDeviceId: () => "local",
  };
});

vi.mock("../../crypto/box", async () => {
  const actual = await vi.importActual<typeof import("../../crypto/box")>("../../crypto/box");
  return {
    ...actual,
    verifyEnvelopeSignature: vi.fn(async () => false),
  };
});

describe("syncEngine signature verification", () => {
  beforeEach(() => {
    __testResetSyncState();
    vi.clearAllMocks();
  });

  it("drops events with invalid signatures", async () => {
    const identityPub = encodeBase64Url(new Uint8Array(32).fill(1));
    __testSetPeerContext("c1", { identityPub });

    const envelope = {
      header: {
        v: 1 as const,
        convId: "c1",
        eventId: "e1",
        authorDeviceId: "peer",
        ts: 1,
        lamport: 1,
      },
      ciphertext: "invalid",
      nonce: "invalid",
      sig: "invalid",
    };

    await __testApplyEnvelopeEvents("c1", [
      {
        eventId: "e1",
        convId: "c1",
        authorDeviceId: "peer",
        lamport: 1,
        ts: 1,
        envelopeJson: JSON.stringify(envelope),
      },
    ]);

    const repo = await vi.importMock<typeof import("../../db/repo")>("../../db/repo");
    expect(vi.mocked(repo.saveEvent)).not.toHaveBeenCalled();
  });
});
