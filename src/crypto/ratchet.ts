import { getSodium } from "../security/sodium";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import {
  getDhRatchetState,
  getRatchetState,
  setDhRatchetState,
  setRatchetState,
} from "../security/ratchetStore";

export type RatchetStateV1 = { ck: Uint8Array; sendI: number; recvI: number };
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
};

const textEncoder = new TextEncoder();
const ROTATE_EVERY = 50;

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
  baseKey: Uint8Array
): Promise<RatchetStateV1> => {
  const existing = await getRatchetState(convId);
  if (existing) return existing;
  const ck = await hash("nkc:ratchet:init", baseKey);
  const state: RatchetStateV1 = { ck, sendI: 0, recvI: 0 };
  await setRatchetState(convId, state);
  return state;
};

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

const deriveRecvKeyAtIndex = async (
  ck: Uint8Array,
  recvI: number,
  targetI: number,
  maxSkip: number
) => {
  if (!Number.isFinite(targetI) || targetI < recvI) {
    return { deferred: true as const };
  }

  let steps = 0;
  let cursorCk = ck;
  let cursorI = recvI;

  while (cursorI < targetI && steps < maxSkip) {
    const derived = await deriveMsgKey(cursorCk);
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

export const nextSendKey = async (convId: string, baseKey: Uint8Array) => {
  const state = await getOrInitRatchetState(convId, baseKey);
  const usedIndex = state.sendI;
  const { msgKey, nextCk } = await deriveMsgKey(state.ck);
  const nextState: RatchetStateV1 = {
    ck: nextCk,
    sendI: state.sendI + 1,
    recvI: state.recvI,
  };
  await setRatchetState(convId, nextState);
  return { msgKey, headerRk: { v: 1 as const, i: usedIndex } };
};

export const getOrInitDhRatchetState = async (
  convId: string,
  baseKey: Uint8Array
): Promise<DhRatchetStateV2> => {
  const existing = await getDhRatchetState(convId);
  if (existing) return existing;
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
  await setDhRatchetState(convId, state);
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

export const nextSendDhKey = async (convId: string, baseKey: Uint8Array) => {
  let state = await getOrInitDhRatchetState(convId, baseKey);

  if (state.dhRemotePub && state.mode === "sym") {
    const stepped = await dhStep(state, state.dhRemotePub, false);
    state = {
      ...state,
      rk: stepped.rk,
      sendCk: stepped.sendCk,
      sendI: 0,
      pn: state.sendI,
      mode: "dh",
    };
  }

  if (state.sendI >= ROTATE_EVERY) {
    const kp = await generateDhKeypair();
    state = {
      ...state,
      dhSelfPriv: kp.privateKey,
      dhSelfPub: kp.publicKey,
      pn: state.sendI,
      sendI: 0,
    };
    if (state.dhRemotePub) {
      const stepped = await dhStep(state, state.dhRemotePub, false);
      state = {
        ...state,
        rk: stepped.rk,
        sendCk: stepped.sendCk,
        mode: "dh",
      };
    }
  }

  const usedIndex = state.sendI;
  const { msgKey, nextCk } = await deriveMsgKey(state.sendCk);
  const nextState: DhRatchetStateV2 = {
    ...state,
    sendCk: nextCk,
    sendI: state.sendI + 1,
    pn: undefined,
  };
  await setDhRatchetState(convId, nextState);
  return {
    msgKey,
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
  maxSkip = 50
): Promise<{ msgKey: Uint8Array } | { deferred: true }> => {
  const state = await getOrInitRatchetState(convId, baseKey);

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
  const nextState: RatchetStateV1 = {
    ck: derived.nextCk,
    sendI: state.sendI,
    recvI: recvI + 1,
  };
  await setRatchetState(convId, nextState);
  return { msgKey: derived.msgKey };
};

export const tryRecvDhKey = async (
  convId: string,
  baseKey: Uint8Array,
  rk: { v: 2; i: number; dh: string; pn?: number },
  maxSkip = 50
): Promise<{ msgKey: Uint8Array; commit: () => Promise<void> } | { deferred: true }> => {
  const state = await getOrInitDhRatchetState(convId, baseKey);
  if (!rk?.dh) return { deferred: true };

  let remotePub: Uint8Array;
  try {
    remotePub = decodeBase64Url(rk.dh);
  } catch {
    return { deferred: true };
  }
  const remoteChanged = !bytesEqual(state.dhRemotePub, remotePub);

  const candidates: Array<{
    state: DhRatchetStateV2;
    prefer: "sym" | "dh";
  }> = [{ state, prefer: state.mode === "dh" ? "dh" : "sym" }];

  if (remoteChanged || (state.mode === "sym" && state.dhRemotePub)) {
    const stepped = await dhStep(state, remotePub, true);
    candidates.push({
      state: {
        ...state,
        rk: stepped.rk,
        sendCk: stepped.sendCk,
        recvCk: stepped.recvCk,
        sendI: 0,
        recvI: 0,
        pn: state.sendI,
        dhRemotePub: remotePub,
        mode: "dh",
      },
      prefer: "dh",
    });
  }

  for (const candidate of candidates) {
    const derived = await deriveRecvKeyAtIndex(
      candidate.state.recvCk,
      candidate.state.recvI,
      rk.i,
      maxSkip
    );
    if ("deferred" in derived) {
      continue;
    }
    const commitState: DhRatchetStateV2 = {
      ...candidate.state,
      recvCk: derived.nextCk,
      recvI: derived.nextRecvI,
      dhRemotePub: remoteChanged ? remotePub : candidate.state.dhRemotePub,
      mode: candidate.prefer === "dh" ? "dh" : candidate.state.mode,
    };
    if (candidate.prefer === "sym" && remoteChanged) {
      commitState.dhRemotePub = remotePub;
    }
    return {
      msgKey: derived.msgKey,
      commit: async () => {
        await setDhRatchetState(convId, commitState);
      },
    };
  }

  return { deferred: true };
};
