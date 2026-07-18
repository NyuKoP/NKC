import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testApplyEnvelopeEvents,
  __testCreateSyncResponseFrames,
  __testResetSyncState,
  __testSetPeerContext,
  handleIncomingFriendFrame,
} from "../syncEngine";
import { encodeBase64Url } from "../../security/base64url";
import { encodeFriendCodeV1 } from "../../security/friendCode";
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
    listEventsByConv: vi.fn(async () => []),
    saveMessage: vi.fn(async () => {}),
    saveReceivedMessageMediaChunk: vi.fn(async () => ({ received: 1, total: 1, complete: true })),
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

  it("splits large sync responses into flow-controlled chunks", () => {
    const events = Array.from({ length: 35 }, (_, idx) => ({
      eventId: `e${idx}`,
      convId: "c1",
      authorDeviceId: "peer",
      lamport: idx + 1,
      ts: idx + 1,
      envelopeJson: JSON.stringify({ idx }),
    }));

    const frames = __testCreateSyncResponseFrames({
      scope: "conv",
      convId: "c1",
      events,
      next: { peer: 35 },
      flowControl: true,
    });

    expect(frames.length).toBeGreaterThan(1);
    expect(frames[0].flow).toMatchObject({
      chunkIndex: 0,
      totalChunks: frames.length,
      final: false,
    });
    expect(frames.at(-1)?.flow).toMatchObject({
      chunkIndex: frames.length - 1,
      totalChunks: frames.length,
      final: true,
    });
    expect(frames.slice(0, -1).every((frame) => Object.keys(frame.next).length === 0)).toBe(true);
    expect(frames.at(-1)?.next).toEqual({ peer: 35 });
    expect(frames.flatMap((frame) => frame.events).map((event) => event.eventId)).toEqual(
      events.map((event) => event.eventId)
    );
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

  it("stores decrypted media chunks without adding them to the sync event log", async () => {
    const identityPub = encodeBase64Url(new Uint8Array(32).fill(1));
    const dhPub = encodeBase64Url(new Uint8Array(32).fill(2));
    __testSetPeerContext("c1", { identityPub, dhPub, friendKeyId: "peer" });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mocks.verifyEnvelopeSignatureMock.mockResolvedValueOnce(true);
    mocks.decryptEnvelopeMock.mockResolvedValueOnce(
      {
        type: "media",
        phase: "chunk",
        ownerId: "message-1",
        idx: 0,
        total: 1,
        chunkSize: 96 * 1024,
        size: bytes.length,
        mime: "application/octet-stream",
        b64: encodeBase64Url(bytes),
      } as unknown as { type: string; text: string }
    );
    const envelope = {
      header: {
        v: 1 as const,
        convId: "c1",
        eventId: "media-chunk-1",
        authorDeviceId: "peer",
        ts: 3,
        lamport: 3,
        prev: "prev-hash",
      },
      ciphertext: "invalid",
      nonce: "invalid",
      sig: "invalid",
    };

    await __testApplyEnvelopeEvents("c1", [
      {
        eventId: "media-chunk-1",
        convId: "c1",
        authorDeviceId: "peer",
        lamport: 3,
        ts: 3,
        envelopeJson: JSON.stringify(envelope),
      },
    ]);

    const repo = await vi.importMock<typeof import("../../db/repo")>("../../db/repo");
    expect(vi.mocked(repo.saveReceivedMessageMediaChunk)).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "message-1", idx: 0, bytes })
    );
    expect(vi.mocked(repo.saveEvent)).not.toHaveBeenCalled();
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

  it("drops friend frames when briar protocol verification fails", async () => {
    const identityPub = encodeBase64Url(new Uint8Array(32).fill(1));
    const dhPub = encodeBase64Url(new Uint8Array(32).fill(2));
    await handleIncomingFriendFrame(
      {
        type: "friend_req",
        convId: "c1",
        from: {
          identityPub,
          dhPub,
          deviceId: "peer-device",
        },
        ts: Date.now(),
        protocol: {
          v: 1,
          handshake: {
            v: 1,
            transcriptHash: "bad",
            proofSig: "bad",
          },
          contactExchange: {
            v: 1,
            profileHash: "bad",
            keyCommitment: "bad",
            profileSig: "bad",
          },
          keyAgreement: {
            v: 1,
            method: "identity_dh",
            nonce: "bad",
            confirmation: "bad",
          },
        },
      },
      { trustedEnvelope: true }
    );

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

  it("completes friendship when an incoming request matches an outgoing request", async () => {
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
        friendStatus: "request_out",
        identityPub,
        dhPub,
        routingHints: {
          deviceId: "11111111-1111-4111-8111-111111111111",
          onionAddr: "oldpeer.onion",
        },
        primaryDeviceId: "11111111-1111-4111-8111-111111111111",
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    vi.mocked(repo.listConversations).mockResolvedValue([
      {
        id: "c1",
        type: "direct",
        name: "Peer",
        pinned: false,
        unread: 0,
        hidden: false,
        muted: false,
        blocked: false,
        pendingOutgoing: true,
        pendingAcceptance: false,
        lastTs: 0,
        lastMessage: "",
        participants: ["local", "peer"],
      },
    ]);

    const friendCode = encodeFriendCodeV1({
      v: 1,
      identityPub,
      dhPub,
      deviceId: "22222222-2222-4222-8222-222222222222",
      onionAddr: "newpeer.onion",
      lokinetAddr: "newpeer.loki",
    });

    await handleIncomingFriendFrame(
      {
        type: "friend_req",
        convId: "c1",
        from: {
          identityPub,
          dhPub,
          deviceId: "22222222-2222-4222-8222-222222222222",
          friendCode,
        },
        profile: {
          displayName: "Peer",
        },
        ts: Date.now(),
      },
      { trustedEnvelope: true }
    );

    expect(vi.mocked(repo.saveProfile)).toHaveBeenCalledWith(
      expect.objectContaining({
        friendStatus: "normal",
        primaryDeviceId: "22222222-2222-4222-8222-222222222222",
        routingHints: {
          deviceId: "22222222-2222-4222-8222-222222222222",
          onionAddr: "newpeer.onion",
          lokinetAddr: "newpeer.loki",
        },
      })
    );
    expect(vi.mocked(repo.saveConversation)).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingOutgoing: false,
        pendingAcceptance: false,
        pendingFriendResponse: undefined,
      })
    );
  });

  it("updates routing hints from an incoming accept friend code", async () => {
    const identityPub = encodeBase64Url(new Uint8Array(32).fill(4));
    const dhPub = encodeBase64Url(new Uint8Array(32).fill(5));
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
        friendStatus: "request_out",
        identityPub,
        dhPub,
        routingHints: {
          deviceId: "11111111-1111-4111-8111-111111111111",
        },
        primaryDeviceId: "11111111-1111-4111-8111-111111111111",
        createdAt: 0,
        updatedAt: 0,
      },
    ]);

    const friendCode = encodeFriendCodeV1({
      v: 1,
      identityPub,
      dhPub,
      deviceId: "33333333-3333-4333-8333-333333333333",
      onionAddr: "acceptpeer.onion",
      lokinetAddr: "acceptpeer.loki",
    });

    await handleIncomingFriendFrame(
      {
        type: "friend_accept",
        convId: "c1",
        from: {
          identityPub,
          dhPub,
          deviceId: "33333333-3333-4333-8333-333333333333",
          friendCode,
        },
        profile: {
          displayName: "Peer",
        },
        ts: Date.now(),
      },
      { trustedEnvelope: true }
    );

    expect(vi.mocked(repo.saveProfile)).toHaveBeenCalledWith(
      expect.objectContaining({
        friendStatus: "normal",
        primaryDeviceId: "33333333-3333-4333-8333-333333333333",
        routingHints: {
          deviceId: "33333333-3333-4333-8333-333333333333",
          onionAddr: "acceptpeer.onion",
          lokinetAddr: "acceptpeer.loki",
        },
        profileVcard: expect.objectContaining({ friendCode }),
      })
    );
  });
});
