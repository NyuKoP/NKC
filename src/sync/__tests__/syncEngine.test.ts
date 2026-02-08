import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testApplyEnvelopeEvents,
  __testResetSyncState,
  __testSetPeerContext,
  handleIncomingFriendFrame,
} from "../syncEngine";
import { encodeBase64Url } from "../../security/base64url";
import type { Conversation, UserProfile } from "../../db/repo";

const mocks = vi.hoisted(() => ({
  verifyEnvelopeSignatureMock: vi.fn(async () => false),
  computeEnvelopeHashMock: vi.fn(async () => "event-hash"),
  decryptEnvelopeMock: vi.fn(async () => ({ type: "msg", text: "hi" })),
}));

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
  const profiles: UserProfile[] = [
    {
      id: "local",
      displayName: "Local",
      status: "",
      theme: "dark",
      kind: "user",
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "peer",
      friendId: "peer",
      displayName: "Peer",
      status: "",
      theme: "dark",
      kind: "friend",
      friendStatus: "blocked",
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  return {
    listConversations: vi.fn(async () => [conv]),
    listProfiles: vi.fn(async () => profiles),
    getEvent: vi.fn(async () => null),
    getLastEventHash: vi.fn(async () => "prev-hash"),
    saveMessage: vi.fn(async () => {}),
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

vi.mock("../../security/identityKeys", () => {
  return {
    getDhPrivateKey: vi.fn(async () => new Uint8Array(32).fill(2)),
    getIdentityPublicKey: vi.fn(async () => new Uint8Array(32).fill(3)),
  };
});

vi.mock("../../security/pskStore", () => {
  return {
    getFriendPsk: vi.fn(async () => null),
  };
});

vi.mock("../../crypto/box", async () => {
  const actual = await vi.importActual<typeof import("../../crypto/box")>("../../crypto/box");
  return {
    ...actual,
    verifyEnvelopeSignature: mocks.verifyEnvelopeSignatureMock,
    computeEnvelopeHash: mocks.computeEnvelopeHashMock,
    decryptEnvelope: mocks.decryptEnvelopeMock,
  };
});

describe("syncEngine signature verification", () => {
  beforeEach(() => {
    __testResetSyncState();
    vi.clearAllMocks();
  });

  it("drops events with invalid signatures", async () => {
    const identityPub = encodeBase64Url(new Uint8Array(32).fill(1));
    const dhPub = encodeBase64Url(new Uint8Array(32).fill(2));
    __testSetPeerContext("c1", { identityPub, dhPub, friendKeyId: "peer" });

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

  it("marks conflict when prev hash mismatches", async () => {
    const identityPub = encodeBase64Url(new Uint8Array(32).fill(1));
    const dhPub = encodeBase64Url(new Uint8Array(32).fill(2));
    __testSetPeerContext("c1", { identityPub, dhPub, friendKeyId: "peer" });

    const envelope = {
      header: {
        v: 1 as const,
        convId: "c1",
        eventId: "e2",
        authorDeviceId: "peer",
        ts: 2,
        lamport: 2,
        prev: "other-hash",
      },
      ciphertext: "invalid",
      nonce: "invalid",
      sig: "invalid",
    };

    mocks.verifyEnvelopeSignatureMock.mockResolvedValueOnce(true);

    await __testApplyEnvelopeEvents("c1", [
      {
        eventId: "e2",
        convId: "c1",
        authorDeviceId: "peer",
        lamport: 2,
        ts: 2,
        envelopeJson: JSON.stringify(envelope),
      },
    ]);

    const repo = await vi.importMock<typeof import("../../db/repo")>("../../db/repo");
    expect(vi.mocked(repo.saveEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ conflict: true })
    );
  });

  it("drops untrusted friend frames without valid signature", async () => {
    await handleIncomingFriendFrame({
      type: "friend_accept",
      convId: "c1",
      from: {
        identityPub: encodeBase64Url(new Uint8Array(32).fill(1)),
        dhPub: encodeBase64Url(new Uint8Array(32).fill(2)),
      },
      ts: Date.now(),
    });

    const repo = await vi.importMock<typeof import("../../db/repo")>("../../db/repo");
    expect(vi.mocked(repo.saveProfile)).not.toHaveBeenCalled();
    expect(vi.mocked(repo.saveConversation)).not.toHaveBeenCalled();
  });

  it("keeps blocked status on incoming friend request", async () => {
    const identityPub = encodeBase64Url(new Uint8Array(32).fill(1));
    const dhPub = encodeBase64Url(new Uint8Array(32).fill(2));
    const repo = await vi.importMock<typeof import("../../db/repo")>("../../db/repo");
    vi.mocked(repo.listProfiles).mockResolvedValue([
      {
        id: "local",
        displayName: "Local",
        status: "",
        theme: "dark",
        kind: "user",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "peer",
        friendId: "peer",
        displayName: "Peer",
        status: "",
        theme: "dark",
        kind: "friend",
        friendStatus: "blocked",
        identityPub,
        dhPub,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    await handleIncomingFriendFrame(
      {
        type: "friend_req",
        convId: "c1",
        from: {
          identityPub,
          dhPub,
          deviceId: "peer-device",
        },
        profile: {
          displayName: "Peer",
        },
        ts: Date.now(),
      },
      { trustedEnvelope: true }
    );

    expect(vi.mocked(repo.saveProfile)).toHaveBeenCalledWith(
      expect.objectContaining({ friendStatus: "blocked" })
    );
    expect(vi.mocked(repo.saveConversation)).toHaveBeenCalledWith(
      expect.objectContaining({ hidden: true, pendingAcceptance: false })
    );
  });
});
