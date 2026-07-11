import type { P2PSyncOrchestrator } from "../sync/p2pSyncOrchestrator";

export type P2POrchestratorLike = Pick<P2PSyncOrchestrator, "shutdown">;

export type QuitEventLike = {
  preventDefault?: () => void;
};

export type ElectronAppLike = {
  on: (
    event: "before-quit" | "will-quit",
    listener: (event?: QuitEventLike) => void
  ) => unknown;
  quit?: () => void;
};

export type P2PLifecycleManagerOptions = {
  getOrchestrator: () => P2POrchestratorLike | null | undefined;
  afterShutdown?: (reason: string) => Promise<void> | void;
  logError?: (error: unknown) => void;
};

export class P2PLifecycleManager {
  private readonly getOrchestrator: P2PLifecycleManagerOptions["getOrchestrator"];
  private readonly afterShutdown?: P2PLifecycleManagerOptions["afterShutdown"];
  private shutdownPromise: Promise<void> | null = null;
  private shutdownComplete = false;

  constructor(options: P2PLifecycleManagerOptions) {
    this.getOrchestrator = options.getOrchestrator;
    this.afterShutdown = options.afterShutdown;
  }

  isShutdownComplete() {
    return this.shutdownComplete;
  }

  async shutdown(reason: string) {
    if (this.shutdownComplete) return;
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = (async () => {
      const orchestrator = this.getOrchestrator();
      if (orchestrator) {
        await orchestrator.shutdown();
      }
      await this.afterShutdown?.(reason);
      this.shutdownComplete = true;
    })().finally(() => {
      this.shutdownPromise = null;
    });

    return this.shutdownPromise;
  }
}

export const registerP2PLifecycleHooks = (
  app: ElectronAppLike,
  options: P2PLifecycleManagerOptions
) => {
  const manager = new P2PLifecycleManager(options);
  const logError = options.logError ?? (() => undefined);

  app.on("before-quit", (event) => {
    if (manager.isShutdownComplete()) return;
    event?.preventDefault?.();
    void manager
      .shutdown("before-quit")
      .catch(logError)
      .finally(() => app.quit?.());
  });

  app.on("will-quit", () => {
    void manager.shutdown("will-quit").catch(logError);
  });

  return manager;
};
