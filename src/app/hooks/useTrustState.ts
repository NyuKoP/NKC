import { useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, UserProfile } from "../../db/repo";
import { encodeBase64Url } from "../../security/base64url";
import { getRoleEpoch } from "../../security/deviceRole";
import { getIdentityPrivateKey, getIdentityPublicKey } from "../../security/identityKeys";
import { getSodium } from "../../security/sodium";
import type { ConversationTransportStatus } from "../../net/transportManager";

export type TrustState = "UNVERIFIED" | "VERIFIED" | "KEY_CHANGED";

type TrustRecord = {
  peerIdentityKey?: string;
  trustState: TrustState;
  mkc?: {
    sessionEpoch: number;
    localNonce: string;
    localSig?: string;
    lastRunAt: number;
  };
};

type UseTrustStateArgs = {
  friends: UserProfile[];
  currentConversation: Conversation | null;
  currentTransportStatus: ConversationTransportStatus | null;
  partnerProfile: UserProfile | null;
};

const TRUST_STORE_KEY = "nkc_trust_state_v1";

const readTrustStore = () => {
  if (typeof window === "undefined") return {} as Record<string, TrustRecord>;
  try {
    const raw = window.localStorage.getItem(TRUST_STORE_KEY);
    if (!raw) return {} as Record<string, TrustRecord>;
    const parsed = JSON.parse(raw) as Record<string, TrustRecord>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {} as Record<string, TrustRecord>;
  }
};

const writeTrustStore = (value: Record<string, TrustRecord>) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TRUST_STORE_KEY, JSON.stringify(value));
  } catch {
    // ignore storage errors
  }
};

const createNonce = () => {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  }
  return encodeBase64Url(bytes);
};

const signMkcPayload = async (payload: Record<string, unknown>) => {
  const encoder = new TextEncoder();
  const sodium = await getSodium();
  const identityPriv = await getIdentityPrivateKey();
  const bytes = encoder.encode(JSON.stringify(payload));
  const sig = sodium.crypto_sign_detached(bytes, identityPriv);
  return encodeBase64Url(sig);
};

export const useTrustState = ({
  friends,
  currentConversation,
  currentTransportStatus,
  partnerProfile,
}: UseTrustStateArgs) => {
  const [trustByFriendId, setTrustByFriendId] = useState<Record<string, TrustRecord>>(() =>
    readTrustStore()
  );
  const mkcRunRef = useRef<Record<string, number>>({});
  const mkcInFlightRef = useRef<Record<string, boolean>>({});
  const mkcConnectedRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    writeTrustStore(trustByFriendId);
  }, [trustByFriendId]);

  const currentTrustState = useMemo(() => {
    if (!partnerProfile) return "UNVERIFIED" as TrustState;
    const verification = partnerProfile.verification?.status;
    if (verification === "verified") return "VERIFIED";
    if (verification === "key_changed") return "KEY_CHANGED";
    const trustRecord = trustByFriendId[partnerProfile.id];
    if (
      trustRecord?.peerIdentityKey &&
      partnerProfile.identityPub &&
      trustRecord.peerIdentityKey !== partnerProfile.identityPub
    ) {
      return "KEY_CHANGED";
    }
    return trustRecord?.trustState ?? "UNVERIFIED";
  }, [partnerProfile, trustByFriendId]);

  useEffect(() => {
    if (!currentConversation || !partnerProfile?.identityPub) return;
    const isDirect =
      !(currentConversation.type === "group" || currentConversation.participants.length > 2) &&
      currentConversation.participants.length === 2;
    if (!isDirect) return;

    const isConnected = currentTransportStatus?.state === "connected";
    const prevConnected = mkcConnectedRef.current[currentConversation.id] ?? false;
    if (!isConnected) {
      mkcConnectedRef.current[currentConversation.id] = false;
      return;
    }
    mkcConnectedRef.current[currentConversation.id] = true;

    const trustRecord = trustByFriendId[partnerProfile.id];
    if (
      trustRecord?.trustState === "KEY_CHANGED" ||
      (trustRecord?.peerIdentityKey &&
        partnerProfile.identityPub &&
        trustRecord.peerIdentityKey !== partnerProfile.identityPub)
    ) {
      return;
    }

    const sessionEpoch = getRoleEpoch();
    const shouldRun = !prevConnected || mkcRunRef.current[currentConversation.id] !== sessionEpoch;
    if (!shouldRun) return;
    if (mkcInFlightRef.current[currentConversation.id]) return;
    mkcInFlightRef.current[currentConversation.id] = true;

    const run = async () => {
      const localIdentityPub = await getIdentityPublicKey();
      const localIdentityPubB64 = encodeBase64Url(localIdentityPub);
      const localNonce = createNonce();
      const payload = {
        type: "MKC",
        convId: currentConversation.id,
        localIdentityPub: localIdentityPubB64,
        peerIdentityPub: partnerProfile.identityPub,
        sessionEpoch,
        localNonce,
      };
      let localSig: string | undefined;
      try {
        localSig = await signMkcPayload(payload);
      } catch (error) {
        console.warn("Failed to sign MKC payload", error);
      }

      setTrustByFriendId((prev) => {
        const existing = prev[partnerProfile.id];
        if (existing?.trustState === "KEY_CHANGED") return prev;
        const next: TrustRecord = {
          peerIdentityKey: existing?.peerIdentityKey ?? partnerProfile.identityPub,
          trustState: "VERIFIED",
          mkc: {
            sessionEpoch,
            localNonce,
            localSig,
            lastRunAt: Date.now(),
          },
        };
        return { ...prev, [partnerProfile.id]: next };
      });
    };

    run()
      .catch((error) => console.warn("MKC failed", error))
      .finally(() => {
        mkcRunRef.current[currentConversation.id] = sessionEpoch;
        mkcInFlightRef.current[currentConversation.id] = false;
      });
  }, [currentConversation, currentTransportStatus, friends, partnerProfile, trustByFriendId]);

  return {
    currentTrustState,
  };
};
