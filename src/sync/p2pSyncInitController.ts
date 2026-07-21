import type { P2PSyncOrchestrator, P2PSyncRoute } from "./p2pSyncOrchestrator";

export type ActivatableP2POrchestrator = Pick<
  P2PSyncOrchestrator,
  "activate" | "isActive" | "shutdown"
>;

export type P2PSyncInitControllerOptions<
  TOrchestrator extends ActivatableP2POrchestrator,
> = {
  unlockKeyring: () => Promise<void> | void;
  createOrchestrator: () => Promise<TOrchestrator> | TOrchestrator;
  loadRoutes?: () => Promise<P2PSyncRoute[]> | P2PSyncRoute[];
  onReady?: (orchestrator: TOrchestrator) => void;
  onError?: (error: unknown) => void;
};

export class P2PSyncInitController<
  TOrchestrator extends ActivatableP2POrchestrator = P2PSyncOrchestrator,
> {
  private readonly unlockKeyring: P2PSyncInitControllerOptions<TOrchestrator>["unlockKeyring"];
  private readonly createOrchestrator: P2PSyncInitControllerOptions<TOrchestrator>["createOrchestrator"];
  private readonly loadRoutes?: P2PSyncInitControllerOptions<TOrchestrator>["loadRoutes"];
  private readonly onReady?: P2PSyncInitControllerOptions<TOrchestrator>["onReady"];
  private readonly onError?: P2PSyncInitControllerOptions<TOrchestrator>["onError"];
  private orchestrator: TOrchestrator | null = null;
  private activationPromise: Promise<TOrchestrator> | null = null;
  private activationEpoch = 0;
  private shutdownRequested = false;

  constructor(options: P2PSyncInitControllerOptions<TOrchestrator>) {
    this.unlockKeyring = options.unlockKeyring;
    this.createOrchestrator = options.createOrchestrator;
    this.loadRoutes = options.loadRoutes;
    this.onReady = options.onReady;
    this.onError = options.onError;
  }

  getOrchestrator() {
    return this.orchestrator;
  }

  async unlockAndActivate() {
    if (!this.shutdownRequested && this.orchestrator?.isActive()) return this.orchestrator;
    if (this.activationPromise) return this.activationPromise;

    const epoch = ++this.activationEpoch;
    this.shutdownRequested = false;
    this.activationPromise = (async () => {
      await this.unlockKeyring();
      const orchestrator = this.orchestrator ?? (await this.createOrchestrator());
      try {
        this.throwIfActivationCancelled(epoch);
        const routes = (await this.loadRoutes?.()) ?? [];
        this.throwIfActivationCancelled(epoch);
        await orchestrator.activate(routes);
        this.throwIfActivationCancelled(epoch);
        this.orchestrator = orchestrator;
        this.onReady?.(orchestrator);
        return orchestrator;
      } catch (error) {
        if (!this.orchestrator || this.orchestrator === orchestrator) {
          this.orchestrator = null;
          await orchestrator.shutdown();
        }
        throw error;
      }
    })()
      .catch((error) => {
        this.onError?.(error);
        throw error;
      })
      .finally(() => {
        this.activationPromise = null;
      });

    return this.activationPromise;
  }

  async shutdown() {
    this.shutdownRequested = true;
    this.activationEpoch += 1;
    const pending = this.activationPromise;
    const orchestrator = pending
      ? await pending.catch(() => null)
      : this.orchestrator;
    this.activationPromise = null;
    this.orchestrator = null;
    await orchestrator?.shutdown();
  }

  private throwIfActivationCancelled(epoch: number) {
    if (this.shutdownRequested || epoch !== this.activationEpoch) {
      throw new Error("p2p_activation_cancelled");
    }
  }
}
