/** Only the Electron main process supplies this immutable preload capability. */
export const unifiedAppExperimentEnabled = () =>
  typeof window !== "undefined" && window.nkcExperimental?.unifiedText === true;

export const unifiedAppRecoveryEnabled = () =>
  unifiedAppExperimentEnabled() && window.nkcExperimental?.recoveryV2 === true;

export const isUnifiedTextChannel = (id: string) => /^phase2i:[a-zA-Z0-9_-]{43}$/.test(id);
