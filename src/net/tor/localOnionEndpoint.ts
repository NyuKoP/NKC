import { TorRuntime } from "./TorRuntime";

type LocalOnionBridge = {
  ensureHiddenService?: () => Promise<unknown>;
  getMyOnionAddress?: () => Promise<string>;
  prewarmOnionRoute?: (payload: { onionAddress: string }) => Promise<{
    ok?: boolean;
    error?: string;
  }>;
};

let readyAddress: string | null = null;
let localAddress: string | null = null;
let preparation: Promise<string | undefined> | null = null;

const getBridge = () =>
  (globalThis as { nkc?: LocalOnionBridge }).nkc ?? null;

export const ensureLocalOnionEndpoint = async (): Promise<string | undefined> => {
  const bridge = getBridge();
  if (!bridge?.ensureHiddenService || !bridge.getMyOnionAddress) return undefined;
  if (localAddress) return localAddress;

  const runtime = TorRuntime.getInstance();
  await runtime.start({ timeoutMs: 30_000 });
  await runtime.awaitReady(30_000);
  await bridge.ensureHiddenService();
  const onionAddress = (await bridge.getMyOnionAddress()).trim().toLowerCase();
  if (!/^[a-z2-7]{56}\.onion$/.test(onionAddress)) return undefined;
  localAddress = onionAddress;
  return onionAddress;
};

export const ensurePublishedLocalOnionEndpoint = async (): Promise<string | undefined> => {
  if (preparation) return preparation;
  preparation = (async () => {
    const bridge = getBridge();
    if (!bridge?.prewarmOnionRoute) return undefined;
    const onionAddress = await ensureLocalOnionEndpoint();
    if (!onionAddress) return undefined;
    if (readyAddress === onionAddress) return onionAddress;

    const result = await bridge.prewarmOnionRoute({ onionAddress });
    if (!result?.ok) return undefined;
    readyAddress = onionAddress;
    return onionAddress;
  })().finally(() => {
    preparation = null;
  });
  return preparation;
};

export const __testResetPublishedLocalOnionEndpoint = () => {
  readyAddress = null;
  localAddress = null;
  preparation = null;
};
