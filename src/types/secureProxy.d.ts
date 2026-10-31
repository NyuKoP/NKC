import type { MainAccountSession } from "../accounts/mainSessionTypes";
export {};

type P2PConnectionStatusPayload = {
  convId: string;
  state: "idle" | "connecting" | "connected" | "reconnecting" | "closed";
  detail?: string;
  changedAt?: number;
};

type P2PChatMessagePayload = {
  id: string;
  convId: string;
  ts: number;
  createdAt?: number;
  senderId: string;
  text: string;
  status?: "PENDING" | "SENT" | "FAILED";
  clientBatchId?: string;
  kind?: string;
};

type P2PChatMessageEventPayload =
  | {
      type: "MESSAGE_RECEIVED" | "MESSAGE_ACK";
      message: P2PChatMessagePayload;
    }
  | {
      type: "MESSAGE_FAILED";
      messageId: string;
      error?: string;
    };

declare global {
  interface Window {
    nkcExperimental?: { readonly unifiedText: boolean; readonly recoveryV2?: boolean; readonly nativeRatchetCas?: boolean; readonly freshnessWitness?: boolean;
      readonly preflight?: { status: () => Promise<"needs_prepare" | "restart_required" | "verified" | "interrupted" | "source_unreadable">;
        prepare: () => Promise<"restart_required"> } };
    electron?: {
      secureStorage: {
        isAvailable: () => Promise<boolean>;
        get: (key: string) => Promise<string | null>;
        set: (key: string, value: string) => Promise<boolean>;
        remove: (key: string) => Promise<boolean>;
        removeAccount: (accountId: string, session?: import("../accounts/mainSessionTypes").MainAccountSession) => Promise<boolean>;
        getOwned: (session: import("../accounts/mainSessionTypes").MainAccountSession, key: string) => Promise<string | null>;
        setOwned: (session: import("../accounts/mainSessionTypes").MainAccountSession, key: string, value: string, expected?: { value: string | null }) => Promise<boolean>;
        removeOwned: (session: import("../accounts/mainSessionTypes").MainAccountSession, key: string) => Promise<boolean>;
        ratchetSnapshot: (accountId: string, channel: string, version: 1 | 2) => Promise<{
          value: string | null; revision: number; fingerprint: string | null;
        }>;
        ratchetCommit: (request: { accountId: string; channel: string; version: 1 | 2;
          expectedRevision: number; expectedFingerprint: string | null; nextValue: string }) => Promise<{
          value: string; revision: number; fingerprint: string;
        }>;
      };
      p2p?: {
        getMessages?: (conversationId: string) => Promise<P2PChatMessagePayload[]>;
        sendMessage?: (payload: {
          conversationId: string;
          message: P2PChatMessagePayload;
        }) => Promise<P2PChatMessagePayload | void>;
        onMessageEvent?: (
          conversationId: string,
          cb: (payload: P2PChatMessageEventPayload) => void
        ) => () => void;
      };
    };
    secureProxy?: {
      applyProxy: (payload: {
        proxyUrl: string;
        enabled: boolean;
        allowRemote: boolean;
      }) => Promise<void>;
      checkProxy: () => Promise<{ ok: boolean; message: string }>;
    };
    onion?: {
      install: (payload: { network: "tor" }) => Promise<void>;
      uninstall: (payload: { network: "tor" }) => Promise<void>;
      setMode: (payload: { enabled: boolean; network: "tor" }) => Promise<void>;
      status: () => Promise<unknown>;
      checkUpdates: () => Promise<unknown>;
      applyUpdate: (payload: { network: "tor" }) => Promise<void>;
      onProgress: (cb: (payload: unknown) => void) => () => void;
    };
    nkc?: {
      compareRollbackHint?: (session: import("../accounts/mainSessionTypes").MainAccountSession, root: string,
        certificates: import("../devices/deviceAuthorization").DeviceAuthorization[]) => Promise<import("../main/freshness/rollbackHint").RollbackHintState>;
      verifyAuthorityFreshness?: (session: import("../accounts/mainSessionTypes").MainAccountSession,
        head: import("../main/freshness/freshnessAuthority").LocalAuthorityHead,
        record?: import("../main/freshness/witnessProtocol").SignedTransition) => Promise<{
          state: import("../main/freshness/freshnessAuthority").FreshnessState;
          response: import("../main/freshness/witnessProtocol").WitnessResponse;
        }>;
      setOnionForwardProxy?: (proxyUrl: string | null) => Promise<{ ok: boolean }>;
      activateAccountSession?: (accountId: string) => Promise<import("../accounts/mainSessionTypes").MainAccountSession>;
      revokeAccountSession?: () => Promise<void>;
      flushAccountStorage?: (session: import("../accounts/mainSessionTypes").MainAccountSession) => Promise<void>;
      validateAccountSession?: (session: import("../accounts/mainSessionTypes").MainAccountSession) => Promise<boolean>;
      verifyOnionInboxRetention?: (session: import("../accounts/mainSessionTypes").MainAccountSession, mailboxDeviceId: string, operationId: string, recipientAccount?: string) => Promise<boolean>;
      acknowledgeOnionInboxItems?: (session: import("../accounts/mainSessionTypes").MainAccountSession, mailboxDeviceId: string, itemIds: string[]) => Promise<boolean>;
      confirmOnionApplicationReceipt?: (session: import("../accounts/mainSessionTypes").MainAccountSession, messageId: string, ciphertext: string | Uint8Array) => Promise<boolean>;
      cancelOnionApplicationRetry?: (session: import("../accounts/mainSessionTypes").MainAccountSession, messageId: string, ciphertext: string | Uint8Array) => Promise<boolean>;
      supersedeOnionApplicationRetry?: (session: import("../accounts/mainSessionTypes").MainAccountSession, messageId: string, ciphertext: string | Uint8Array) => Promise<boolean>;
      revokeOnionDevice?: (session: import("../accounts/mainSessionTypes").MainAccountSession, deviceId: string) => Promise<boolean>;
      permanentMedia?: (session: import("../accounts/mainSessionTypes").MainAccountSession,
        request: import("../media/permanentMediaTypes").PermanentMediaRequest) => Promise<import("../media/permanentMediaTypes").PermanentMediaResult>;
      nativeQueueInstance?: (session: import("../accounts/mainSessionTypes").MainAccountSession) => Promise<string | undefined>;
      onionControllerFetch?: (request: { receiveSession?: import("../accounts/mainSessionTypes").MainAccountSession;
        url: string; method: string; headers?: Record<string, string>; bodyBase64?: string; timeoutMs?: number;
        bodyPayload?: import("../main/onionController").OnionSendPayload; binaryInbox?: boolean;
      }) => Promise<{ status: number; bodyBase64: string; bodyPayload?: import("../net/onionInboxClient").PollResponse }>;
      coldStartEnabled?: boolean;
      recordColdStartMetric?: (metric: import("../diagnostics/coldStartMetrics").RendererColdMetric) => Promise<void>;
      getOnionControllerUrl?: () => Promise<string>;
      registerOnionMailbox?: (deviceId: string, session?: import("../accounts/mainSessionTypes").MainAccountSession) => Promise<{
        ok: boolean;
        inboxWriteToken?: string;
        error?: string;
      }>;
      unregisterOnionMailbox?: (deviceId: string, session?: import("../accounts/mainSessionTypes").MainAccountSession) => Promise<{
        ok: boolean;
        error?: string;
      }>;
      [key: string]: unknown;
    };
    prefs?: {
      get: () => Promise<unknown>;
      set: (patch: unknown) => Promise<unknown>;
    };
    appControls?: {
      show: () => Promise<void>;
      hide: () => Promise<void>;
      quit: () => Promise<void>;
      syncNow: () => Promise<void>;
      reportSyncResult: (payload: {
        requestId: string;
        ok: boolean;
        error?: string;
      }) => void;
      onSyncRun: (
        cb: (payload: { requestId: string; reason: "manual" | "interval" }) => void
      ) => () => void;
      onSyncStatus: (cb: (payload: unknown) => void) => () => void;
      onBackgroundStatus: (cb: (payload: unknown) => void) => () => void;
    };
    p2p?: {
      onConnectionStatus: (
        cb: (payload: P2PConnectionStatusPayload) => void
      ) => () => void;
      getMessages?: (conversationId: string) => Promise<P2PChatMessagePayload[]>;
      sendMessage?: (payload: {
        conversationId: string;
        message: P2PChatMessagePayload;
      }) => Promise<P2PChatMessagePayload | void>;
      onMessageEvent?: (
        conversationId: string,
        cb: (payload: P2PChatMessageEventPayload) => void
      ) => () => void;
    };
    p2pQueue?: {
      phase2iTestProxy: (url: string, nonblockingWake?: boolean) => Promise<{ ok: boolean }>;
      list: (accountId: string, session: MainAccountSession) => Promise<{ ok: boolean; messages?: Array<{
        id: string; payload: string; status: string; attempts?: number; nextAttemptAt?: number; lastError?: string;
      }> }>;
      flushNow: (accountId: string, session: MainAccountSession) => Promise<{ ok: boolean }>;
      handoffUnified: (payload: { accountId: string; id: string; friendId: string;
        onionAddress: string; inboxWriteToken: string; payload: string }, session: MainAccountSession) => Promise<{
        ok: boolean; status?: string; error?: string;
      }>;
      setActiveAccount: (accountId: string, session: MainAccountSession) => Promise<{ ok: boolean; error?: string }>;
      removeAccount: (accountId: string, managementSession: MainAccountSession) => Promise<{ ok: boolean; error?: string }>;
      clearPending: (accountId: string, session: MainAccountSession) => Promise<{
        ok: boolean;
        removed: number;
        error?: string;
      }>;
    };
    nativeWorker?: {
      inspectFile: (
        file: File,
        chunkSize: number
      ) => Promise<{
        ok: boolean;
        error?: string;
        result?: { size: number; chunkSize: number; total: number; sha256: string };
      }>;
      readFileChunk: (
        file: File,
        index: number,
        chunkSize: number
      ) => Promise<{
        ok: boolean;
        error?: string;
        result?: { index: number; bytes: number; data: Uint8Array };
      }>;
      receiveInit: (payload: {
        transferId: string; fileName: string; fileSize: number; chunkSize: number;
        totalChunks: number; sha256: string;
      }) => Promise<{ ok: boolean; error?: string; result?: { receivedChunks: number; totalChunks: number; complete: boolean } }>;
      receiveWrite: (payload: { transferId: string; index: number; data: string | Uint8Array }) => Promise<{ ok: boolean; error?: string; result?: { duplicate: boolean; checkpointed: boolean } }>;
      receiveCheckpoint: (transferId: string) => Promise<{ ok: boolean; error?: string; result?: unknown }>;
      receiveFinalize: (transferId: string) => Promise<{ ok: boolean; error?: string; result?: { path: string; sha256: string } }>;
      receiveAbort: (transferId: string) => Promise<{ ok: boolean; error?: string; result?: unknown }>;
      planDelivery: (payload: unknown) => Promise<{
        ok: boolean;
        error?: string;
        result?: {
          selected: Array<{ id: string; attempts: number; nextAttemptAtMs: number }>;
        };
      }>;
    };
    testLog?: {
      append: (payload: { channel: string; event: unknown; at?: string }) => Promise<{
        ok: boolean;
        path: string;
      }>;
      getPath: () => Promise<string>;
      getFriendFlowPath: () => Promise<string>;
    };
  }
}
