import { decodeBase64Url, encodeBase64Url } from "./base64url";
import { getSecretStore } from "./secretStore";
import type { DhRatchetStateV2, RatchetStateV1 } from "../crypto/ratchet";

const RATCHET_PREFIX = "nkc_ratchet_v1:";
const DH_RATCHET_PREFIX = "nkc_ratchet_v2:";
const memoryStore = new Map<string, string>();

const getSecret = async (key: string) => {
  try {
    const store = getSecretStore();
    return await store.get(key);
  } catch {
    return memoryStore.get(key) ?? null;
  }
};

const setSecret = async (key: string, value: string) => {
  try {
    const store = getSecretStore();
    await store.set(key, value);
    return;
  } catch {
    memoryStore.set(key, value);
  }
};

export const getRatchetState = async (convId: string): Promise<RatchetStateV1 | null> => {
  const raw = await getSecret(`${RATCHET_PREFIX}${convId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { ck: string; sendI: number; recvI: number };
    if (!parsed?.ck || !Number.isFinite(parsed.sendI) || !Number.isFinite(parsed.recvI)) {
      return null;
    }
    return {
      ck: decodeBase64Url(parsed.ck),
      sendI: parsed.sendI,
      recvI: parsed.recvI,
    };
  } catch {
    return null;
  }
};

export const setRatchetState = async (convId: string, state: RatchetStateV1) => {
  const payload = JSON.stringify({
    ck: encodeBase64Url(state.ck),
    sendI: state.sendI,
    recvI: state.recvI,
  });
  await setSecret(`${RATCHET_PREFIX}${convId}`, payload);
};

export const getDhRatchetState = async (convId: string): Promise<DhRatchetStateV2 | null> => {
  const raw = await getSecret(`${DH_RATCHET_PREFIX}${convId}`);
  if (!raw) return null;
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
    };
    if (
      parsed?.v !== 2 ||
      !parsed.rk ||
      !parsed.dhSelfPriv ||
      !parsed.dhSelfPub ||
      !parsed.sendCk ||
      !parsed.recvCk ||
      !Number.isFinite(parsed.sendI) ||
      !Number.isFinite(parsed.recvI)
    ) {
      return null;
    }
    return {
      v: 2,
      rk: decodeBase64Url(parsed.rk),
      dhSelfPriv: decodeBase64Url(parsed.dhSelfPriv),
      dhSelfPub: decodeBase64Url(parsed.dhSelfPub),
      dhRemotePub: parsed.dhRemotePub ? decodeBase64Url(parsed.dhRemotePub) : null,
      sendCk: decodeBase64Url(parsed.sendCk),
      sendI: parsed.sendI,
      recvCk: decodeBase64Url(parsed.recvCk),
      recvI: parsed.recvI,
      pn: parsed.pn,
      mode: parsed.mode ?? "sym",
    };
  } catch {
    return null;
  }
};

export const setDhRatchetState = async (convId: string, state: DhRatchetStateV2) => {
  const payload = JSON.stringify({
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
  });
  await setSecret(`${DH_RATCHET_PREFIX}${convId}`, payload);
};
