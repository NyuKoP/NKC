declare global {
  var __nkcLocalSessionCounters: (() => Record<string, number>) | undefined;
}

// Disposable local observation only: fixed counters, no payloads, callbacks or diagnostic transport.
const stages = ["poll", "decode", "owner", "dispatcher", "authority", "signature", "freshness", "control", "HELLO", "ACK", "SESSION_READY", "offer", "candidate", "ready", "commit", "lock", "transport", "hello-publish", "sync-conversation", "sync-global", "observation", "transport-close", "transport-approval", "adapter-start", "tor-ready", "tor-status", "tor-proxy", "tor-forward-proxy", "controller-url", "mailbox", "reply-route", "controller-health", "controller-ingest", "inbox-store", "main-inbox", "tor-start-join", "main-poll", "candidate-expire", "candidate-replace", "candidate-disconnect", "candidate-promote", "outbox-dispatch"] as const;

const outcomes = ["input", "success", "rejected", "deferred", "retry", "duplicate", "error", "missing", "reply", "binding"] as const;

type Stage = typeof stages[number];

type Outcome = typeof outcomes[number];

let enabled = false;

const counters = new Map<string, number>();

const reasons = new Set(["OWNER_REQUIRED", "OWNER_SESSION_CHANGED", "DEVICE_AUTHORITY_CHANGED", "DEVICE_AUTHORIZATION_REQUIRED",
  "CONTROL_AUTHENTICATION_REJECTED", "CONTROL_SCOPE_REJECTED", "CONTROL_REPLY_REJECTED", "CONTROL_PEER_BINDING_UNAVAILABLE",
  "FRESH_SESSION_REQUIRED", "FRIEND_AUTHENTICATION_REQUIRED", "HELLO_REJECTED", "ACK_REJECTED", "SYNC_REQ_REJECTED",
  "TOR_START_TIMEOUT", "TOR_START_ABORTED", "TOR_NOT_READY", "FRIEND_RECEIVE_FAILED",
  "ACK_PENDING_MISSING", "ACK_NONCE_MISMATCH", "ACK_EXPIRED", "ACK_IDENTITY_MISMATCH", "ACK_SIGNATURE_INVALID",
  "ACK_OFFER_MISMATCH", "ACK_CONFIRMATION_INVALID", "MEDIA_RECEIPT_VALIDATION_REJECTED", "MEDIA_RECEIPT_COMMIT_REJECTED"]);

const outcomeNames = { input: "INPUT", success: "ACCEPT", rejected: "REJECT", deferred: "DEFER", duplicate: "DUPLICATE",
  retry: "RETRY", error: "REJECT", missing: "MISSING", reply: "REPLY", binding: "BINDING" } as const;

export const countSessionStage = (stage: Stage, outcome: Outcome, count = 1) => {
  if (!enabled || !stages.includes(stage) || !outcomes.includes(outcome) || !Number.isSafeInteger(count) || count < 0) return;
  const key = `${stage}:${stage === "commit" && outcome === "success" ? "COMMIT" : outcomeNames[outcome]}`;
  counters.set(key, Math.min(Number.MAX_SAFE_INTEGER, (counters.get(key) ?? 0) + count));
};

export const beginSessionInvestigation = () => { counters.clear(); enabled = true; countSessionStage("observation", "success"); };

export const readSessionInvestigation = () => Object.fromEntries(counters);

export const countSessionReason = (code: string) => {
  if (!enabled || !reasons.has(code)) return;
  const key = `reason:${code}`;
  counters.set(key, Math.min(Number.MAX_SAFE_INTEGER, (counters.get(key) ?? 0) + 1));
};
