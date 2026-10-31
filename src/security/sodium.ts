type SodiumModule = typeof import("libsodium-wrappers-sumo");

let sodiumInstance: SodiumModule | null = null;

const ready: { promise: Promise<void> | null } = { promise: null };

export const getSodium = async () => {
  if (!sodiumInstance) {
    const mod = await import("libsodium-wrappers-sumo");
    sodiumInstance = mod.default ?? mod;
  }

  if (!ready.promise) {
    ready.promise = sodiumInstance.ready;
  }

  await ready.promise;

  return sodiumInstance;
};
