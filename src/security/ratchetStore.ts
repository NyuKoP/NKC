import { decodeBase64Url, encodeBase64Url } from "./base64url";
import { getSecretStore, type SecretStore } from "./secretStore";
import type { DhRatchetStateV2, RatchetStateV1 } from "../crypto/ratchet";
import { isUnifiedTextChannel } from "../sync/unifiedAppPolicy";
import { getActiveAccountId } from "../accounts/accountRegistry";
import { getAccountOwnerGeneration } from "../accounts/accountOwnerLifecycle";

const RATCHET_PREFIX = "nkc_ratchet_v1:";

const DH_RATCHET_PREFIX = "nkc_ratchet_v2:";

export const nativeRatchetCasEnabled = () => typeof window !== "undefined" && window.nkcExperimental?.nativeRatchetCas === true;

export type OwnedRatchetSnapshot<T> = {
  state: T | null; revision: number; fingerprint: string | null;
  accountId: string; generation: number;
};

const validCounter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const readKey = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("RATCHET_STATE_INVALID");
  const bytes = decodeBase64Url(value);

  if (bytes.length !== 32 || encodeBase64Url(bytes) !== value) throw new Error("RATCHET_STATE_INVALID");

  return bytes;
};

const getSecret = async (key: string, store: SecretStore = getSecretStore()) => {
  if (isUnifiedTextChannel(key.replace(/^nkc_ratchet_v[12]:/, ""))) throw new Error("UNIFIED_OWNER_REQUIRED");

  return store.get(key);
};

const setSecret = async (key: string, value: string, store: SecretStore = getSecretStore(), expected?: string | null) => {
  if (isUnifiedTextChannel(key.replace(/^nkc_ratchet_v[12]:/, ""))) throw new Error("UNIFIED_OWNER_REQUIRED");

  if (store.conditionalWrites && expected !== undefined) await store.set(key, value, { value: expected });
  else await store.set(key, value);
};

const removeSecret = async (key: string, store: SecretStore = getSecretStore()) => {
  if (isUnifiedTextChannel(key.replace(/^nkc_ratchet_v[12]:/, ""))) throw new Error("UNIFIED_OWNER_REQUIRED");
  await store.remove(key);
};

const parsePendingReceiveCommits = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50 || new Set(value).size !== value.length) throw new Error("RATCHET_STATE_INVALID");
  for (const fingerprint of value) readKey(fingerprint);
  return value;
};

const parseRatchetState = (raw: string | null): RatchetStateV1 | null => {
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || !("sendI" in parsed) || !validCounter(parsed.sendI) ||
        !("recvI" in parsed) || !validCounter(parsed.recvI) || !("ck" in parsed)) {
      throw new Error("RATCHET_STATE_INVALID");
    }

    return {
      ck: readKey(parsed.ck),
      sendI: parsed.sendI,
      recvI: parsed.recvI,
      ...("pendingReceiveCommits" in parsed ? { pendingReceiveCommits: parsePendingReceiveCommits(parsed.pendingReceiveCommits) } : {}),
    };
  } catch {
    throw new Error("RATCHET_STATE_INVALID");
  }
};

export const getRatchetState = async (convId: string, store: SecretStore = getSecretStore()): Promise<RatchetStateV1 | null> =>
  parseRatchetState(await getSecret(`${RATCHET_PREFIX}${convId}`, store));

export const readRatchetSnapshot = async (convId: string, store: SecretStore) => {
  const value = await getSecret(`${RATCHET_PREFIX}${convId}`, store);

  return { value, state: parseRatchetState(value) };
};

const serializeRatchetState = (state: RatchetStateV1) => JSON.stringify({
  ck: encodeBase64Url(state.ck), sendI: state.sendI, recvI: state.recvI,
  ...(state.pendingReceiveCommits?.length ? { pendingReceiveCommits: state.pendingReceiveCommits } : {}),
});

export const setRatchetState = async (convId: string, state: RatchetStateV1, store: SecretStore = getSecretStore(), expected?: string | null) => {
  await setSecret(`${RATCHET_PREFIX}${convId}`, serializeRatchetState(state), store, expected);
};

export const clearRatchetState = async (convId: string, store: SecretStore = getSecretStore()) => {
  await removeSecret(`${RATCHET_PREFIX}${convId}`, store);
};

const parseDhRatchetState = (raw: string | null): DhRatchetStateV2 | null => {
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as {
      v: 2;
      rk: string;
      dhSelfPriv: string;
      dhSelfPub: string;
      dhRemotePub?: string | null;
      sendCk: string;
      sendI: number;
      recvCk: string;
      recvI: number;
      pn?: number;
      mode?: "sym" | "dh";
      retained?: Array<{ chain: string; index: number; key: string; expiresAt: number }>;
      pendingReceiveCommits?: unknown;
      pendingSendCommits?: unknown;
    };

    if (
      parsed?.v !== 2 ||
      !parsed.rk ||
      !parsed.dhSelfPriv ||
      !parsed.dhSelfPub ||
      !parsed.sendCk ||
      !parsed.recvCk ||
      !validCounter(parsed.sendI) ||
      !validCounter(parsed.recvI) ||
      (parsed.pn !== undefined && !validCounter(parsed.pn)) ||
      (parsed.mode !== undefined && parsed.mode !== "sym" && parsed.mode !== "dh")
    ) {
      throw new Error("RATCHET_STATE_INVALID");
    }

    if (parsed.retained !== undefined && (!Array.isArray(parsed.retained) || parsed.retained.length > 50 ||
      parsed.retained.some(item => !item || !/^(sym|dh):[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}$/.test(item.chain) ||
        !validCounter(item.index) || !validCounter(item.expiresAt)) ||
      new Set(parsed.retained.map(item => item.chain)).size > 4 ||
      new Set(parsed.retained.map(item => `${item.chain}:${item.index}`)).size !== parsed.retained.length)) throw new Error("RATCHET_STATE_INVALID");

    const state: DhRatchetStateV2 = {
      v: 2,
      rk: readKey(parsed.rk),
      dhSelfPriv: readKey(parsed.dhSelfPriv),
      dhSelfPub: readKey(parsed.dhSelfPub),
      dhRemotePub: parsed.dhRemotePub === undefined || parsed.dhRemotePub === null ? null : readKey(parsed.dhRemotePub),
      sendCk: readKey(parsed.sendCk),
      sendI: parsed.sendI,
      recvCk: readKey(parsed.recvCk),
      recvI: parsed.recvI,
      pn: parsed.pn,
      mode: parsed.mode ?? "sym",
      ...(parsed.pendingReceiveCommits !== undefined ? { pendingReceiveCommits: parsePendingReceiveCommits(parsed.pendingReceiveCommits) } : {}),
      ...(parsed.retained?.length ? { retained: parsed.retained.map(item => ({ ...item, key: readKey(item.key) })) } : {}),
    };

    if (parsed.pendingSendCommits !== undefined) state.pendingSendCommits = parsePendingReceiveCommits(parsed.pendingSendCommits);

    return state;
  } catch {
    throw new Error("RATCHET_STATE_INVALID");
  }
};

export const getDhRatchetState = async (convId: string, store: SecretStore = getSecretStore()): Promise<DhRatchetStateV2 | null> =>
  parseDhRatchetState(await getSecret(`${DH_RATCHET_PREFIX}${convId}`, store));

export const readDhRatchetSnapshot = async (convId: string, store: SecretStore) => {
  const value = await getSecret(`${DH_RATCHET_PREFIX}${convId}`, store);

  return { value, state: parseDhRatchetState(value) };
};

const serializeDhRatchetState = (state: DhRatchetStateV2) => JSON.stringify({
  v: 2,
  rk: encodeBase64Url(state.rk),
  dhSelfPriv: encodeBase64Url(state.dhSelfPriv),
  dhSelfPub: encodeBase64Url(state.dhSelfPub),
  dhRemotePub: state.dhRemotePub ? encodeBase64Url(state.dhRemotePub) : null,
  sendCk: encodeBase64Url(state.sendCk),
  sendI: state.sendI,
  recvCk: encodeBase64Url(state.recvCk),
  recvI: state.recvI,
  pn: state.pn,
  mode: state.mode,
  ...(state.pendingReceiveCommits?.length ? { pendingReceiveCommits: state.pendingReceiveCommits } : {}),
  ...(state.retained?.length ? { retained: state.retained.map(item => ({ ...item, key: encodeBase64Url(item.key) })) } : {}),
  pendingSendCommits: state.pendingSendCommits?.length ? state.pendingSendCommits : undefined,
});

export const fingerprintRatchetState = async (state: RatchetStateV1 | DhRatchetStateV2) => encodeBase64Url(new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode("v" in state
    ? serializeDhRatchetState({ ...state, pendingReceiveCommits: undefined, pendingSendCommits: undefined })
    : serializeRatchetState({ ...state, pendingReceiveCommits: undefined })))));

export const hasReceiveCommit = async (convId: string, version: 1 | 2, fingerprint: string, store: SecretStore) => {
  const state = version === 2 ? await getDhRatchetState(convId, store) : await getRatchetState(convId, store);

  return Boolean(state && (state.pendingReceiveCommits?.includes(fingerprint) || await fingerprintRatchetState(state) === fingerprint));
};

/** The DB crypto marker must be durable before retiring this secret-owned proof. */
export const acknowledgeReceiveCommit = async (convId: string, version: 1 | 2, fingerprint: string, store: SecretStore) => {
  if (!store.conditionalWrites) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { value, state } = version === 2 ? await readDhRatchetSnapshot(convId, store) : await readRatchetSnapshot(convId, store);
    if (!state?.pendingReceiveCommits?.includes(fingerprint)) return;
    const next = { ...state, pendingReceiveCommits: state.pendingReceiveCommits.filter(item => item !== fingerprint) };
    try {
      if ("v" in next) await setDhRatchetState(convId, next, store, value);
      else await setRatchetState(convId, next, store, value);
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "PRIOR_STATE_MISMATCH") throw error;
    }
  }
  throw new Error("RECEIVE_COMMIT_CLEANUP_CONFLICT");
};

export const setDhRatchetState = async (convId: string, state: DhRatchetStateV2, store: SecretStore = getSecretStore(), expected?: string | null) => {
  await setSecret(`${DH_RATCHET_PREFIX}${convId}`, serializeDhRatchetState(state), store, expected);
};

export const clearDhRatchetState = async (convId: string, store: SecretStore = getSecretStore()) => {
  await removeSecret(`${DH_RATCHET_PREFIX}${convId}`, store);
};

const readOwnedSnapshot = async <T>(convId: string, version: 1 | 2, parse: (raw: string | null) => T | null): Promise<OwnedRatchetSnapshot<T>> => {
  if (!nativeRatchetCasEnabled() || isUnifiedTextChannel(convId)) throw new Error("OWNER_REQUIRED");
  const accountId = getActiveAccountId();
  const generation = getAccountOwnerGeneration();
  const store = getSecretStore();

  if (!store.ratchetSnapshot) throw new Error("OWNER_REQUIRED");
  const snapshot = await store.ratchetSnapshot(accountId, convId, version);

  if (getActiveAccountId() !== accountId || getAccountOwnerGeneration() !== generation) throw new Error("OWNER_SESSION_CHANGED");

  return { state: parse(snapshot.value), revision: snapshot.revision, fingerprint: snapshot.fingerprint,
    accountId, generation };
};

const commitOwnedState = async <T>(convId: string, version: 1 | 2, snapshot: OwnedRatchetSnapshot<T>, nextValue: string) => {
  if (!nativeRatchetCasEnabled() || getActiveAccountId() !== snapshot.accountId ||
      getAccountOwnerGeneration() !== snapshot.generation) throw new Error("OWNER_SESSION_CHANGED");
  const store = getSecretStore();

  if (!store.ratchetCommit) throw new Error("OWNER_REQUIRED");
  await store.ratchetCommit({ accountId: snapshot.accountId, channel: convId, version,
    expectedRevision: snapshot.revision, expectedFingerprint: snapshot.fingerprint, nextValue });
};

export const readOwnedRatchetState = (convId: string) => readOwnedSnapshot(convId, 1, parseRatchetState);

export const readOwnedDhRatchetState = (convId: string) => readOwnedSnapshot(convId, 2, parseDhRatchetState);

export const commitOwnedRatchetState = (convId: string, snapshot: OwnedRatchetSnapshot<RatchetStateV1>, state: RatchetStateV1) =>
  commitOwnedState(convId, 1, snapshot, serializeRatchetState(state));

export const commitOwnedDhRatchetState = (convId: string, snapshot: OwnedRatchetSnapshot<DhRatchetStateV2>, state: DhRatchetStateV2) =>
  commitOwnedState(convId, 2, snapshot, serializeDhRatchetState(state));

/** A read-only proof; recovery never advances a prior-process Ratchet. */
export const hasSendCommit = async (convId: string, marker: string, store: SecretStore) =>
  Boolean((await getDhRatchetState(convId, store))?.pendingSendCommits?.includes(marker));

export const acknowledgeSendCommit = async (convId: string, marker: string, store: SecretStore) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await readDhRatchetSnapshot(convId, store);

    if (!snapshot.state?.pendingSendCommits?.includes(marker)) return;
    try {
      await setDhRatchetState(convId, { ...snapshot.state,
        pendingSendCommits: snapshot.state.pendingSendCommits.filter(item => item !== marker) }, store, snapshot.value);

      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "PRIOR_STATE_MISMATCH") throw error;
    }
  }

  throw new Error("SEND_COMMIT_CLEANUP_CONFLICT");
};
