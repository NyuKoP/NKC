import { getSodium } from "../security/sodium";
import { getSecretStore, type SecretStore } from "../security/secretStore";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import {
  getDhRatchetState,
  getRatchetState,
  setDhRatchetState,
  setRatchetState,
  readRatchetSnapshot,
  readDhRatchetSnapshot,
  fingerprintRatchetState,
  nativeRatchetCasEnabled,
  readOwnedRatchetState,
  readOwnedDhRatchetState,
  commitOwnedRatchetState,
  commitOwnedDhRatchetState,
} from "../security/ratchetStore";

export type RatchetStateV1 = { ck: Uint8Array; sendI: number; recvI: number; pendingReceiveCommits?: string[] };

export type DhRatchetStateV2 = {
  v: 2;
  rk: Uint8Array;
  dhSelfPriv: Uint8Array;
  dhSelfPub: Uint8Array;
  dhRemotePub: Uint8Array | null;
  sendCk: Uint8Array;
  sendI: number;
  recvCk: Uint8Array;
  recvI: number;
  pn?: number;
  mode: "sym" | "dh";
  retained?: RetainedReceiveKey[];
  pendingReceiveCommits?: string[];
  pendingSendCommits?: string[];
};

const textEncoder = new TextEncoder();

const concatBytes = (chunks: Array<Uint8Array | ArrayBuffer>) => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    result.set(bytes, offset);
    offset += bytes.byteLength;
  }

  return result;
};

const hash = async (label: string, bytes: Uint8Array) => {
  return hashParts(label, [bytes]);
};

const hashParts = async (label: string, parts: Uint8Array[]) => {
  const sodium = await getSodium();
  const domain = textEncoder.encode("nkc:ratchet:v1");
  const labelBytes = textEncoder.encode(label);
  const material = concatBytes([domain, labelBytes, ...parts]);

  return sodium.crypto_generichash(32, material);
};

export const getOrInitRatchetState = async (
  convId: string,
  baseKey: Uint8Array, store: SecretStore = getSecretStore()
): Promise<RatchetStateV1> => {
  if (nativeRatchetCasEnabled()) {
    const snapshot = await readOwnedRatchetState(convId);

    if (snapshot.state) return snapshot.state;
    const state = await createReceiveStateV1(baseKey);

    try { await commitOwnedRatchetState(convId, snapshot, state); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("STALE_OWNER_REVISION")) throw error;
    }

    const current = await readOwnedRatchetState(convId);

    if (!current.state) throw new Error("OWNER_STATE_INVALID");

    return current.state;
  }

  const existing = await getRatchetState(convId, store);

  if (existing) return existing;
  const state = await createReceiveStateV1(baseKey);

  try { await setRatchetState(convId, state, store, null); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "PRIOR_STATE_MISMATCH") throw error;
    const current = await getRatchetState(convId, store);

    if (!current) throw new Error("OWNER_STATE_INVALID");

    return current;
  }

  return state;
};

// Pure initialization for authenticated, transaction-owned receive experiments.
export const createReceiveStateV1 = async (baseKey: Uint8Array): Promise<RatchetStateV1> => ({
  ck: await hash("nkc:ratchet:init", baseKey), sendI: 0, recvI: 0,
});

export const deriveMsgKey = async (ck: Uint8Array) => {
  const msgKey = await hash("nkc:ratchet:msg", ck);
  const nextCk = await hash("nkc:ratchet:ck", ck);

  return { msgKey, nextCk };
};

const bytesEqual = (a: Uint8Array | null, b: Uint8Array | null) => {
  if (!a || !b) return false;

  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }

  return true;
};

// A receive chain survives the independent sending half-step of the root ratchet.
const orderedChainLabel = (state: DhRatchetStateV2, remoteDh: string) =>
  `${state.mode}:${remoteDh}:${remoteDh}`;

const deriveRecvKeyAtIndex = async (
  ck: Uint8Array,
  recvI: number,
  targetI: number,
  maxSkip: number,
  retainSkipped = false
): Promise<{ deferred: true } | { msgKey: Uint8Array; nextCk: Uint8Array; nextRecvI: number; skipped: Array<{ index: number; key: Uint8Array }> }> => {
  if (!Number.isFinite(targetI) || targetI < recvI) {
    return { deferred: true as const };
  }

  let steps = 0;
  let cursorCk = ck;
  let cursorI = recvI;
  const skipped: Array<{ index: number; key: Uint8Array }> = [];

  while (cursorI < targetI && steps < maxSkip) {
    const derived = await deriveMsgKey(cursorCk);

    if (retainSkipped) skipped.push({ index: cursorI, key: derived.msgKey });
    cursorCk = derived.nextCk;
    cursorI += 1;
    steps += 1;
  }

  if (cursorI < targetI) {
    return { deferred: true as const };
  }

  const derived = await deriveMsgKey(cursorCk);

  return {
    msgKey: derived.msgKey,
    nextCk: derived.nextCk,
    nextRecvI: cursorI + 1,
    skipped,
  };
};

const kdfRk = async (rk: Uint8Array, dhShared: Uint8Array) => {
  const tmp = await hashParts("nkc:dr:rk", [rk, dhShared]);
  const sendCk = await hashParts("nkc:dr:send", [tmp]);
  const recvCk = await hashParts("nkc:dr:recv", [tmp]);
  const rk2 = await hashParts("nkc:dr:rk2", [tmp]);

  return { rk2, sendCk, recvCk };
};

const generateDhKeypair = async () => {
  const sodium = await getSodium();
  const kp = sodium.crypto_kx_keypair();

  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
};

export const nextSendKey = async (convId: string, baseKey: Uint8Array, store: SecretStore = getSecretStore()) => {
  const state = await getOrInitRatchetState(convId, baseKey, store);

  if (nativeRatchetCasEnabled()) {
    const snapshot = await readOwnedRatchetState(convId);

    if (!snapshot.state) throw new Error("OWNER_STATE_INVALID");
    const candidate = await prepareSendKey(snapshot.state);
    await commitOwnedRatchetState(convId, snapshot, candidate.nextState);

    return { msgKey: candidate.msgKey, headerRk: candidate.headerRk };
  }

  const snapshot = store.conditionalWrites ? await readRatchetSnapshot(convId, store) : undefined;
  const prepared = await prepareSendKey(snapshot?.state ?? state);
  await setRatchetState(convId, prepared.nextState, store, snapshot?.value);

  return { msgKey: prepared.msgKey, headerRk: prepared.headerRk };
};

/** Immutable candidate; persistence belongs to the caller's atomic outbox commit. */
export const prepareSendKey = async (state: RatchetStateV1) => {
  const usedIndex = state.sendI;
  const { msgKey, nextCk } = await deriveMsgKey(state.ck);

  const nextState: RatchetStateV1 = {
    ...state,
    ck: nextCk,
    sendI: state.sendI + 1,
    recvI: state.recvI,
  };

  return { msgKey, nextState, headerRk: { v: 1 as const, i: usedIndex } };
};

export const getOrInitDhRatchetState = async (
  convId: string,
  baseKey: Uint8Array, store: SecretStore = getSecretStore()
): Promise<DhRatchetStateV2> => {
  if (nativeRatchetCasEnabled()) {
    const snapshot = await readOwnedDhRatchetState(convId);

    if (snapshot.state) return snapshot.state;
    const state = await createReceiveStateV2(baseKey);

    try { await commitOwnedDhRatchetState(convId, snapshot, state); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("STALE_OWNER_REVISION")) throw error;
    }

    const current = await readOwnedDhRatchetState(convId);

    if (!current.state) throw new Error("OWNER_STATE_INVALID");

    return current.state;
  }

  const existing = await getDhRatchetState(convId, store);

  if (existing) return existing;
  const state = await createReceiveStateV2(baseKey);

  try { await setDhRatchetState(convId, state, store, null); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "PRIOR_STATE_MISMATCH") throw error;
    const current = await getDhRatchetState(convId, store);

    if (!current) throw new Error("OWNER_STATE_INVALID");

    return current;
  }

  return state;
};

export const createReceiveStateV2 = async (baseKey: Uint8Array): Promise<DhRatchetStateV2> => {
  const rk = await hashParts("nkc:dr:init", [baseKey]);
  const initCk = await hash("nkc:ratchet:init", baseKey);
  const kp = await generateDhKeypair();

  const state: DhRatchetStateV2 = {
    v: 2,
    rk,
    dhSelfPriv: kp.privateKey,
    dhSelfPub: kp.publicKey,
    dhRemotePub: null,
    sendCk: initCk,
    sendI: 0,
    recvCk: initCk,
    recvI: 0,
    mode: "sym",
  };

  return state;
};

const dhStep = async (
  state: DhRatchetStateV2,
  remotePub: Uint8Array,
  swap: boolean
) => {
  const sodium = await getSodium();
  const dhShared = sodium.crypto_scalarmult(state.dhSelfPriv, remotePub);
  const derived = await kdfRk(state.rk, dhShared);
  const nextSendCk = swap ? derived.recvCk : derived.sendCk;
  const nextRecvCk = swap ? derived.sendCk : derived.recvCk;

  return {
    rk: derived.rk2,
    sendCk: nextSendCk,
    recvCk: nextRecvCk,
  };
};

export const nextSendDhKey = async (convId: string, baseKey: Uint8Array, store: SecretStore = getSecretStore(),
  beforeCommit?: (prepared: Awaited<ReturnType<typeof prepareSendDhKey>>) => Promise<string>) => {
  if (beforeCommit && (!store.conditionalWrites || nativeRatchetCasEnabled())) throw new Error("OWNED_SEND_COMMIT_REQUIRED");

  if (nativeRatchetCasEnabled()) {
    await getOrInitDhRatchetState(convId, baseKey, store);
    const snapshot = await readOwnedDhRatchetState(convId);

    if (!snapshot.state) throw new Error("OWNER_STATE_INVALID");
    const candidate = await prepareSendDhKey(snapshot.state);
    await commitOwnedDhRatchetState(convId, snapshot, candidate.nextState);

    return { msgKey: candidate.msgKey, headerRk: candidate.headerRk };
  }

  const initial = await getOrInitDhRatchetState(convId, baseKey, store);
  const snapshot = store.conditionalWrites ? await readDhRatchetSnapshot(convId, store) : undefined;
  const prepared = await prepareSendDhKey(snapshot?.state ?? initial);

  if (beforeCommit) {
    if ((prepared.nextState.pendingSendCommits?.length ?? 0) >= 50) throw new Error("SEND_COMMIT_CAPACITY");
    const marker = await beforeCommit(prepared);

    if (!/^[A-Za-z0-9_-]{43}$/.test(marker)) throw new Error("SEND_COMMIT_INVALID");
    prepared.nextState.pendingSendCommits = [...new Set([...(prepared.nextState.pendingSendCommits ?? []), marker])];
  }

  await setDhRatchetState(convId, prepared.nextState, store, snapshot?.value);

  return { msgKey: prepared.msgKey, headerRk: prepared.headerRk };
};

export const prepareSendDhKey = async (input: DhRatchetStateV2) => {
  let state = structuredClone(input);

  // Bootstrap elects one initiator; later keys advance only on authenticated peer DH.
  if (state.dhRemotePub && state.mode === "sym" &&
      (state.sendI === 0 || encodeBase64Url(state.dhSelfPub) < encodeBase64Url(state.dhRemotePub))) {
    const remotePub = state.dhRemotePub;
    const kp = await generateDhKeypair();
    state = { ...state, dhSelfPriv: kp.privateKey, dhSelfPub: kp.publicKey };
    const stepped = await dhStep(state, remotePub, false);
    state = {
      ...state,
      rk: stepped.rk,
      sendCk: stepped.sendCk,
      sendI: 0,
      pn: state.sendI,
      mode: "dh",
    };
  }

  const usedIndex = state.sendI;
  const { msgKey, nextCk } = await deriveMsgKey(state.sendCk);

  const nextState: DhRatchetStateV2 = {
    ...state,
    sendCk: nextCk,
    sendI: state.sendI + 1,
  };

  return {
    msgKey,
    nextState,
    headerRk: {
      v: 2 as const,
      i: usedIndex,
      dh: encodeBase64Url(state.dhSelfPub),
      pn: state.pn,
    },
  };
};

export const tryRecvKey = async (
  convId: string,
  baseKey: Uint8Array,
  targetI: number,
  maxSkip = 50,
  authenticate?: (msgKey: Uint8Array) => Promise<void>, store: SecretStore = getSecretStore(), deferCommit = false
): Promise<{ msgKey: Uint8Array; commit?: () => Promise<void>; commitFingerprint?: string } | { deferred: true }> => {
  if (nativeRatchetCasEnabled()) {
    if (!authenticate) throw new Error("OWNER_AUTHENTICATION_REQUIRED");
    await getOrInitRatchetState(convId, baseKey, store);
    const snapshot = await readOwnedRatchetState(convId);

    if (!snapshot.state) throw new Error("OWNER_STATE_INVALID");
    const derived = await deriveRecvKeyAtIndex(snapshot.state.ck, snapshot.state.recvI, targetI, maxSkip);

    if ("deferred" in derived) return derived;
    await authenticate(derived.msgKey);
    await commitOwnedRatchetState(convId, snapshot, {
      ck: derived.nextCk, sendI: snapshot.state.sendI, recvI: derived.nextRecvI,
    });

    return { msgKey: derived.msgKey };
  }

  const initial = await getOrInitRatchetState(convId, baseKey, store);
  const snapshot = store.conditionalWrites ? await readRatchetSnapshot(convId, store) : undefined;
  const state = snapshot?.state ?? initial;

  if (!Number.isFinite(targetI) || targetI < state.recvI) {
    return { deferred: true };
  }

  let steps = 0;
  let ck = state.ck;
  let recvI = state.recvI;

  while (recvI < targetI && steps < maxSkip) {
    const derived = await deriveMsgKey(ck);
    ck = derived.nextCk;
    recvI += 1;
    steps += 1;
  }

  if (recvI < targetI) {
    return { deferred: true };
  }

  const derived = await deriveMsgKey(ck);

  let nextState: RatchetStateV1 = {
    ...state,
    ck: derived.nextCk,
    sendI: state.sendI,
    recvI: recvI + 1,
  };

  if (store.conditionalWrites && authenticate) await authenticate(derived.msgKey);
  let commitFingerprint: string | undefined;
  if (store.conditionalWrites && deferCommit) {
    if (!authenticate) throw new Error("OWNER_AUTHENTICATION_REQUIRED");
    ({ nextState, commitFingerprint } = await prepareReceiveCommit(nextState));
  }
  const commit = () => setRatchetState(convId, nextState, store, snapshot?.value);

  if (store.conditionalWrites && deferCommit) return { msgKey: derived.msgKey, commit,
    commitFingerprint };
  await commit();

  return { msgKey: derived.msgKey };
};

export const tryRecvDhKey = async (
  convId: string,
  baseKey: Uint8Array,
  rk: { v: 2; i: number; dh: string; pn?: number },
  maxSkip = 50,
  authenticate?: (msgKey: Uint8Array) => Promise<void>, store: SecretStore = getSecretStore(), retainSkipped = false
): Promise<{ msgKey: Uint8Array; commit: () => Promise<void>; commitFingerprint?: string } | { deferred: true }> => {
  if (nativeRatchetCasEnabled()) {
    if (!authenticate) throw new Error("OWNER_AUTHENTICATION_REQUIRED");
    await getOrInitDhRatchetState(convId, baseKey, store);
    const snapshot = await readOwnedDhRatchetState(convId);

    if (!snapshot.state) throw new Error("OWNER_STATE_INVALID");
    const prepared = await prepareOrdinaryDhReceive(snapshot.state, rk, maxSkip, authenticate, retainSkipped);

    if ("deferred" in prepared) return prepared;

    return { msgKey: prepared.msgKey, commit: () => commitOwnedDhRatchetState(convId, snapshot, prepared.nextState) };
  }

  const initial = await getOrInitDhRatchetState(convId, baseKey, store);
  const snapshot = store.conditionalWrites ? await readDhRatchetSnapshot(convId, store) : undefined;
  const state = snapshot?.state ?? initial;
  if (store.conditionalWrites && !authenticate) throw new Error("OWNER_AUTHENTICATION_REQUIRED");
  const prepared = await prepareOrdinaryDhReceive(state, rk, maxSkip, authenticate, retainSkipped);

  if ("deferred" in prepared) return prepared;

  const receipt = store.conditionalWrites ? await prepareReceiveCommit(prepared.nextState) : { nextState: prepared.nextState, commitFingerprint: undefined };
  return { msgKey: prepared.msgKey, commitFingerprint: receipt.commitFingerprint,
    commit: () => setDhRatchetState(convId, receipt.nextState, store, snapshot?.value) };
};

const prepareReceiveCommit = async <T extends RatchetStateV1 | DhRatchetStateV2>(state: T) => {
  const commitFingerprint = await fingerprintRatchetState(state);
  const pending = [...new Set([...(state.pendingReceiveCommits ?? []), commitFingerprint])];
  if (pending.length > 50) throw new Error("RECEIVE_COMMIT_BACKLOG_FULL");
  return { nextState: { ...state, pendingReceiveCommits: pending }, commitFingerprint };
};

const prepareDhReceive = async (
  state: DhRatchetStateV2,
  rk: { v: 2; i: number; dh: string; pn?: number },
  maxSkip: number,
  authenticate?: (key: Uint8Array) => Promise<void>,
  retainSkipped = false,
): Promise<{ deferred: true } | { msgKey: Uint8Array; nextState: DhRatchetStateV2; skipped: Array<{ index: number; key: Uint8Array }>; chain: string }> => {
  if (!rk?.dh) return { deferred: true };

  let remotePub: Uint8Array;

  try {
    remotePub = decodeBase64Url(rk.dh);
  } catch {
    return { deferred: true };
  }

  const remoteChanged = !bytesEqual(state.dhRemotePub, remotePub);

  const candidates: DhRatchetStateV2[] = !remoteChanged || state.mode === "sym" ? [state] : [];

  if (remoteChanged || (state.mode === "sym" && state.dhRemotePub)) {
    const stepped = await dhStep(state, remotePub, true);
    candidates.push({
      ...state,
      rk: stepped.rk,
      // Receiving a new chain must not replace our independent outgoing chain.
      recvCk: stepped.recvCk,
      recvI: 0,
      dhRemotePub: remotePub,
      mode: "dh",
    });
  }

  let authenticationError: unknown;
  let authenticationFailed = false;

  for (const candidate of candidates) {
    const derived = await deriveRecvKeyAtIndex(
      candidate.recvCk,
      candidate.recvI,
      rk.i,
      maxSkip,
      retainSkipped
    );

    if ("deferred" in derived) {
      continue;
    }

    if (authenticate) {
      // The index alone cannot distinguish the initial chain from the first DH reply.
      // Only authenticated decryption selects a candidate; persistence stays in commit().
      try {
        await authenticate(derived.msgKey);
      } catch (error) {
        authenticationError = error;
        authenticationFailed = true;
        continue;
      }
    }

    let commitState: DhRatchetStateV2 = {
      ...candidate,
      recvCk: derived.nextCk,
      recvI: derived.nextRecvI,
      dhRemotePub: remoteChanged ? remotePub : candidate.dhRemotePub,
    };

    if (candidate !== state) {
      // Complete the sending half-step only after the new receive chain authenticates.
      const kp = await generateDhKeypair();
      commitState = { ...commitState, dhSelfPriv: kp.privateKey, dhSelfPub: kp.publicKey };
      const outgoing = await dhStep(commitState, remotePub, false);
      commitState = { ...commitState, rk: outgoing.rk, sendCk: outgoing.sendCk,
        sendI: 0, pn: state.sendI };
    }

    return {
      msgKey: derived.msgKey,
      nextState: commitState,
      skipped: derived.skipped,
      chain: retainSkipped ? await orderedChainLabel(candidate, rk.dh) : `${candidate.mode}:${rk.dh}`,
    };
  }

  if (authenticationFailed) throw authenticationError;

  return { deferred: true };
};

export type RetainedReceiveKey = { chain: string; index: number; key: Uint8Array; expiresAt: number };

export type OrderedReceiveState = { version: 1; ratchet: RatchetStateV1 } | { version: 2; ratchet: DhRatchetStateV2 };

/** No store writes. The owner must authenticate and atomically persist keys and application data. */
export const prepareOrderedReceive = async (
  state: OrderedReceiveState,
  rk: { v: 1; i: number } | { v: 2; i: number; dh: string; pn?: number },
  retained: RetainedReceiveKey[],
  now: number,
  authenticate: (key: Uint8Array) => Promise<void>,
  maxSkip = 50,
) => {
  if (rk.v !== state.version || !Number.isSafeInteger(rk.i) || rk.i < 0 ||
    (rk.v === 2 && (!Number.isSafeInteger(rk.pn ?? 0) || (rk.pn ?? 0) < 0))) return { deferred: true as const };

  const matches = (item: RetainedReceiveKey) => item.index === rk.i &&
    // Bootstrap keys predate the first authenticated remote DH; AEAD still binds the exact header.
    (rk.v === 1 ? item.chain === "v1" : item.chain.startsWith("sym:") || item.chain.endsWith(`:${rk.dh}`));

  const cached = retained.filter((item) => matches(item) && item.expiresAt > now);
  let cachedError: unknown;

  for (const candidate of cached) {
    try {
      await authenticate(candidate.key);

      return { state, retained: retained.filter((item) => item !== candidate), fromCache: true };
    } catch (error) { cachedError = error; }
  }

  const expiredMatch = retained.some((item) => matches(item) && item.expiresAt <= now);

  if (rk.v === 1 && expiredMatch && !cached.length) {
    return { deferred: true as const };
  }

  const remaining = retained.filter((item) => item.expiresAt > now);
  let next: OrderedReceiveState;
  let added: RetainedReceiveKey[];

  if (state.version === 1 && rk.v === 1) {
    const derived = await deriveRecvKeyAtIndex(state.ratchet.ck, state.ratchet.recvI, rk.i, 50, true);

    if ("deferred" in derived) {
      if (cachedError) throw cachedError;

      return derived;
    }

    await authenticate(derived.msgKey);
    next = { version: 1, ratchet: { ...state.ratchet, ck: derived.nextCk, recvI: derived.nextRecvI } };
    added = derived.skipped.map((item) => ({ ...item, chain: "v1", expiresAt: now + 7 * 86400_000 }));
  } else if (state.version === 2 && rk.v === 2) {
    let prepared;

    try { prepared = await prepareDhReceive(state.ratchet, rk, Math.min(maxSkip, 50), authenticate, true); }
    catch (error) { if (expiredMatch && !cached.length) return { deferred: true as const }; throw error; }

    if ("deferred" in prepared) {
      if (cachedError) throw cachedError;

      return prepared;
    }

    next = { version: 2, ratchet: prepared.nextState };
    added = prepared.skipped.map((item) => ({ ...item, chain: prepared.chain, expiresAt: now + 7 * 86400_000 }));
    const old = state.ratchet;

    const previousDh = old.dhRemotePub ? encodeBase64Url(old.dhRemotePub) : rk.dh;

    if (prepared.nextState.recvCk !== old.recvCk &&
      prepared.chain !== orderedChainLabel(old, previousDh) && (rk.pn ?? 0) > old.recvI) {
      const previous = await deriveRecvKeyAtIndex(old.recvCk, old.recvI, rk.pn! - 1, 49, true);

      if ("deferred" in previous) return { deferred: true as const };
      const chain = orderedChainLabel(old, previousDh);
      added.push(...previous.skipped.map((item) => ({ ...item, chain, expiresAt: now + 7 * 86400_000 })),
        { chain, index: rk.pn! - 1, key: previous.msgKey, expiresAt: now + 7 * 86400_000 });
    }
  } else return { deferred: true as const };
  const keys = [...remaining, ...added];

  if (keys.length > 50 || new Set(keys.map((item) => item.chain)).size > 4) return { deferred: true as const };

  return { state: next, retained: keys, fromCache: false };
};

/** The ordinary owner persists bounded skipped keys in its existing conditional secret. */
const prepareOrdinaryDhReceive = async (state: DhRatchetStateV2,
  rk: { v: 2; i: number; dh: string; pn?: number }, maxSkip: number,
  authenticate?: (key: Uint8Array) => Promise<void>, retainSkipped = false) => {
  if (!retainSkipped) return prepareDhReceive(state, rk, maxSkip, authenticate);

  if (!authenticate) throw new Error("OWNER_AUTHENTICATION_REQUIRED");
  let msgKey!: Uint8Array;

  const prepared = await prepareOrderedReceive({ version: 2, ratchet: state }, rk, state.retained ?? [], Date.now(),
    async key => { await authenticate(key); msgKey = key; }, maxSkip);

  if ("deferred" in prepared) return prepared;

  if (prepared.state.version !== 2) throw new Error("RATCHET_STATE_INVALID");
  const nextState = { ...prepared.state.ratchet, retained: prepared.retained.length ? prepared.retained : undefined };

  return { msgKey, nextState };
};
