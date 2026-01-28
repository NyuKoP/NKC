import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "./store";
import Onboarding from "../components/Onboarding";
import Unlock from "../components/Unlock";
import StartKey from "../components/StartKey";
import FriendAddDialog from "../components/FriendAddDialog";
import GroupCreateDialog from "../components/GroupCreateDialog";
import GroupInviteDialog from "../components/GroupInviteDialog";
import Sidebar from "../components/Sidebar";
import ChatView from "../components/ChatView";
import RightPanel from "../components/RightPanel";
import SettingsDialog from "../components/SettingsDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import Toasts from "../components/Toasts";
import { createId } from "../utils/ids";
import {
  bootstrapVault,
  resetVaultStorage,
  getVaultHeader,
  listConversations,
  listProfiles,
  lockVault,
  repairVaultTextEncoding,
  verifyVaultKeyId,
  rotateVaultKeys,
  deleteProfile,
  nextLamportForConv,
  getLastEventHash,
  saveConversation,
  saveEvent,
  saveMessage,
  saveMessageMedia,
  saveProfile,
  saveProfilePhoto,
  saveGroupPhotoRef,
  loadAvatarFromRef,
  seedVaultData,
  unlockVault,
  wipeVault,
  type Conversation,
  type Message,
  type UserProfile,
} from "../db/repo";
import { chunkBuffer, encryptJsonRecord, validateStartKey } from "../crypto/vault";
import { getVaultKey, setVaultKey } from "../crypto/sessionKeyring";
import { computeFriendId, decodeFriendCodeV1, encodeFriendCodeV1 } from "../security/friendCode";
import { decodeInviteCodeV1 } from "../security/inviteCode";
import { isInviteUsed, markInviteUsed } from "../security/inviteUseStore";
import { checkAllowed, recordFail, recordSuccess } from "../security/rateLimit";
import { applyTOFU } from "../security/trust";
import {
  clearSession as clearStoredSession,
  getSession as getStoredSession,
  setSession as setStoredSession,
} from "../security/session";
import { clearPin, clearPinRecord, getPinStatus, isPinUnavailableError, setPin as savePin, verifyPin } from "../security/pin";
import { loadConversationMessages } from "../security/messageStore";
import { clearFriendPsk, getFriendPsk, setFriendPsk } from "../security/pskStore";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { getSodium } from "../security/sodium";
import {
  getDhPrivateKey,
  getDhPublicKey,
  getIdentityPrivateKey,
  getIdentityPublicKey,
  getOrCreateDhKeypair,
  getOrCreateIdentityKeypair,
} from "../security/identityKeys";
import { getOrCreateDeviceId, getRoleEpoch } from "../security/deviceRole";
import { computeEnvelopeHash, deriveConversationKey, encryptEnvelope, type EnvelopeHeader } from "../crypto/box";
import { nextSendDhKey, nextSendKey } from "../crypto/ratchet";
import { sendCiphertext } from "../net/router";
import { startOutboxScheduler } from "../net/outboxScheduler";
import { onConnectionStatus } from "../net/connectionStatus";
import { sanitizeRoutingHints } from "../net/privacy";
import {
  buildGroupInviteEvent,
  buildGroupLeaveEvent,
  syncGroupCreate,
  type GroupEventPayload,
} from "../sync/groupSync";
import {
  connectConversation as connectSyncConversation,
  disconnectConversation as disconnectSyncConversation,
} from "../sync/syncEngine";
import {
  getTransportStatus,
  onTransportStatusChange,
  setDirectApprovalHandler,
  type ConversationTransportStatus,
} from "../net/transportManager";
import { putReadCursor } from "../storage/receiptStore";
import { getGroupAvatarOverride, setGroupAvatarOverride } from "../security/preferences";
import { parseAvatarRef, resolveGroupAvatarRef } from "../utils/avatarRefs";
import { listFriendAliases, setFriendAlias } from "../storage/friendStore";
import { resolveDisplayName, resolveFriendDisplayName } from "../utils/displayName";

const buildNameMap = (
  profiles: UserProfile[],
  aliasesById: Record<string, string | undefined>
) =>
  profiles.reduce<Record<string, string>>((acc, profile) => {
    acc[profile.id] = resolveDisplayName({
      alias: aliasesById[profile.id],
      displayName: profile.displayName,
      friendId: profile.friendId,
      id: profile.id,
    });
    return acc;
  }, {});

const INLINE_MEDIA_MAX_BYTES = 500 * 1024 * 1024;
const INLINE_MEDIA_CHUNK_SIZE = 48 * 1024;
const READ_CURSOR_THROTTLE_MS = 1500;
type TrustState = "UNVERIFIED" | "VERIFIED" | "KEY_CHANGED";

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

export default function App() {
  const ui = useAppStore((state) => state.ui);
  const userProfile = useAppStore((state) => state.userProfile);
  const friends = useAppStore((state) => state.friends);
  const convs = useAppStore((state) => state.convs);
  const messagesByConv = useAppStore((state) => state.messagesByConv);
  const setMode = useAppStore((state) => state.setMode);
  const setSelectedConv = useAppStore((state) => state.setSelectedConv);
  const setIsComposing = useAppStore((state) => state.setIsComposing);
  const setRightPanelOpen = useAppStore((state) => state.setRightPanelOpen);
  const setRightTab = useAppStore((state) => state.setRightTab);
  const setListMode = useAppStore((state) => state.setListMode);
  const setListFilter = useAppStore((state) => state.setListFilter);
  const setSearch = useAppStore((state) => state.setSearch);
  const setSessionState = useAppStore((state) => state.setSession);
  const setData = useAppStore((state) => state.setData);
  const addToast = useAppStore((state) => state.addToast);
  const confirm = useAppStore((state) => state.ui.confirm);
  const setConfirm = useAppStore((state) => state.setConfirm);

  const navigate = useNavigate();
  const location = useLocation();

  const [pinEnabled, setPinEnabled] = useState(false);
  const [defaultTab, setDefaultTab] = useState<"create" | "startKey">("create");
  const [pinNeedsReset, setPinNeedsReset] = useState(false);
  const wasHiddenRef = useRef(false);

  const [onboardingError, setOnboardingError] = useState("");
  const [friendAddOpen, setFriendAddOpen] = useState(false);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [groupInviteOpen, setGroupInviteOpen] = useState(false);
  const [groupInviteConvId, setGroupInviteConvId] = useState<string | null>(null);
  const [groupAvatarOverrides, setGroupAvatarOverrides] = useState<Record<string, string | null>>(
    {}
  );
  const [groupAvatarOverrideVersion, setGroupAvatarOverrideVersion] = useState(0);
  const [friendAliasesById, setFriendAliasesById] = useState<Record<string, string | undefined>>(
    {}
  );
  const [friendAliasVersion, setFriendAliasVersion] = useState(0);
  const [myFriendCode, setMyFriendCode] = useState("");
  const [transportStatusByConv, setTransportStatusByConv] = useState<
    Record<string, ConversationTransportStatus>
  >({});
  const [directApprovalOpen, setDirectApprovalOpen] = useState(false);
  const directApprovalResolveRef = useRef<((approved: boolean) => void) | null>(null);
  const [trustByFriendId, setTrustByFriendId] = useState<Record<string, TrustRecord>>({});
  const mkcRunRef = useRef<Record<string, number>>({});
  const mkcInFlightRef = useRef<Record<string, boolean>>({});
  const mkcConnectedRef = useRef<Record<string, boolean>>({});

  const onboardingLockRef = useRef(false);
  const bootGuardRef = useRef<Promise<void> | null>(null);
  const outboxSchedulerStarted = useRef(false);
  const activeSyncConvRef = useRef<string | null>(null);
  const lastReadCursorSentAtRef = useRef<Record<string, number>>({});
  const lastReadCursorSentTsRef = useRef<Record<string, number>>({});
  const pendingReadCursorRef = useRef<
    Record<string, { cursorTs: number; anchorMsgId: string } | undefined>
  >({});
  const readCursorThrottleTimerRef = useRef<Record<string, number | undefined>>({});

  const connectionToastShown = useRef(false);
  const connectionToastKey = "nkc.sessionConnectedToastShown";

  const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  const devLog = useCallback(
    (message: string, detail?: Record<string, unknown>) => {
      if (!isDev) return;
      if (detail) console.debug(`[app] ${message}`, detail);
      else console.debug(`[app] ${message}`);
    },
    [isDev]
  );

  const settingsOpen = location.pathname === "/settings";
  const clearConnectionToastGuard = useCallback(() => {
    connectionToastShown.current = false;
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(connectionToastKey);
    }
  }, [connectionToastKey]);

  const resetAppState = useCallback(() => {
    clearConnectionToastGuard();
    setSessionState({ unlocked: false, vkInMemory: false });
    setData({ user: null, friends: [], convs: [], messagesByConv: {} });
    setSelectedConv(null);
  }, [clearConnectionToastGuard, setData, setSelectedConv, setSessionState]);

  useEffect(() => {
    if (!friendAddOpen || !userProfile) return;
    Promise.all([getIdentityPublicKey(), getDhPublicKey()])
      .then(([identityPub, dhPub]) =>
        encodeFriendCodeV1({
          v: 1,
          identityPub: encodeBase64Url(identityPub),
          dhPub: encodeBase64Url(dhPub),
        })
      )
      .then(setMyFriendCode)
      .catch((error) => console.error("Failed to compute friend code", error));
  }, [friendAddOpen, userProfile]);

  const resolveDirectApproval = useCallback((approved: boolean) => {
    const resolver = directApprovalResolveRef.current;
    if (resolver) {
      resolver(approved);
    }
    directApprovalResolveRef.current = null;
    setDirectApprovalOpen(false);
  }, []);

  const requestDirectApproval = useCallback(async () => {
    if (directApprovalResolveRef.current) return false;
    return new Promise<boolean>((resolve) => {
      directApprovalResolveRef.current = resolve;
      setDirectApprovalOpen(true);
    });
  }, []);

  useEffect(() => {
    setDirectApprovalHandler(requestDirectApproval);
    return () => {
      setDirectApprovalHandler(null);
    };
  }, [requestDirectApproval]);

  useEffect(() => {
    const unsubscribe = onTransportStatusChange((convId, status) => {
      setTransportStatusByConv((prev) => ({ ...prev, [convId]: status }));
    });
    return () => {
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    setTrustByFriendId(readTrustStore());
  }, []);

  useEffect(() => {
    writeTrustStore(trustByFriendId);
  }, [trustByFriendId]);

  useEffect(() => {
    if (!friends.length) return;
    setTrustByFriendId((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const friend of friends) {
        if (!friend.identityPub) continue;
        const existing = next[friend.id];
        if (!existing) {
          next[friend.id] = { peerIdentityKey: friend.identityPub, trustState: "UNVERIFIED" };
          changed = true;
          continue;
        }
        if (!existing.peerIdentityKey) {
          next[friend.id] = {
            ...existing,
            peerIdentityKey: friend.identityPub,
            trustState: existing.trustState ?? "UNVERIFIED",
          };
          changed = true;
          continue;
        }
        if (existing.peerIdentityKey !== friend.identityPub && existing.trustState !== "KEY_CHANGED") {
          next[friend.id] = { ...existing, trustState: "KEY_CHANGED" };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [friends]);

  const withTimeout = useCallback(
    async <T,>(promise: Promise<T>, label: string, ms = 15000) => {
      let timer: number | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      });
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        if (timer) window.clearTimeout(timer);
      }
    },
    []
  );

  const hydrateVault = useCallback(async () => {
    try {
      devLog("hydrate:start");

      const vk = getVaultKey();
      if (vk) {
        const keyOk = await withTimeout(verifyVaultKeyId(vk), "verifyVaultKeyId");
        if (!keyOk) {
          console.warn("[vault] key mismatch -> reset");
          await withTimeout(resetVaultStorage(), "resetVaultStorage");
          await clearStoredSession();
          lockVault();
          resetAppState();
          setPinEnabled(false);
          setPinNeedsReset(false);
          setDefaultTab("startKey");
          setMode("onboarding");
          return;
        }
      }

      await withTimeout(repairVaultTextEncoding(), "repairVaultTextEncoding");

      const profiles = await withTimeout(listProfiles(), "listProfiles");
      const user = profiles.find((profile) => profile.kind === "user") || null;
      const friendProfiles = profiles.filter((profile) => profile.kind === "friend");

      const conversations = await withTimeout(listConversations(), "listConversations");
      const messagesBy: Record<string, Message[]> = {};

      for (const conv of conversations) {
        if (!user) {
          messagesBy[conv.id] = [];
          continue;
        }
        const isDirect =
          !(conv.type === "group" || conv.participants.length > 2) && conv.participants.length === 2;
        const partnerId = isDirect
          ? conv.participants.find((id) => id && id !== user.id) || null
          : null;
        const partner = partnerId
          ? friendProfiles.find((profile) => profile.id === partnerId) || null
          : null;
        messagesBy[conv.id] = await withTimeout(
          loadConversationMessages(conv, partner, user.id),
          "loadConversationMessages"
        );
      }

      setData({
        user,
        friends: friendProfiles,
        convs: conversations,
        messagesByConv: messagesBy,
      });

      setSessionState({ unlocked: true, vkInMemory: true });
      setMode("app");

      devLog("hydrate:done", { profiles: profiles.length, convs: conversations.length });
    } catch (error) {
      console.error("Failed to hydrate vault", error);

      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("ciphertext") || message.includes("decrypted") || message.includes("Vault key mismatch")) {
        try {
          await withTimeout(resetVaultStorage(), "resetVaultStorage");
        } catch (resetError) {
          console.error("Failed to reset vault storage", resetError);
        }
      }

      await clearStoredSession();
      lockVault();
      resetAppState();

      const pinStatus = await getPinStatus();
      setPinEnabled(pinStatus.enabled);
      setPinNeedsReset(pinStatus.needsReset);

      if (pinStatus.enabled && !pinStatus.needsReset) {
        setMode("locked");
      } else {
        if (pinStatus.needsReset) {
          addToast({ message: "PIN must be reset. Unlock with the start key." });
        }
        setDefaultTab("startKey");
        setMode("onboarding");
      }

      addToast({ message: "?몄뀡??留뚮즺?섏뿀?쇰땲 ?ㅼ떆 濡쒓렇?명빐 二쇱꽭??" });
    }
  }, [
    addToast,
    devLog,
    resetAppState,
    setData,
    setDefaultTab,
    setMode,
    setPinEnabled,
    setPinNeedsReset,
    setSessionState,
    withTimeout,
  ]);

  useEffect(() => {
    if (bootGuardRef.current) return;
    let cancelled = false;

    const boot = async () => {
      try {
        const header = await getVaultHeader();
        if (!header) {
          setDefaultTab("create");
          setMode("onboarding");
          return;
        }

        const pinStatus = await getPinStatus();
        if (!cancelled) {
          setPinEnabled(pinStatus.enabled);
          setPinNeedsReset(pinStatus.needsReset);
        }

        if (pinStatus.enabled && !pinStatus.needsReset) {
          setMode("locked");
        } else {
          const session = await getStoredSession();
          if (session?.vaultKey) {
            setVaultKey(session.vaultKey);
            await setStoredSession(session.vaultKey, undefined, { remember: true });
            await hydrateVault();
            return;
          }

          if (pinStatus.needsReset) {
          addToast({ message: "PIN must be reset. Unlock with the start key." });
          }
          setDefaultTab("startKey");
          setMode("onboarding");
        }
      } catch (error) {
        console.error("Boot failed", error);
        addToast({ message: "珥덇린?붿뿉 ?ㅽ뙣?덉뒿?덈떎." });
        setMode("onboarding");
      }
    };

    bootGuardRef.current = boot().finally(() => {
      bootGuardRef.current = null;
    });

    return () => {
      cancelled = true;
    };
  }, [addToast, hydrateVault, setDefaultTab, setMode, setPinEnabled, setPinNeedsReset]);

  useEffect(() => {
    if (ui.mode !== "app") return;
    if (outboxSchedulerStarted.current) return;
    startOutboxScheduler();
    outboxSchedulerStarted.current = true;
  }, [ui.mode]);

  // cleanup ???臾몄젣(EffectCallback) + unsubscribe 諛⑹뼱
  useEffect(() => {
    if (typeof window !== "undefined") {
      connectionToastShown.current = window.sessionStorage.getItem(connectionToastKey) === "1";
    }

    let prevConnected = false;

    const unsubscribe = onConnectionStatus((status) => {
      const connected = status.state === "connected";

      if (!connected || prevConnected) {
        prevConnected = connected;
        return;
      }
      if (ui.mode !== "app") {
        prevConnected = connected;
        return;
      }
      if (connectionToastShown.current) {
        prevConnected = connected;
        return;
      }

      addToast({ message: "?몄뀡???곌껐?섏뿀?듬땲??" });
      connectionToastShown.current = true;

      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(connectionToastKey, "1");
      }

      prevConnected = connected;
    });

    return () => {
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch (e) {
        console.error("Failed to unsubscribe connection status", e);
      }
    };
  }, [addToast, connectionToastKey, ui.mode]);

  const handleCreate = async (displayName: string) => {
    if (onboardingLockRef.current) return;
    onboardingLockRef.current = true;

    try {
      setOnboardingError("");
      devLog("onboarding:create:start");

      await withTimeout(clearStoredSession(), "clearStoredSession");
      await withTimeout(resetVaultStorage(), "resetVaultStorage");
      await withTimeout(bootstrapVault(), "bootstrapVault");

      const vk = getVaultKey();
      if (!vk) throw new Error("Vault key missing after bootstrap.");

      await withTimeout(
        Promise.all([getOrCreateIdentityKeypair(), getOrCreateDhKeypair()]).then(() => undefined),
        "ensureDeviceKeys"
      );
      getOrCreateDeviceId();

      const now = Date.now();
      const user: UserProfile = {
        id: createId(),
        displayName,
        status: "Hello from NKC",
        theme: "dark",
        kind: "user",
        createdAt: now,
        updatedAt: now,
      };

      await withTimeout(seedVaultData(user), "seedVaultData");
      await withTimeout(setStoredSession(vk, undefined, { remember: true }), "setStoredSession");
      await withTimeout(hydrateVault(), "hydrateVault");
    } catch (error) {
      console.error("Vault bootstrap failed", error);
      setOnboardingError(error instanceof Error ? error.message : "湲덇퀬 珥덇린?붿뿉 ?ㅽ뙣?덉뒿?덈떎.");
      lockVault();
      addToast({ message: "湲덇퀬 珥덇린?붿뿉 ?ㅽ뙣?덉뒿?덈떎." });
    } finally {
      onboardingLockRef.current = false;
    }
  };

  const handleStartKeyUnlock = async (startKey: string, displayName: string) => {
    if (onboardingLockRef.current) return;
    onboardingLockRef.current = true;

    if (!validateStartKey(startKey)) {
      addToast({ message: "?쒖옉 ???뺤떇???щ컮瑜댁? ?딆뒿?덈떎. (?? NKC-...)" });
      onboardingLockRef.current = false;
      return;
    }

    try {
      devLog("onboarding:start-key:start");

      await withTimeout(unlockVault(startKey), "unlockVault");

      const vk = getVaultKey();
      if (!vk) throw new Error("Vault key missing after unlock.");

      await withTimeout(
        Promise.all([getOrCreateIdentityKeypair(), getOrCreateDhKeypair()]).then(() => undefined),
        "ensureDeviceKeys"
      );
      getOrCreateDeviceId();

      const profiles = await withTimeout(listProfiles(), "listProfiles");
      if (!profiles.length) {
        const now = Date.now();
        const user: UserProfile = {
          id: createId(),
          displayName: displayName || "NKC User",
          status: "Hello from NKC",
          theme: "dark",
          kind: "user",
          createdAt: now,
          updatedAt: now,
        };
        await withTimeout(seedVaultData(user), "seedVaultData");
      }

      await withTimeout(setStoredSession(vk, undefined, { remember: true }), "setStoredSession");
      await withTimeout(hydrateVault(), "hydrateVault");
    } catch (error) {
      console.error("Start key unlock failed", error);
      lockVault();
      addToast({ message: "?쒖옉 ?ㅻ줈 ?좉툑 ?댁젣???ㅽ뙣?덉뒿?덈떎." });
    } finally {
      onboardingLockRef.current = false;
    }
  };

  const handlePinUnlock = async (pin: string) => {
    const result = await verifyPin(pin);

    if (!result.ok) {
      if (result.reason === "unavailable") {
        return {
          ok: false,
          error: result.message || "PIN lock is unavailable on this platform/build.",
        };
      }
      if (result.reason === "not_set") {
        await clearPinRecord();
        setPinEnabled(true);
        setPinNeedsReset(true);
        setDefaultTab("startKey");
        setMode("onboarding");
        navigate("/");
        return { ok: false, error: "PIN must be reset. Unlock with the start key." };
      }

      return {
        ok: false,
        error: result.reason === "locked" ? "Please try again later." : "PIN is incorrect.",
        retryAfterMs: result.retryAfterMs,
      };
    }

    try {
      setVaultKey(result.vaultKey);
      await setStoredSession(result.vaultKey, undefined, { remember: true });
      await hydrateVault();
      navigate("/");
      return { ok: true };
    } catch (error) {
      console.error("PIN unlock hydrate failed", error);
      await clearPinRecord();
      setPinEnabled(true);
      setPinNeedsReset(true);
      return { ok: false, error: "Unlock failed." };
    }
  };

  const handleLock = useCallback(async () => {
    let enabled = pinEnabled;
    let needsReset = pinNeedsReset;

    // Re-sync with the source of truth in case local state is stale.
    if (!enabled || needsReset) {
      try {
        const pinStatus = await getPinStatus();
        enabled = pinStatus.enabled;
        needsReset = pinStatus.needsReset;
        setPinEnabled(enabled);
        setPinNeedsReset(needsReset);
      } catch (error) {
        console.error("Failed to read PIN status before lock", error);
      }
    }

    if (!enabled || needsReset) {
      if (needsReset) {
        addToast({ message: "Reset your PIN to enable lock." });
        return;
      }
      addToast({ message: "Set a PIN to enable lock." });
      return;
    }

    try {
      await clearStoredSession();
      lockVault();
      resetAppState();
      setMode("locked");
      navigate("/unlock");
    } catch (error) {
      console.error("Failed to lock", error);
      addToast({ message: "Lock failed." });
    }
  }, [
    addToast,
    navigate,
    pinEnabled,
    pinNeedsReset,
    resetAppState,
    setMode,
    setPinEnabled,
    setPinNeedsReset,
  ]);

  useEffect(() => {
    if (!pinEnabled || pinNeedsReset || ui.mode !== "app") return;

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        wasHiddenRef.current = true;
        return;
      }
      if (document.visibilityState === "visible" && wasHiddenRef.current) {
        wasHiddenRef.current = false;
        void handleLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [handleLock, pinEnabled, pinNeedsReset, ui.mode]);

  const handleLogout = async () => {
    try {
      await clearStoredSession();
      lockVault();
      resetAppState();

      const pinStatus = await getPinStatus();
      setPinEnabled(pinStatus.enabled);
      setPinNeedsReset(pinStatus.needsReset);

      if (pinStatus.enabled && !pinStatus.needsReset) {
        setMode("locked");
        navigate("/unlock");
      } else {
        if (pinStatus.needsReset) {
          addToast({ message: "PIN must be reset. Unlock with the start key." });
        }
        setDefaultTab("startKey");
        setMode("onboarding");
        navigate("/");
      }
    } catch (error) {
      console.error("Failed to logout", error);
      addToast({ message: "濡쒓렇?꾩썐???ㅽ뙣?덉뒿?덈떎." });
    }
  };

  const handleSetPin = async (pin: string) => {
    try {
      await savePin(pin);
      setPinEnabled(true);
      setPinNeedsReset(false);
      addToast({ message: "PIN set." });
      return { ok: true as const };
    } catch (error) {
      if (isPinUnavailableError(error)) {
        return {
          ok: false as const,
          error: "PIN lock is unavailable on this platform/build.",
        };
      }
      const message = String((error as { message?: unknown })?.message ?? error);
      console.error("Failed to set PIN", message);
      return {
        ok: false as const,
        error: message || "Failed to set PIN.",
      };
    }
  };

  const handleDisablePin = async () => {
    try {
      await clearPin();
      setPinEnabled(false);
      setPinNeedsReset(false);
      addToast({ message: "PIN disabled." });
    } catch (error) {
      if (isPinUnavailableError(error)) {
        addToast({ message: "PIN lock is unavailable on this platform/build." });
        return;
      }
      console.error("Failed to clear PIN", error);
      addToast({ message: "Failed to disable PIN." });
    }
  };

  const handleRotateStartKey = async (newKey: string) => {
    try {
      if (!validateStartKey(newKey)) {
        addToast({ message: "?쒖옉 ???뺤떇???щ컮瑜댁? ?딆뒿?덈떎. (?? NKC-...)" });
        return;
      }

      await rotateVaultKeys(newKey, () => {});
      const vk = getVaultKey();
      if (vk) await setStoredSession(vk, undefined, { remember: true });

      await clearPinRecord();
      setPinEnabled(true);
      setPinNeedsReset(true);

      addToast({ message: "?쒖옉 ?ㅺ? 蹂寃쎈릺?덉뒿?덈떎. PIN???ㅼ떆 ?ㅼ젙??二쇱꽭??" });
    } catch (error) {
      console.error("Failed to rotate start key", error);
      addToast({ message: "?쒖옉 ??蹂寃쎌뿉 ?ㅽ뙣?덉뒿?덈떎." });
      throw error;
    }
  };

  const handleSaveProfile = async (payload: { displayName: string; status: string; theme: "dark" | "light" }) => {
    if (!userProfile) return;

    const updated: UserProfile = {
      ...userProfile,
      ...payload,
      updatedAt: Date.now(),
    };

    await saveProfile(updated);
    await hydrateVault();
  };

  const handleUploadPhoto = async (file: File) => {
    if (!userProfile) return;
    const avatarRef = await saveProfilePhoto(userProfile.id, file);
    const updated: UserProfile = {
      ...userProfile,
      avatarRef,
      updatedAt: Date.now(),
    };
    await saveProfile(updated);
    await hydrateVault();
  };


  const buildRoutingMeta = (partner: UserProfile) => ({
    toDeviceId: partner.friendId ?? partner.id,
    route: {
      torOnion: partner.routingHints?.onionAddr,
      lokinet: partner.routingHints?.lokinetAddr,
    },
  });

  const sendDirectEnvelope = useCallback(
    async (
      conv: Conversation,
      partner: UserProfile,
      body: unknown,
      priority: "high" | "normal" = "high"
    ) => {
      if (!partner.dhPub || !partner.identityPub) {
        throw new Error("Missing peer keys");
      }
      const now = Date.now();
      const friendKeyId = partner.friendId ?? partner.id;
      const lamport = await nextLamportForConv(conv.id);
      const header: EnvelopeHeader = {
        v: 1 as const,
        eventId: createId(),
        convId: conv.id,
        ts: now,
        lamport,
        authorDeviceId: getOrCreateDeviceId(),
      };
      header.prev = await getLastEventHash(conv.id);

      const dhPriv = await getDhPrivateKey();
      const theirDhPub = decodeBase64Url(partner.dhPub);
      const pskBytes = await getFriendPsk(friendKeyId);
      const legacyContextBytes = new TextEncoder().encode(`direct:${friendKeyId}`);
      const ratchetContextBytes = new TextEncoder().encode(`conv:${conv.id}`);
      const conversationKey = await deriveConversationKey(dhPriv, theirDhPub, pskBytes, legacyContextBytes);
      const ratchetBaseKey = await deriveConversationKey(dhPriv, theirDhPub, pskBytes, ratchetContextBytes);

      const myIdentityPriv = await getIdentityPrivateKey();
      let keyForEnvelope = conversationKey;
      try {
        const ratchet = await nextSendDhKey(conv.id, ratchetBaseKey);
        header.rk = ratchet.headerRk;
        keyForEnvelope = ratchet.msgKey;
      } catch {
        try {
          const ratchet = await nextSendKey(conv.id, ratchetBaseKey);
          header.rk = ratchet.headerRk;
          keyForEnvelope = ratchet.msgKey;
        } catch (error) {
          console.warn("[ratchet] send fallback to legacy", error);
        }
      }

      const envelope = await encryptEnvelope(keyForEnvelope, header, body, myIdentityPriv);
      const envelopeJson = JSON.stringify(envelope);
      const eventHash = await computeEnvelopeHash(envelope);

      await saveEvent({
        eventId: header.eventId,
        convId: header.convId,
        authorDeviceId: header.authorDeviceId,
        lamport: header.lamport,
        ts: header.ts,
        envelopeJson,
        prevHash: header.prev,
        eventHash,
      });

      void sendCiphertext({
        convId: conv.id,
        messageId: header.eventId,
        ciphertext: envelopeJson,
        priority,
        ...buildRoutingMeta(partner),
      }).catch((error) => {
        console.error("Failed to route message", error);
      });

      return { header, envelopeJson };
    },
    []
  );

  const handleSendMessage = async (text: string) => {
    if (!ui.selectedConvId || !userProfile) return;
    const conv = convs.find((item) => item.id === ui.selectedConvId);
    if (!conv) return;

    const vk = getVaultKey();
    if (!vk) return;

    const isDirect =
      !(conv.type === "group" || conv.participants.length > 2) && conv.participants.length === 2;

    if (isDirect) {
      const partnerId = conv.participants.find((id) => id && id !== userProfile.id) || null;
      const partner = partnerId ? friends.find((friend) => friend.id === partnerId) || null : null;

      if (partner?.dhPub && partner.identityPub) {
        const now = Date.now();
        const friendKeyId = partner.friendId ?? partner.id;
        const lamport = await nextLamportForConv(conv.id);
        const header: EnvelopeHeader = {
          v: 1 as const,
          eventId: createId(),
          convId: conv.id,
          ts: now,
          lamport,
          authorDeviceId: getOrCreateDeviceId(),
        };
        header.prev = await getLastEventHash(conv.id);
        header.prev = await getLastEventHash(conv.id);

        const dhPriv = await getDhPrivateKey();
        const theirDhPub = decodeBase64Url(partner.dhPub);
        const pskBytes = await getFriendPsk(friendKeyId);
        const legacyContextBytes = new TextEncoder().encode(`direct:${friendKeyId}`);
        const ratchetContextBytes = new TextEncoder().encode(`conv:${conv.id}`);
        const conversationKey = await deriveConversationKey(
          dhPriv,
          theirDhPub,
          pskBytes,
          legacyContextBytes
        );
        const ratchetBaseKey = await deriveConversationKey(
          dhPriv,
          theirDhPub,
          pskBytes,
          ratchetContextBytes
        );

        const myIdentityPriv = await getIdentityPrivateKey();
        let keyForEnvelope = conversationKey;
        try {
          const ratchet = await nextSendDhKey(conv.id, ratchetBaseKey);
          header.rk = ratchet.headerRk;
          keyForEnvelope = ratchet.msgKey;
        } catch {
          try {
            const ratchet = await nextSendKey(conv.id, ratchetBaseKey);
            header.rk = ratchet.headerRk;
            keyForEnvelope = ratchet.msgKey;
          } catch (error) {
            console.warn("[ratchet] send fallback to legacy", error);
          }
        }
        const envelope = await encryptEnvelope(
          keyForEnvelope,
          header,
          { type: "msg", text },
          myIdentityPriv
        );
        const envelopeJson = JSON.stringify(envelope);
        const eventHash = await computeEnvelopeHash(envelope);

        await saveEvent({
          eventId: header.eventId,
          convId: header.convId,
          authorDeviceId: header.authorDeviceId,
          lamport: header.lamport,
          ts: header.ts,
          envelopeJson,
          prevHash: header.prev,
          eventHash,
        });

        void sendCiphertext({
          convId: conv.id,
          messageId: header.eventId,
          ciphertext: envelopeJson,
          priority: "high",
          ...buildRoutingMeta(partner),
        }).catch((error) => {
          console.error("Failed to route message", error);
        });

        const updatedConv: Conversation = {
          ...conv,
          lastMessage: text,
          lastTs: now,
          unread: 0,
        };

        await saveConversation(updatedConv);
        await hydrateVault();
        return;
      }
    }

    const message: Message = {
      id: createId(),
      convId: conv.id,
      senderId: userProfile.id,
      text,
      ts: Date.now(),
    };

    const ciphertext = await encryptJsonRecord(vk, message.id, "message", message);

    await saveMessage(message);

    void sendCiphertext({
      convId: conv.id,
      messageId: message.id,
      ciphertext,
      priority: "high",
    }).catch((error) => {
      console.error("Failed to route message", error);
    });

    const updatedConv: Conversation = {
      ...conv,
      lastMessage: text,
      lastTs: message.ts,
      unread: 0,
    };

    await saveConversation(updatedConv);
    await hydrateVault();
  };

  const handleSendMedia = async (files: File[]) => {
    if (!ui.selectedConvId || !userProfile) return;
    const conv = convs.find((item) => item.id === ui.selectedConvId);
    if (!conv) return;

    const vk = getVaultKey();
    if (!vk) return;

    const sendSingleMedia = async (file: File) => {
      if (file.size > INLINE_MEDIA_MAX_BYTES) {
        addToast({ message: "Attachment too large (max 500MB)." });
        return;
      }

      const isDirect =
        !(conv.type === "group" || conv.participants.length > 2) &&
        conv.participants.length === 2;

      if (isDirect) {
        const partnerId = conv.participants.find((id) => id && id !== userProfile.id) || null;
        const partner = partnerId ? friends.find((friend) => friend.id === partnerId) || null : null;

        if (partner?.dhPub && partner.identityPub) {
          const now = Date.now();
          const friendKeyId = partner.friendId ?? partner.id;
          const lamport = await nextLamportForConv(conv.id);
          const header: EnvelopeHeader = {
            v: 1 as const,
            eventId: createId(),
            convId: conv.id,
            ts: now,
            lamport,
            authorDeviceId: getOrCreateDeviceId(),
          };

          const media = await saveMessageMedia(
            header.eventId,
            file,
            INLINE_MEDIA_CHUNK_SIZE
          );
          const label = media.mime.startsWith("image/") ? "Photo" : media.name || "File";

          const dhPriv = await getDhPrivateKey();
          const theirDhPub = decodeBase64Url(partner.dhPub);
          const pskBytes = await getFriendPsk(friendKeyId);
          const legacyContextBytes = new TextEncoder().encode(`direct:${friendKeyId}`);
          const ratchetContextBytes = new TextEncoder().encode(`conv:${conv.id}`);
          const conversationKey = await deriveConversationKey(
            dhPriv,
            theirDhPub,
            pskBytes,
            legacyContextBytes
          );
          const ratchetBaseKey = await deriveConversationKey(
            dhPriv,
            theirDhPub,
            pskBytes,
            ratchetContextBytes
          );

          const myIdentityPriv = await getIdentityPrivateKey();
          let keyForEnvelope = conversationKey;
          try {
            const ratchet = await nextSendDhKey(conv.id, ratchetBaseKey);
            header.rk = ratchet.headerRk;
            keyForEnvelope = ratchet.msgKey;
          } catch {
            try {
              const ratchet = await nextSendKey(conv.id, ratchetBaseKey);
              header.rk = ratchet.headerRk;
              keyForEnvelope = ratchet.msgKey;
            } catch (error) {
              console.warn("[ratchet] send fallback to legacy", error);
            }
          }
          const envelope = await encryptEnvelope(
            keyForEnvelope,
            header,
            { type: "msg", text: label, media },
            myIdentityPriv
          );
          const envelopeJson = JSON.stringify(envelope);
          const eventHash = await computeEnvelopeHash(envelope);

          await saveEvent({
            eventId: header.eventId,
            convId: header.convId,
            authorDeviceId: header.authorDeviceId,
            lamport: header.lamport,
            ts: header.ts,
            envelopeJson,
            prevHash: header.prev,
            eventHash,
          });

          void sendCiphertext({
            convId: conv.id,
            messageId: header.eventId,
            ciphertext: envelopeJson,
            priority: "high",
            ...buildRoutingMeta(partner),
          }).catch((error) => {
            console.error("Failed to route message", error);
          });

          const updatedConv: Conversation = {
            ...conv,
            lastMessage: label,
            lastTs: now,
            unread: 0,
          };

          await saveConversation(updatedConv);
          await hydrateVault();

          const sendChunks = async () => {
            const buffer = await file.arrayBuffer();
            const chunks = chunkBuffer(buffer, INLINE_MEDIA_CHUNK_SIZE);
            const total = chunks.length;
            for (let idx = 0; idx < chunks.length; idx += 1) {
              const chunkBody = {
                type: "media",
                phase: "chunk",
                ownerId: header.eventId,
                idx,
                total,
                mime: media.mime,
                name: media.name,
                size: media.size,
                b64: encodeBase64Url(chunks[idx]),
              };
              await sendDirectEnvelope(conv, partner, chunkBody, "normal");
              if (idx > 0 && idx % 32 === 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
              }
            }
          };
          void sendChunks().catch((error) => {
            console.error("Failed to send media chunks", error);
          });
          return;
        }
      }

      const messageId = createId();
      const media = await saveMessageMedia(messageId, file);
      const label = media.mime.startsWith("image/") ? "Photo" : media.name || "File";

      const message: Message = {
        id: messageId,
        convId: conv.id,
        senderId: userProfile.id,
        text: label,
        ts: Date.now(),
        media,
      };

      const ciphertext = await encryptJsonRecord(vk, message.id, "message", message);

      await saveMessage(message);

      void sendCiphertext({
        convId: conv.id,
        messageId: message.id,
        ciphertext,
        priority: "high",
      }).catch((error) => {
        console.error("Failed to route message", error);
      });

      const updatedConv: Conversation = {
        ...conv,
        lastMessage: label,
        lastTs: message.ts,
        unread: 0,
      };

      await saveConversation(updatedConv);
      await hydrateVault();
    };

    for (const file of files) {
      try {
        await sendSingleMedia(file);
      } catch (error) {
        console.error("Failed to send media", error);
        addToast({ message: "Failed to send attachment." });
      }
    }
  };

  const findDirectConvWithFriend = useCallback(
    (friendId: string) =>
      convs.find(
        (conv) =>
          !(conv.type === "group" || conv.participants.length > 2) &&
          conv.participants.includes(friendId)
      ),
    [convs]
  );

  const handleSendReadReceipt = useCallback(
    async (payload: { convId: string; msgId: string; msgTs: number }) => {
      if (!userProfile) return;
      const conv = convs.find((item) => item.id === payload.convId);
      if (!conv) return;
      const cursorTs = payload.msgTs;
      await putReadCursor({
        convId: conv.id,
        actorId: userProfile.id,
        cursorTs,
        anchorMsgId: payload.msgId,
      });

      const sendNow = async (targetConv: Conversation, targetCursorTs: number, anchorMsgId: string) => {
        lastReadCursorSentAtRef.current[targetConv.id] = Date.now();
        lastReadCursorSentTsRef.current[targetConv.id] = targetCursorTs;

        const isDirect =
          !(targetConv.type === "group" || targetConv.participants.length > 2) &&
          targetConv.participants.length === 2;
        if (isDirect) {
          const partnerId =
            targetConv.participants.find((id) => id && id !== userProfile.id) || null;
          const partner = partnerId
            ? friends.find((friend) => friend.id === partnerId) || null
            : null;
          if (!partner?.dhPub || !partner.identityPub) return;

          try {
            await sendDirectEnvelope(
              targetConv,
              partner,
              {
                type: "rcpt",
                kind: "read_cursor",
                convId: targetConv.id,
                cursorTs: targetCursorTs,
                anchorMsgId,
                ts: Date.now(),
              },
              "normal"
            );
          } catch (error) {
            console.error("Failed to send read cursor", error);
          }
          return;
        }

        const targets = targetConv.participants.filter((id) => id && id !== userProfile.id);
        for (const memberId of targets) {
          const friend = friends.find((item) => item.id === memberId);
          if (!friend?.dhPub || !friend.identityPub) continue;
          const directConv = findDirectConvWithFriend(friend.id);
          if (!directConv) continue;
          try {
            await sendDirectEnvelope(
              directConv,
              friend,
              {
                type: "rcpt",
                kind: "read_cursor",
                convId: targetConv.id,
                cursorTs: targetCursorTs,
                anchorMsgId,
                ts: Date.now(),
              },
              "normal"
            );
          } catch (error) {
            console.error("Failed to send group read cursor", { memberId }, error);
          }
        }
      };

      const lastCursorTs = lastReadCursorSentTsRef.current[conv.id] ?? 0;
      if (cursorTs <= lastCursorTs) return;

      const now = Date.now();
      const lastSentAt = lastReadCursorSentAtRef.current[conv.id] ?? 0;
      const elapsed = now - lastSentAt;
      if (elapsed < READ_CURSOR_THROTTLE_MS) {
        const pending = pendingReadCursorRef.current[conv.id];
        if (!pending || cursorTs > pending.cursorTs) {
          pendingReadCursorRef.current[conv.id] = { cursorTs, anchorMsgId: payload.msgId };
        }
        if (!readCursorThrottleTimerRef.current[conv.id]) {
          const waitMs = Math.max(READ_CURSOR_THROTTLE_MS - elapsed, 0);
          readCursorThrottleTimerRef.current[conv.id] = window.setTimeout(() => {
            readCursorThrottleTimerRef.current[conv.id] = undefined;
            const next = pendingReadCursorRef.current[conv.id];
            if (!next) return;
            const latestConv = convs.find((item) => item.id === conv.id);
            if (!latestConv) return;
            const sentTs = lastReadCursorSentTsRef.current[conv.id] ?? 0;
            if (next.cursorTs <= sentTs) {
              pendingReadCursorRef.current[conv.id] = undefined;
              return;
            }
            pendingReadCursorRef.current[conv.id] = undefined;
            void sendNow(latestConv, next.cursorTs, next.anchorMsgId);
          }, waitMs);
        }
        return;
      }

      pendingReadCursorRef.current[conv.id] = undefined;
      void sendNow(conv, cursorTs, payload.msgId);
    },
    [convs, findDirectConvWithFriend, friends, sendDirectEnvelope, userProfile]
  );

  const ensureDirectConvForFanout = useCallback(
    async (friend: UserProfile, ts: number) => {
      if (!userProfile) return null;
      const existing = findDirectConvWithFriend(friend.id);
      if (existing) return existing;
      const directConv: Conversation = {
        id: createId(),
        type: "direct",
        name: friend.displayName || "Direct channel",
        pinned: false,
        unread: 0,
        hidden: true,
        muted: false,
        blocked: false,
        lastTs: ts,
        lastMessage: "",
        participants: [userProfile.id, friend.id],
      };
      await saveConversation(directConv);
      return directConv;
    },
    [findDirectConvWithFriend, userProfile]
  );

  const fanoutGroupAvatarChunks = useCallback(
    async (
      groupId: string,
      sharedAvatarRef: string | undefined,
      memberIds: string[],
      options?: { allowCreateDirect?: boolean }
    ) => {
      if (!userProfile || !sharedAvatarRef) return;
      const allowCreateDirect = Boolean(options?.allowCreateDirect);
      const blob = await loadAvatarFromRef(sharedAvatarRef);
      if (!blob) return;

      const buffer = await blob.arrayBuffer();
      const chunks = chunkBuffer(buffer, INLINE_MEDIA_CHUNK_SIZE);
      const total = chunks.length;
      if (!total) return;

      const targets = Array.from(new Set(memberIds)).filter(
        (id) => id && id !== userProfile.id
      );
      for (const memberId of targets) {
        const friend = friends.find((item) => item.id === memberId);
        if (!friend?.dhPub || !friend.identityPub) continue;
        let directConv = findDirectConvWithFriend(memberId) || null;
        if (!directConv && allowCreateDirect) {
          directConv = await ensureDirectConvForFanout(friend, Date.now());
        }
        if (!directConv) continue;

        const sendChunks = async () => {
          for (let idx = 0; idx < chunks.length; idx += 1) {
            await sendDirectEnvelope(
              directConv,
              friend,
              {
                type: "media",
                phase: "chunk",
                ownerType: "group",
                ownerId: groupId,
                idx,
                total,
                mime: blob.type || "image/png",
                b64: encodeBase64Url(chunks[idx]),
              },
              "normal"
            );
            if (idx > 0 && idx % 32 === 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
          }
        };

        void sendChunks().catch((error) => {
          console.error("Failed to fanout group avatar chunks", { memberId }, error);
        });
      }
    },
    [
      ensureDirectConvForFanout,
      findDirectConvWithFriend,
      friends,
      sendDirectEnvelope,
      userProfile,
    ]
  );

  const fanoutGroupEvent = useCallback(
    async (
      memberIds: string[],
      event: GroupEventPayload,
      options?: { allowCreateDirect?: boolean; toastOnFailure?: boolean; sendAvatarChunks?: boolean }
    ) => {
      if (!userProfile) return;
      const allowCreateDirect = Boolean(options?.allowCreateDirect);
      const toastOnFailure = options?.toastOnFailure ?? true;
      const sendAvatarChunks = options?.sendAvatarChunks ?? true;
      const targets = Array.from(new Set(memberIds)).filter((id) => id && id !== userProfile.id);
      if (!targets.length) return;

      const failures: string[] = [];
      for (const memberId of targets) {
        const friend = friends.find((item) => item.id === memberId);
        if (!friend?.dhPub || !friend.identityPub) {
          failures.push(memberId);
          continue;
        }
        let directConv = findDirectConvWithFriend(memberId) || null;
        if (!directConv && allowCreateDirect) {
          directConv = await ensureDirectConvForFanout(friend, event.ts);
        }
        if (!directConv) {
          failures.push(memberId);
          continue;
        }
        try {
          await sendDirectEnvelope(directConv, friend, event, "normal");
        } catch (error) {
          console.error("Failed to fanout group event", { memberId }, error);
          failures.push(memberId);
        }
      }

      if (failures.length && toastOnFailure) {
        addToast({ message: `Some members could not be notified (${failures.length}).` });
      }

      if (event.kind === "group.create" && event.sharedAvatarRef && sendAvatarChunks) {
        await fanoutGroupAvatarChunks(event.id, event.sharedAvatarRef, targets, {
          allowCreateDirect,
        });
      }
    },
    [
      addToast,
      ensureDirectConvForFanout,
      fanoutGroupAvatarChunks,
      findDirectConvWithFriend,
      friends,
      sendDirectEnvelope,
      userProfile,
    ]
  );

  const handleSelectFriend = async (friendId: string) => {
    const existing = findDirectConvWithFriend(friendId);
    if (existing) {
      setSelectedConv(existing.id);
      setMode("app");
      return;
    }

    if (!userProfile) return;

    const friend = friends.find((item) => item.id === friendId);

    const now = Date.now();
    const newConv: Conversation = {
      id: createId(),
      type: "direct",
      name: friend?.displayName || "??梨꾪똿",
      pinned: friend?.isFavorite ?? false,
      unread: 0,
      hidden: false,
      muted: false,
      blocked: false,
      lastTs: now,
      lastMessage: "梨꾪똿???쒖옉?덉뼱??",
      participants: [userProfile.id, friendId],
    };

    await saveConversation(newConv);

    await saveMessage({
      id: createId(),
      convId: newConv.id,
      senderId: userProfile.id,
      text: "梨꾪똿???쒖옉?덉뼱??",
      ts: now,
    });

    await hydrateVault();
    setSelectedConv(newConv.id);
  };

  const updateConversation = async (convId: string, updates: Partial<Conversation>) => {
    const target = convs.find((conv) => conv.id === convId);
    if (!target) return;
    const updated = { ...target, ...updates };
    await saveConversation(updated);
    await hydrateVault();
  };

  const handleSelectConv = (convId: string) => {
    setSelectedConv(convId);
    const target = convs.find((conv) => conv.id === convId);
    if (target && target.unread > 0) {
      void updateConversation(convId, { unread: 0 });
    }
  };

  const handleHide = (convId: string) => {
    void updateConversation(convId, { hidden: true });
    addToast({
      message: "채팅을 숨겼어요.",
      actionLabel: "Undo",
      onAction: () => {
        void updateConversation(convId, { hidden: false });
      },
    });
  };

  const handleDelete = (convId: string) => {
    setConfirm({
      title: "梨꾪똿????젣?좉퉴??",
      message: "??젣?섎㈃ 蹂듦뎄?????놁뒿?덈떎.",
      onConfirm: async () => {
        await updateConversation(convId, { hidden: true });
        addToast({
          message: "梨꾪똿????젣?덉뼱??",
          actionLabel: "Undo",
          onAction: () => {
            void updateConversation(convId, { hidden: false });
          },
        });
      },
    });
  };

  const handleTogglePin = (convId: string) => {
    const target = convs.find((conv) => conv.id === convId);
    if (!target) return;
    void updateConversation(convId, { pinned: !target.pinned });
  };

  const handleMute = (convId: string) => {
    const target = convs.find((conv) => conv.id === convId);
    if (!target) return;
    void updateConversation(convId, { muted: !target.muted });
  };

  const handleBlock = (convId: string) => {
    const target = convs.find((conv) => conv.id === convId);
    if (!target) return;
    void updateConversation(convId, { blocked: !target.blocked });
  };

  const handleFriendChat = async (friendId: string) => {
    try {
      await handleSelectFriend(friendId);
      setListMode("chats");
      setListFilter("all");
    } catch (error) {
      console.error("Failed to open chat", error);
      addToast({ message: "梨꾪똿 ?닿린???ㅽ뙣?덉뒿?덈떎." });
    }
  };

  const handleFriendViewProfile = async (friendId: string) => {
    try {
      await handleSelectFriend(friendId);
      setListMode("chats");
      setListFilter("all");
      setRightTab("about");
      setRightPanelOpen(true);
    } catch (error) {
      console.error("Failed to open profile", error);
      addToast({ message: "?꾨줈???닿린???ㅽ뙣?덉뒿?덈떎." });
    }
  };

  const updateFriend = async (friendId: string, updates: Partial<UserProfile>) => {
    const target = friends.find((friend) => friend.id === friendId);
    if (!target) return;

    const updated: UserProfile = {
      ...target,
      ...updates,
      updatedAt: Date.now(),
    };

    try {
      await saveProfile(updated);
      await hydrateVault();
    } catch (error) {
      console.error("Failed to update friend", error);
      addToast({ message: "移쒓뎄 蹂寃쎌뿉 ?ㅽ뙣?덉뒿?덈떎." });
    }
  };

  const handleFriendToggleFavorite = async (friendId: string) => {
    const target = friends.find((friend) => friend.id === friendId);
    if (!target) return;

    const nextFavorite = !target.isFavorite;

    try {
      await updateFriend(friendId, { isFavorite: nextFavorite });
      const existing = findDirectConvWithFriend(friendId);
      if (existing) {
        await updateConversation(existing.id, { pinned: nextFavorite });
      }
    } catch (error) {
      console.error("Failed to toggle favorite", error);
      addToast({ message: "利먭꺼李얘린 蹂寃쎌뿉 ?ㅽ뙣?덉뒿?덈떎." });
    }
  };

  const handleFriendHide = (friendId: string) => {
    setConfirm({
      title: "Hide this friend?",
      message: "Hidden friends can be restored later from friend management.",
      onConfirm: async () => {
        await updateFriend(friendId, { friendStatus: "hidden" });
        const existing = findDirectConvWithFriend(friendId);
        if (existing) {
          await updateConversation(existing.id, { hidden: true });
        }
      },
    });
  };

  const handleFriendBlock = (friendId: string) => {
    setConfirm({
      title: "Block this friend?",
      message: "Blocking will hide their conversations.",
      onConfirm: async () => {
        try {
          await updateFriend(friendId, { friendStatus: "blocked" });
          const existing = findDirectConvWithFriend(friendId);
          if (existing) {
            await updateConversation(existing.id, { hidden: true, blocked: true });
          }
        } catch (error) {
          console.error("Failed to block friend", error);
          addToast({ message: "Failed to block friend." });
        }
      },
    });
  };

  const handleFriendUnhide = async (friendId: string) => {
    await updateFriend(friendId, { friendStatus: "normal" });
  };

  const handleFriendUnblock = async (friendId: string) => {
    try {
      await updateFriend(friendId, { friendStatus: "normal" });
      const existing = findDirectConvWithFriend(friendId);
      if (existing) {
        await updateConversation(existing.id, { blocked: false, hidden: false });
      }
    } catch (error) {
      console.error("Failed to unblock friend", error);
      addToast({ message: "Failed to unblock friend." });
    }
  };

  const handleFriendDelete = (friendId: string) => {
    const target = friends.find((friend) => friend.id === friendId);
    if (!target) return;
    setConfirm({
      title: "Delete this friend?",
      message: "This removes the friend from your list. You can re-add them later.",
      onConfirm: async () => {
        try {
          const existing = findDirectConvWithFriend(friendId);
          if (existing) {
            await updateConversation(existing.id, { hidden: true, blocked: true });
          }
          const pskKeyId = target.friendId ?? target.id;
          await clearFriendPsk(pskKeyId);
          await deleteProfile(friendId);
          await hydrateVault();
        } catch (error) {
          console.error("Failed to delete friend", error);
          addToast({ message: "Failed to delete friend." });
        }
      },
    });
  };

  const handleCopyFriendCode = async () => {
    try {
      if (!myFriendCode) return;
      await navigator.clipboard.writeText(myFriendCode);
      addToast({ message: "移쒓뎄 肄붾뱶媛 蹂듭궗?섏뿀?듬땲??" });
    } catch (error) {
      console.error("Failed to copy friend code", error);
      addToast({ message: "移쒓뎄 肄붾뱶 蹂듭궗???ㅽ뙣?덉뒿?덈떎." });
    }
  };

  const normalizeInviteCode = (value: string) =>
    value.trim().replace(/\s+/g, "").toUpperCase();

  const computeInviteFingerprint = async (normalized: string) => {
    if (!globalThis.crypto?.subtle) {
      throw new Error("Crypto subtle is unavailable.");
    }
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(normalized)
    );
    return encodeBase64Url(new Uint8Array(digest)).slice(0, 22);
  };


  const handleCreateGroup = () => {
    setGroupCreateOpen(true);
  };

  const handleInviteToGroup = (convId: string) => {
    setGroupInviteConvId(convId);
    setGroupInviteOpen(true);
    setRightTab("about");
    setRightPanelOpen(true);
  };

  const handleSubmitGroupInvite = async (convId: string, memberIds: string[]) => {
    if (!userProfile) return { ok: false as const, error: "User profile missing." };
    const conv = convs.find((item) => item.id === convId);
    if (!conv || (conv.type !== "group" && conv.participants.length <= 2)) {
      return { ok: false as const, error: "Group not found." };
    }

    const prevParticipants = conv.participants;
    const newMembers = Array.from(new Set(memberIds)).filter(
      (id) => id && id !== userProfile.id && !prevParticipants.includes(id)
    );
    if (!newMembers.length) {
      return { ok: false as const, error: "Select at least one new member." };
    }

    try {
      const now = Date.now();
      const nextParticipants = Array.from(new Set([...prevParticipants, ...newMembers]));
      const updated: Conversation = {
        ...conv,
        participants: nextParticipants,
        hidden: false,
        lastTs: now,
        lastMessage: "Members invited",
      };
      await saveConversation(updated);

      const inviteEvent = buildGroupInviteEvent({
        groupId: conv.id,
        memberIds: newMembers,
        actorId: userProfile.id,
        ts: now,
      });
      const existingRecipients = prevParticipants.filter((id) => id && id !== userProfile.id);
      await fanoutGroupEvent(existingRecipients, inviteEvent);

      const createEvent = await syncGroupCreate({
        id: conv.id,
        name: conv.name,
        memberIds: nextParticipants,
        actorId: userProfile.id,
        ts: now,
        sharedAvatarRef: conv.sharedAvatarRef,
      });
      await fanoutGroupEvent(newMembers, createEvent, {
        allowCreateDirect: true,
        toastOnFailure: false,
      });

      await hydrateVault();
      return { ok: true as const };
    } catch (error) {
      console.error("Failed to invite group members", error);
      return { ok: false as const, error: "Failed to invite members." };
    }
  };

  const handleLeaveGroup = (convId: string) => {
    if (!userProfile) return;
    const conv = convs.find((item) => item.id === convId);
    if (!conv || (conv.type !== "group" && conv.participants.length <= 2)) return;

    setConfirm({
      title: "Leave this group?",
      message: "You will stop seeing new messages from this group.",
      onConfirm: async () => {
        try {
          const now = Date.now();
          const remaining = conv.participants.filter((id) => id && id !== userProfile.id);
          const leaveEvent = buildGroupLeaveEvent({
            groupId: conv.id,
            memberIds: [userProfile.id],
            actorId: userProfile.id,
            ts: now,
          });

          await saveConversation({
            ...conv,
            participants: remaining,
            hidden: true,
            lastTs: now,
            lastMessage: "Left group",
          });

          await fanoutGroupEvent(remaining, leaveEvent);
          await hydrateVault();
          if (ui.selectedConvId === conv.id) {
            setSelectedConv(null);
            setRightPanelOpen(false);
          }
          if (groupInviteConvId === conv.id) {
            setGroupInviteOpen(false);
            setGroupInviteConvId(null);
          }
        } catch (error) {
          console.error("Failed to leave group", error);
          addToast({ message: "Failed to leave group." });
        }
      },
    });
  };

  const handleSetGroupAvatarOverride = useCallback(
    async (convId: string, file: File | null) => {
      if (!userProfile) return;
      if (!file) {
        await setGroupAvatarOverride(convId, null);
        setGroupAvatarOverrideVersion((prev) => prev + 1);
        return;
      }
      try {
        const ownerId = `group-local:${convId}:${userProfile.id}`;
        const ref = await saveGroupPhotoRef(ownerId, file);
        await setGroupAvatarOverride(convId, ref);
        setGroupAvatarOverrideVersion((prev) => prev + 1);
      } catch (error) {
        console.error("Failed to set group avatar override", error);
        addToast({ message: "Failed to update local group image." });
      }
    },
    [addToast, userProfile]
  );

  const handleSetFriendAlias = useCallback(async (friendId: string, alias: string | null) => {
    await setFriendAlias(friendId, alias);
    setFriendAliasVersion((prev) => prev + 1);
    const nextAlias = alias?.trim() ?? "";
    setFriendAliasesById((prev) => {
      if (!nextAlias) {
        const rest = { ...prev };
        delete rest[friendId];
        return rest;
      }
      return { ...prev, [friendId]: nextAlias };
    });
  }, []);

  const handleSubmitGroup = async (payload: {
    name: string;
    memberIds: string[];
    avatarFile?: File | null;
  }) => {
    if (!userProfile) return { ok: false as const, error: "User profile missing." };

    const members = Array.from(new Set(payload.memberIds)).filter((id) => id && id !== userProfile.id);
    if (!members.length) return { ok: false as const, error: "Select at least one friend." };

    try {
      const now = Date.now();
      const convId = createId();
      let sharedAvatarRef: string | undefined;
      if (payload.avatarFile) {
        try {
          sharedAvatarRef = await saveGroupPhotoRef(convId, payload.avatarFile);
        } catch (avatarError) {
          console.error("Failed to save group avatar", avatarError);
        }
      }

      const conv: Conversation = {
        id: convId,
        type: "group",
        name: payload.name,
        pinned: false,
        unread: 0,
        hidden: false,
        muted: false,
        blocked: false,
        lastTs: now,
        lastMessage: "Group created",
        participants: [userProfile.id, ...members],
        sharedAvatarRef,
      };

      await saveConversation(conv);

      await saveMessage({
        id: createId(),
        convId: conv.id,
        senderId: userProfile.id,
        text: "Group created",
        ts: now,
      });

      const groupEvent = await syncGroupCreate({
        id: conv.id,
        name: conv.name,
        memberIds: conv.participants,
        actorId: userProfile.id,
        ts: now,
        sharedAvatarRef,
      });
      await fanoutGroupEvent(conv.participants, groupEvent, {
        allowCreateDirect: true,
        toastOnFailure: false,
      });
      await hydrateVault();

      setSelectedConv(conv.id);
      setListMode("chats");
      setListFilter("all");

      return { ok: true as const };
    } catch (error) {
      console.error("Failed to create group", error);
      return { ok: false as const, error: "Failed to create group." };
    }
  };

  const handleAddFriendLegacy = async (rawId: string) => {
    const trimmed = rawId.trim();

    if (!trimmed) {
      return { ok: false as const, error: "Enter a friend ID." };
    }
    if (!trimmed.startsWith("NCK-")) {
      return { ok: false as const, error: "Enter a valid friend ID." };
    }
    if (friends.some((friend) => friend.friendId === trimmed)) {
      return { ok: false as const, error: "Friend already added." };
    }

    try {
      const now = Date.now();
      const short = trimmed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);

      const friend: UserProfile = {
        id: createId(),
        friendId: trimmed,
        displayName: short ? `Friend ${short}` : "Friend",
        status: "Friend",
        theme: "dark",
        kind: "friend",
        friendStatus: "request_out",
        isFavorite: false,
        createdAt: now,
        updatedAt: now,
      };

      await saveProfile(friend);
      await hydrateVault();
      devLog("friend:add:success", { id: friend.id });

      return { ok: true as const };
    } catch (error) {
      console.error("Friend:add failed", error);
      return { ok: false as const, error: "Failed to add friend." };
    }
  };

  const handleAddFriend = async (payload: { code: string; psk?: string }) => {
    if (!userProfile) return { ok: false as const, error: "User profile missing." };

    const rawInput = payload.code.trim();
    const normalized = normalizeInviteCode(rawInput);
    let attemptKey = normalized || "empty";
    let inviteFingerprint: string | null = null;
    let invitePsk: Uint8Array | null = null;
    let oneTimeInvite = false;

    if (normalized.startsWith("NKI1")) {
      try {
        inviteFingerprint = await computeInviteFingerprint(normalized);
        attemptKey = `invite:${inviteFingerprint}`;
      } catch {
        return { ok: false as const, error: "Invite code invalid." };
      }
    }

    const firstGate = checkAllowed(attemptKey);
    if (!firstGate.ok) {
      const waitSeconds = Math.ceil((firstGate.waitMs ?? 0) / 1000);
      return {
        ok: false as const,
        error: `Too many attempts. Try again in ${waitSeconds}s.`,
      };
    }

    if (rawInput.startsWith("NCK-")) {
      const legacy = await handleAddFriendLegacy(rawInput);
      if (legacy.ok) {
        recordSuccess(attemptKey);
      } else {
        recordFail(attemptKey);
      }
      return legacy;
    }

    let friendCode = rawInput;
    if (normalized.startsWith("NKI1")) {
      const decodedInvite = decodeInviteCodeV1(rawInput);
      if ("error" in decodedInvite) {
        recordFail(attemptKey);
        if (decodedInvite.error.toLowerCase().includes("expired")) {
          return { ok: false as const, error: "Invite expired." };
        }
        return { ok: false as const, error: decodedInvite.error };
      }
      oneTimeInvite = Boolean(decodedInvite.oneTime);
      if (oneTimeInvite && inviteFingerprint) {
        if (await isInviteUsed(inviteFingerprint)) {
          recordFail(attemptKey);
          return { ok: false as const, error: "Invite already used." };
        }
      }
      try {
        invitePsk = decodeBase64Url(decodedInvite.psk);
      } catch {
        recordFail(attemptKey);
        return { ok: false as const, error: "Invalid invite PSK." };
      }
      friendCode = encodeFriendCodeV1(decodedInvite.friend);
    }

    const decoded = decodeFriendCodeV1(friendCode);
    if ("error" in decoded) {
      recordFail(attemptKey);
      return { ok: false as const, error: decoded.error };
    }

    const identityPubBytes = decodeBase64Url(decoded.identityPub);
    const friendId = computeFriendId(identityPubBytes);
    const finalKey = normalized.startsWith("NKI1") ? attemptKey : `friend:${friendId}`;
    if (finalKey !== attemptKey) {
      const gate = checkAllowed(finalKey);
      if (!gate.ok) {
        const waitSeconds = Math.ceil((gate.waitMs ?? 0) / 1000);
        return {
          ok: false as const,
          error: `Too many attempts. Try again in ${waitSeconds}s.`,
        };
      }
    }

    try {
      const myIdentityPub = await getIdentityPublicKey();
      if (encodeBase64Url(myIdentityPub) === decoded.identityPub) {
        recordFail(finalKey);
        return { ok: false as const, error: "You cannot add yourself." };
      }
    } catch {
      // Best-effort self-check only; continue.
    }

    try {
      const existing = friends.find(
        (friend) => friend.friendId === friendId || friend.identityPub === decoded.identityPub
      );

      const tofu = applyTOFU(
        existing?.identityPub && existing?.dhPub
          ? { identityPub: existing.identityPub, dhPub: existing.dhPub }
          : null,
        { identityPub: decoded.identityPub, dhPub: decoded.dhPub }
      );

      const now = Date.now();
      if (!tofu.ok) {
        if (existing) {
          await saveProfile({
            ...existing,
            trust: {
              pinnedAt: existing.trust?.pinnedAt ?? now,
              status: "blocked",
              reason: tofu.reason,
            },
            friendStatus: "blocked",
            updatedAt: now,
          });
          await hydrateVault();
        }
        recordFail(finalKey);
        return { ok: false as const, error: "Friend keys changed; blocked." };
      }

      const psk =
        invitePsk ?? (payload.psk?.trim() ? new TextEncoder().encode(payload.psk.trim()) : null);
      if (psk) {
        await setFriendPsk(friendId, psk);
      }

      const routingHints = sanitizeRoutingHints(
        decoded.onionAddr || decoded.lokinetAddr
          ? { onionAddr: decoded.onionAddr, lokinetAddr: decoded.lokinetAddr }
          : undefined
      );

      const short = friendId.slice(0, 6);
      const friend: UserProfile = {
        id: existing?.id ?? createId(),
        friendId,
        displayName: existing?.displayName ?? (short ? `Friend ${short}` : "Friend"),
        status: existing?.status ?? "Friend",
        theme: existing?.theme ?? "dark",
        kind: "friend",
        friendStatus: existing?.friendStatus ?? "request_out",
        isFavorite: existing?.isFavorite ?? false,
        identityPub: decoded.identityPub,
        dhPub: decoded.dhPub,
        routingHints,
        trust: { pinnedAt: existing?.trust?.pinnedAt ?? now, status: "trusted" },
        pskHint: Boolean(psk) || existing?.pskHint,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      await saveProfile(friend);
      await hydrateVault();
      devLog("friend:add:success", { id: friend.id, friendId });

      if (oneTimeInvite && inviteFingerprint) {
        await markInviteUsed(inviteFingerprint);
      }

      recordSuccess(finalKey);
      return { ok: true as const };
    } catch (error) {
      console.error("Friend:add failed", error);
      recordFail(finalKey);
      return { ok: false as const, error: "Failed to add friend." };
    }
  };

  const currentConversation = ui.selectedConvId
    ? convs.find((conv) => conv.id === ui.selectedConvId) || null
    : null;
  const currentMessages = currentConversation ? messagesByConv[currentConversation.id] || [] : [];
  const currentTransportStatus = currentConversation
    ? transportStatusByConv[currentConversation.id] ??
      getTransportStatus(currentConversation.id)
    : null;
  const groupInviteConversation = groupInviteConvId
    ? convs.find((conv) => conv.id === groupInviteConvId) || null
    : null;
  const groupInviteExistingMemberIds = groupInviteConversation?.participants ?? [];

  const nameMap = useMemo(
    () =>
      buildNameMap(
        [...(friends || []), ...(userProfile ? [userProfile] : [])],
        friendAliasesById
      ),
    [friendAliasesById, friends, userProfile]
  );

  const profilesById = useMemo(() => {
    const map: Record<string, UserProfile> = {};
    friends.forEach((friend) => {
      map[friend.id] = friend;
    });
    if (userProfile) {
      map[userProfile.id] = userProfile;
    }
    return map;
  }, [friends, userProfile]);

  useEffect(() => {
    let active = true;
    const groupConvs = convs.filter(
      (conv) => conv.type === "group" || conv.participants.length > 2
    );
    if (!groupConvs.length) {
      setGroupAvatarOverrides({});
      return () => {
        active = false;
      };
    }
    const load = async () => {
      const entries = await Promise.all(
        groupConvs.map(async (conv) => [conv.id, await getGroupAvatarOverride(conv.id)] as const)
      );
      if (!active) return;
      setGroupAvatarOverrides(Object.fromEntries(entries));
    };
    void load();
    return () => {
      active = false;
    };
  }, [convs, groupAvatarOverrideVersion]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const map = await listFriendAliases();
      if (!active) return;
      setFriendAliasesById(map);
    };
    void load();
    return () => {
      active = false;
    };
  }, [friendAliasVersion]);

  const groupAvatarRefsByConv = useMemo(() => {
    const map: Record<string, ReturnType<typeof parseAvatarRef>> = {};
    convs.forEach((conv) => {
      const resolved = resolveGroupAvatarRef(conv, groupAvatarOverrides[conv.id]);
      if (resolved) {
        map[conv.id] = resolved;
      }
    });
    return map;
  }, [convs, groupAvatarOverrides]);

  const currentGroupAvatarRef = currentConversation
    ? groupAvatarRefsByConv[currentConversation.id]
    : undefined;
  const currentGroupAvatarOverrideRef = currentConversation
    ? groupAvatarOverrides[currentConversation.id] ?? null
    : null;
  useEffect(() => {
    const prev = activeSyncConvRef.current;
    if (prev && prev !== ui.selectedConvId) {
      void disconnectSyncConversation(prev);
    }

    if (!ui.selectedConvId || !userProfile) {
      activeSyncConvRef.current = null;
      return;
    }

    const conv = convs.find((item) => item.id === ui.selectedConvId);
    if (!conv) return;
    const isDirect =
      !(conv.type === "group" || conv.participants.length > 2) && conv.participants.length === 2;
    if (!isDirect) return;

    const partnerId = conv.participants.find((id) => id && id !== userProfile.id) || null;
    const partner = partnerId ? friends.find((friend) => friend.id === partnerId) || null : null;
    if (!partner?.identityPub || !partner.dhPub) return;

    void connectSyncConversation(conv.id, {
      friendKeyId: partner.friendId ?? partner.id,
      identityPub: partner.identityPub,
      dhPub: partner.dhPub,
      onionAddr: partner.routingHints?.onionAddr,
      lokinetAddr: partner.routingHints?.lokinetAddr,
    });
    activeSyncConvRef.current = conv.id;
  }, [ui.selectedConvId, convs, friends, userProfile]);

  const partnerProfile = useMemo(() => {
    if (!currentConversation) return null;
    const isGroup =
      currentConversation.type === "group" || currentConversation.participants.length > 2;
    if (isGroup) return null;
    const partnerId = currentConversation.participants.find((id) => id !== userProfile?.id);
    return friends.find((friend) => friend.id === partnerId) || null;
  }, [currentConversation, friends, userProfile]);

  const currentTrustState = useMemo(() => {
    if (!partnerProfile) return "UNVERIFIED" as TrustState;
    return trustByFriendId[partnerProfile.id]?.trustState ?? "UNVERIFIED";
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
    if (trustRecord?.trustState === "KEY_CHANGED") return;

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
  }, [currentConversation, currentTransportStatus, partnerProfile, trustByFriendId]);

  const currentConversationDisplayName = useMemo(() => {
    if (!currentConversation) return "대화를 선택해주세요.";
    const isGroup =
      currentConversation.type === "group" || currentConversation.participants.length > 2;
    if (isGroup) return currentConversation.name;
    return resolveFriendDisplayName(partnerProfile ?? undefined, friendAliasesById);
  }, [currentConversation, friendAliasesById, partnerProfile]);

  const handleAcceptRequest = async () => {
    if (!currentConversation || !partnerProfile) return;
    try {
      await updateFriend(partnerProfile.id, { friendStatus: "normal" });
      await updateConversation(currentConversation.id, { hidden: false, pendingAcceptance: false });
    } catch (error) {
      console.error("Failed to accept request", error);
      addToast({ message: "硫붿떆吏 ?붿껌 ?섎씫???ㅽ뙣?덉뒿?덈떎." });
    }
  };

  const handleDeclineRequest = async () => {
    if (!currentConversation || !partnerProfile) return;
    try {
      await updateFriend(partnerProfile.id, { friendStatus: "blocked" });
      await updateConversation(currentConversation.id, {
        hidden: true,
        pendingAcceptance: false,
      });
    } catch (error) {
      console.error("Failed to decline request", error);
      addToast({ message: "硫붿떆吏 ?붿껌 嫄곗젅???ㅽ뙣?덉뒿?덈떎." });
    }
  };

  if (ui.mode === "onboarding") {
    return (
      <>
        <Onboarding
          onCreate={handleCreate}
          onUnlockWithStartKey={handleStartKeyUnlock}
          defaultTab={defaultTab}
          errorMessage={onboardingError}
        />
        <Toasts />
      </>
    );
  }

  const appShell = (
    <div className="flex h-full gap-6 bg-nkc-bg p-6">
      <Sidebar
        convs={convs}
        friends={friends}
        userId={userProfile?.id || null}
        userProfile={userProfile}
        groupAvatarRefsByConv={groupAvatarRefsByConv}
        friendAliasesById={friendAliasesById}
        selectedConvId={ui.selectedConvId}
        listMode={ui.listMode}
        listFilter={ui.listFilter}
        search={ui.search}
        onSearch={setSearch}
        onSelectConv={handleSelectConv}
        onAddFriend={() => setFriendAddOpen(true)}
        onCreateGroup={handleCreateGroup}
        onFriendChat={handleFriendChat}
        onFriendViewProfile={handleFriendViewProfile}
        onFriendToggleFavorite={handleFriendToggleFavorite}
        onFriendHide={handleFriendHide}
        onFriendDelete={handleFriendDelete}
        onFriendBlock={handleFriendBlock}
        onSetFriendAlias={handleSetFriendAlias}
        onListModeChange={setListMode}
        onListFilterChange={setListFilter}
        onSettings={() => navigate("/settings")}
        onLock={handleLock}
        onHide={handleHide}
        onDelete={handleDelete}
        onTogglePin={handleTogglePin}
        onMute={handleMute}
        onBlock={handleBlock}
      />

      <ChatView
        conversation={currentConversation}
        conversationDisplayName={currentConversationDisplayName}
        transportStatus={currentTransportStatus}
        messages={currentMessages}
        currentUserId={userProfile?.id || null}
        nameMap={nameMap}
        profilesById={profilesById}
        isComposing={ui.isComposing}
        onComposingChange={setIsComposing}
        onSend={handleSendMessage}
        onSendMedia={handleSendMedia}
        onSendReadReceipt={handleSendReadReceipt}
        onAcceptRequest={handleAcceptRequest}
        onDeclineRequest={handleDeclineRequest}
        onBack={() => {
          setSelectedConv(null);
          setRightPanelOpen(false);
        }}
        onToggleRight={() => setRightPanelOpen(!ui.rightPanelOpen)}
        rightPanelOpen={ui.rightPanelOpen}
      />

      <RightPanel
        open={ui.rightPanelOpen}
        tab={ui.rightTab}
        onTabChange={setRightTab}
        conversation={currentConversation}
        friendProfile={partnerProfile}
        currentUserId={userProfile?.id ?? null}
        profilesById={profilesById}
        groupAvatarRef={currentGroupAvatarRef}
        groupAvatarOverrideRef={currentGroupAvatarOverrideRef}
        friendAliasesById={friendAliasesById}
        trustState={currentTrustState}
        onOpenSettings={() => navigate("/settings")}
        onInviteToGroup={handleInviteToGroup}
        onLeaveGroup={handleLeaveGroup}
        onSetGroupAvatarOverride={handleSetGroupAvatarOverride}
        onToggleMute={handleMute}
        onTogglePin={handleTogglePin}
        onHideConversation={handleHide}
        onToggleBlock={handleBlock}
      />

      {userProfile ? (
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={(open) => {
            if (!open) navigate("/");
          }}
          user={userProfile}
          onSaveProfile={handleSaveProfile}
          onUploadPhoto={handleUploadPhoto}
          onLock={handleLock}
          pinEnabled={pinEnabled}
          onSetPin={handleSetPin}
          onDisablePin={handleDisablePin}
          onRotateStartKey={handleRotateStartKey}
          hiddenFriends={friends.filter((friend) => friend.friendStatus === "hidden")}
          blockedFriends={friends.filter((friend) => friend.friendStatus === "blocked")}
          onUnhideFriend={handleFriendUnhide}
          onUnblockFriend={handleFriendUnblock}
          onLogout={() =>
            setConfirm({
              title: "濡쒓렇?꾩썐?좉퉴??",
              message: "?몄뀡??醫낅즺?섍퀬 濡쒖뺄 ?곗씠?곕뒗 ?좎??⑸땲??",
              onConfirm: handleLogout,
            })
          }
          onWipe={() =>
            setConfirm({
              title: "?곗씠?곕? ??젣?좉퉴??",
              message: "濡쒖뺄 湲덇퀬媛 珥덇린?붾맗?덈떎.",
              onConfirm: async () => {
                await clearStoredSession();
                await wipeVault();
                window.location.reload();
              },
            })
          }
        />
      ) : null}

      {userProfile ? (
        <FriendAddDialog
          open={friendAddOpen}
          onOpenChange={setFriendAddOpen}
          myCode={myFriendCode}
          onCopyCode={handleCopyFriendCode}
          onAdd={handleAddFriend}
        />
      ) : null}

      {userProfile ? (
        <GroupInviteDialog
          open={groupInviteOpen && Boolean(groupInviteConversation)}
          onOpenChange={(open) => {
            setGroupInviteOpen(open);
            if (!open) setGroupInviteConvId(null);
          }}
          friends={friends}
          existingMemberIds={groupInviteExistingMemberIds}
          onSubmit={(memberIds) =>
            groupInviteConversation
              ? handleSubmitGroupInvite(groupInviteConversation.id, memberIds)
              : Promise.resolve({ ok: false as const, error: "Group not found." })
          }
        />
      ) : null}

      {userProfile ? (
        <GroupCreateDialog
          open={groupCreateOpen}
          onOpenChange={setGroupCreateOpen}
          friends={friends}
          onCreate={handleSubmitGroup}
        />
      ) : null}
    </div>
  );

  return (
    <>
      <Routes>
        <Route
          path="/unlock"
          element={ui.mode === "locked" ? <Unlock onUnlock={handlePinUnlock} /> : <Navigate to="/" replace />}
        />
        <Route
          path="/start-key"
          element={
            ui.mode === "app" ? (
              <StartKey
                onRotate={handleRotateStartKey}
                onDone={() => navigate("/settings")}
              />
            ) : (
              <Navigate to="/unlock" replace />
            )
          }
        />
        <Route path="/settings" element={ui.mode === "app" ? appShell : <Navigate to="/unlock" replace />} />
        <Route path="/*" element={ui.mode === "app" ? appShell : <Navigate to="/unlock" replace />} />
      </Routes>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title || ""}
        message={confirm?.message || ""}
        onConfirm={() => {
          // confirm?.onConfirm()??Promise瑜?諛섑솚?대룄 UI??void 泥섎━
          void confirm?.onConfirm?.();
        }}
        onClose={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={directApprovalOpen}
        title="Direct ?곌껐 ?덉슜"
        message="Direct ?곌껐? ?곷?諛⑹뿉寃?IP媛 ?몄텧?????덉뒿?덈떎. ?덉슜?좉퉴??"
        onConfirm={() => resolveDirectApproval(true)}
        onClose={() => resolveDirectApproval(false)}
      />

      <Toasts />
    </>
  );
}














