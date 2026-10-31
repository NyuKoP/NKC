import { createDeliveryScheduler } from "../delivery/deliveryScheduler";
import { sendOutboxRecord } from "./router";
import { deleteFailedOutbox, ensureOutboxDefaults } from "../storage/outboxStore";
import { useNetConfigStore } from "./netConfigStore";
import type { NetMode } from "../delivery/deliveryScheduler";
import { getConnectionStatus, onConnectionStatus } from "./connectionStatus";
import { recoverUnifiedAppOutbox, closeUnifiedAppRatchet } from "../sync/unifiedAppRatchet";
import { unifiedAppExperimentEnabled } from "../sync/unifiedAppPolicy";
import { captureLocalOperationContext } from "../accounts/receiveContext";

let scheduler: ReturnType<typeof createDeliveryScheduler> | null = null;

let unsubscribeConnection: (() => void) | null = null;

let unifiedHandoffTimer: ReturnType<typeof setInterval> | null = null;

let handoffRunning = false;

export const startOutboxScheduler = () => {
  if (scheduler) return;

  if (unifiedAppExperimentEnabled()) {
    const recover = async () => {
      if (handoffRunning) return;
      handoffRunning = true;

      try { await recoverUnifiedAppOutbox(); } catch { /* durable prepared entry remains recoverable */ }
      finally { handoffRunning = false; }
    };

    void recover();
    unifiedHandoffTimer = setInterval(() => void recover(), 10_000);
  }

  const getNetMode = (): NetMode => {
    const config = useNetConfigStore.getState().config;

    if (config.mode === "directP2P") return "direct";

    if (config.mode === "selfOnion") return "onion";

    if (config.mode === "onionRouter" || config.onionEnabled) {
      return "tor";
    }

    return "onion";
  };

  scheduler = createDeliveryScheduler((record, access) => sendOutboxRecord(record, { access }), {
    getNetMode,
    planDelivery: async (payload) => {
      if (typeof window === "undefined" || !window.nativeWorker) return null;
      const response = await window.nativeWorker.planDelivery(payload);

      return response.ok && response.result ? response.result : null;
    },
  });
  const currentScheduler = scheduler;
  void captureLocalOperationContext().then(async context => {
    await ensureOutboxDefaults(context?.vault);

    return deleteFailedOutbox(12, context?.vault);
  })
    .then((deleted) => {
      if (scheduler !== currentScheduler) return;

      if (deleted > 0) {
        console.info(`[delivery] cleaned failed outbox records: ${deleted}`);
      }

      currentScheduler.start();
      let connected = getConnectionStatus().state === "connected";
      unsubscribeConnection = onConnectionStatus((status) => {
        const next = status.state === "connected";

        if (next && !connected) currentScheduler.wake();
        connected = next;
      });
    });
};

export const stopOutboxScheduler = () => {
  if (unifiedHandoffTimer) clearInterval(unifiedHandoffTimer);
  unifiedHandoffTimer = null;
  closeUnifiedAppRatchet();
  unsubscribeConnection?.();
  unsubscribeConnection = null;

  if (!scheduler) return;
  scheduler.stop();
  scheduler = null;
};
