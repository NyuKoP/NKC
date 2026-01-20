import { createDeliveryScheduler } from "../delivery/deliveryScheduler";
import { sendOutboxRecord } from "./router";
import { ensureOutboxDefaults } from "../storage/outboxStore";
import { useNetConfigStore } from "./netConfigStore";
import type { NetMode } from "../delivery/retryPolicy";

let scheduler: ReturnType<typeof createDeliveryScheduler> | null = null;

export const startOutboxScheduler = () => {
  if (scheduler) return;
  const getNetMode = (): NetMode => {
    const config = useNetConfigStore.getState().config;
    if (config.mode === "directP2P") return "direct";
    if (config.mode === "selfOnion") return "onion";
    if (config.mode === "onionRouter" || config.onionEnabled) {
      return config.onionSelectedNetwork === "lokinet" ? "lokinet" : "tor";
    }
    return "direct";
  };
  scheduler = createDeliveryScheduler(sendOutboxRecord, { getNetMode });
  void ensureOutboxDefaults().then(() => {
    scheduler?.start();
  });
};

export const stopOutboxScheduler = () => {
  if (!scheduler) return;
  scheduler.stop();
  scheduler = null;
};
