import { bumpAccountOwnerGeneration, notifyAccountOwnerChange } from "../accounts/accountOwnerLifecycle";

let vaultKey: Uint8Array | null = null;

const closeOwners = new Set<() => void>();

export const onVaultKeyChange = (close: () => void) => { closeOwners.add(close);

 return () => closeOwners.delete(close); };

export const setVaultKey = (key: Uint8Array) => {
  bumpAccountOwnerGeneration();
  closeOwners.forEach((close) => close());

  if (vaultKey) vaultKey.fill(0);
  vaultKey = new Uint8Array(key);
};

export const getVaultKey = () => vaultKey;

export const clearVaultKey = () => {
  notifyAccountOwnerChange();
  closeOwners.forEach((close) => close());

  if (vaultKey) vaultKey.fill(0);
  vaultKey = null;
};

const toB64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...Array.from(bytes)));

export const computeVaultKeyId = async (vk: Uint8Array) => {
  if (!globalThis.crypto?.subtle) return null;
  const vkBytes = new Uint8Array(vk);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", vkBytes);

  return toB64(new Uint8Array(digest).slice(0, 16));
};
