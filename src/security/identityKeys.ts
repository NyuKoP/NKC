import { getPublicStore } from "./publicStore";
import { getSecretStore } from "./secretStore";
import { getSodium } from "./sodium";
import { decodeBase64Url, encodeBase64Url } from "./base64url";
import { scopeAccountKey } from "../accounts/accountRegistry";
import type { ReceiveContext } from "../accounts/receiveContext";

const IDENTITY_PRIV_KEY = "nkc_identity_priv_v1";

const IDENTITY_PUB_KEY = "nkc_identity_pub_v1";

const DH_PRIV_KEY = "nkc_dh_priv_v1";

const DH_PUB_KEY = "nkc_dh_pub_v1";

const pendingKeypairs = new Map<string, Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }>>();

const getSecret = async (key: string, context?: ReceiveContext) => {
  return getSecretStore(context?.owner.session).get(key);
};

const setSecret = async (key: string, value: string) => {
  await getSecretStore().set(key, value);
};

const ensureKeypair = async (
  privKeyName: string,
  pubKeyName: string,
  createPair: (sodium: Awaited<ReturnType<typeof getSodium>>) => {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  },
  derivePublic: (
    sodium: Awaited<ReturnType<typeof getSodium>>,
    privateKey: Uint8Array
  ) => Uint8Array,
  context?: ReceiveContext
) => {
  const lockKey = context ? `${context.owner.accountId}:${context.owner.session.token}:${privKeyName}` : scopeAccountKey(privKeyName);
  const existing = pendingKeypairs.get(lockKey);

  if (existing) return existing;

  const pending = (async () => {
    const store = getPublicStore(context?.vault);

    const [privRaw, pubRaw, sodium] = await Promise.all([
      getSecret(privKeyName, context),
      store.get(pubKeyName),
      getSodium(),
    ]);

    if (privRaw !== null) {
      let privateKey: Uint8Array;
      let publicKey: Uint8Array;

      try {
        privateKey = decodeBase64Url(privRaw);
        publicKey = derivePublic(sodium, privateKey);
      } catch {
        throw new Error("IDENTITY_PRIVATE_KEY_INVALID");
      }

      if (!pubRaw || encodeBase64Url(publicKey) !== pubRaw) {
        await store.set(pubKeyName, encodeBase64Url(publicKey));
      }

      return { privateKey, publicKey };
    }

    if (pubRaw || context) throw new Error("IDENTITY_PRIVATE_KEY_UNAVAILABLE");
    const pair = createPair(sodium);
    await setSecret(privKeyName, encodeBase64Url(pair.privateKey));
    await store.set(pubKeyName, encodeBase64Url(pair.publicKey));

    return pair;
  })();

  pendingKeypairs.set(lockKey, pending);

  try {
    return await pending;
  } finally {
    if (pendingKeypairs.get(lockKey) === pending) pendingKeypairs.delete(lockKey);
  }
};

export const getOrCreateIdentityKeypair = async (context?: ReceiveContext) =>
  ensureKeypair(
    IDENTITY_PRIV_KEY,
    IDENTITY_PUB_KEY,
    (sodium) => sodium.crypto_sign_keypair(),
    (sodium, privateKey) => sodium.crypto_sign_ed25519_sk_to_pk(privateKey), context
  );

export const getOrCreateDhKeypair = async (context?: ReceiveContext) =>
  ensureKeypair(
    DH_PRIV_KEY,
    DH_PUB_KEY,
    (sodium) => sodium.crypto_kx_keypair(),
    (sodium, privateKey) => sodium.crypto_scalarmult_base(privateKey), context
  );

export const getIdentityPublicKey = async (context?: ReceiveContext) =>
  (await getOrCreateIdentityKeypair(context)).publicKey;

export const getDhPublicKey = async (context?: ReceiveContext) =>
  (await getOrCreateDhKeypair(context)).publicKey;

export const getIdentityPrivateKey = async (context?: ReceiveContext) =>
  (await getOrCreateIdentityKeypair(context)).privateKey;

export const getDhPrivateKey = async (context?: ReceiveContext) =>
  (await getOrCreateDhKeypair(context)).privateKey;
