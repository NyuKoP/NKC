type SodiumModule = typeof import("libsodium-wrappers-sumo");

let sodiumInstance: SodiumModule | null = null;
const ready = { promise: null as Promise<void> | null };

export const getSodium = async () => {
  if (!sodiumInstance) {
    const mod = (await import("libsodium-wrappers-sumo")) as SodiumModule;
    sodiumInstance = (mod as unknown as { default?: SodiumModule }).default ?? mod;
  }
  if (!ready.promise) {
    ready.promise = sodiumInstance.ready;
  }
  await ready.promise;
  return sodiumInstance;
};
