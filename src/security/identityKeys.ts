import { getPublicStore } from "./publicStore";
import { getSecretStore } from "./secretStore";
import { getSodium } from "./sodium";
import { decodeBase64Url, encodeBase64Url } from "./base64url";

const IDENTITY_PRIV_KEY = "nkc_identity_priv_v1";
const IDENTITY_PUB_KEY = "nkc_identity_pub_v1";
const DH_PRIV_KEY = "nkc_dh_priv_v1";
const DH_PUB_KEY = "nkc_dh_pub_v1";

const memorySecrets = new Map<string, string>();

const getSecret = async (key: string) => {
  try {
    const store = getSecretStore();
    return await store.get(key);
  } catch {
    return memorySecrets.get(key) ?? null;
  }
};

const setSecret = async (key: string, value: string) => {
  try {
    const store = getSecretStore();
    await store.set(key, value);
    return;
  } catch {
    memorySecrets.set(key, value);
  }
};

const ensureKeypair = async (
  privKeyName: string,
  pubKeyName: string,
  createPair: (sodium: Awaited<ReturnType<typeof getSodium>>) => {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  }
) => {
  const store = getPublicStore();
  const privRaw = await getSecret(privKeyName);
  const pubRaw = await store.get(pubKeyName);
  if (privRaw && pubRaw) {
    return {
      privateKey: decodeBase64Url(privRaw),
      publicKey: decodeBase64Url(pubRaw),
    };
  }
  const sodium = await getSodium();
  const pair = createPair(sodium);
  await setSecret(privKeyName, encodeBase64Url(pair.privateKey));
  await store.set(pubKeyName, encodeBase64Url(pair.publicKey));
  return pair;
};

export const getOrCreateIdentityKeypair = async () =>
  ensureKeypair(IDENTITY_PRIV_KEY, IDENTITY_PUB_KEY, (sodium) =>
    sodium.crypto_sign_keypair()
  );

export const getOrCreateDhKeypair = async () =>
  ensureKeypair(DH_PRIV_KEY, DH_PUB_KEY, (sodium) => sodium.crypto_kx_keypair());

export const getIdentityPublicKey = async () => {
  const store = getPublicStore();
  const raw = await store.get(IDENTITY_PUB_KEY);
  if (raw) return decodeBase64Url(raw);
  return (await getOrCreateIdentityKeypair()).publicKey;
};

export const getDhPublicKey = async () => {
  const store = getPublicStore();
  const raw = await store.get(DH_PUB_KEY);
  if (raw) return decodeBase64Url(raw);
  return (await getOrCreateDhKeypair()).publicKey;
};

export const getIdentityPrivateKey = async () =>
  (await getOrCreateIdentityKeypair()).privateKey;

export const getDhPrivateKey = async () =>
  (await getOrCreateDhKeypair()).privateKey;
