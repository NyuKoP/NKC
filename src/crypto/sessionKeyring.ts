let vaultKey: Uint8Array | null = null;

export const setVaultKey = (key: Uint8Array) => {
  if (vaultKey) vaultKey.fill(0);
  vaultKey = new Uint8Array(key);
};

export const getVaultKey = () => vaultKey;

export const clearVaultKey = () => {
  if (vaultKey) vaultKey.fill(0);
  vaultKey = null;
};
