import { describe, expect, it, vi } from "vitest";
import { P2PSyncInitController, type ActivatableP2POrchestrator } from "../p2pSyncInitController";

class FakeOrchestrator implements ActivatableP2POrchestrator {
  active = false;
  activate = vi.fn(async () => {
    this.active = true;
  });
  shutdown = vi.fn(async () => {
    this.active = false;
  });

  isActive() {
    return this.active;
  }
}

describe("P2PSyncInitController", () => {
  it("coalesces concurrent unlock and activate requests into one sequence", async () => {
    const orchestrator = new FakeOrchestrator();
    const unlockKeyring = vi.fn(async () => undefined);
    const createOrchestrator = vi.fn(() => orchestrator);
    const onReady = vi.fn();
    const controller = new P2PSyncInitController({
      unlockKeyring,
      createOrchestrator,
      loadRoutes: () => [],
      onReady,
    });

    const [first, second] = await Promise.all([
      controller.unlockAndActivate(),
      controller.unlockAndActivate(),
    ]);

    expect(first).toBe(orchestrator);
    expect(second).toBe(orchestrator);
    expect(unlockKeyring).toHaveBeenCalledTimes(1);
    expect(createOrchestrator).toHaveBeenCalledTimes(1);
    expect(orchestrator.activate).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("returns the active orchestrator without reactivating it", async () => {
    const orchestrator = new FakeOrchestrator();
    const controller = new P2PSyncInitController({
      unlockKeyring: async () => undefined,
      createOrchestrator: () => orchestrator,
    });

    await controller.unlockAndActivate();
    await controller.unlockAndActivate();

    expect(orchestrator.activate).toHaveBeenCalledTimes(1);
  });

  it("shuts down the activated orchestrator", async () => {
    const orchestrator = new FakeOrchestrator();
    const controller = new P2PSyncInitController({
      unlockKeyring: async () => undefined,
      createOrchestrator: () => orchestrator,
    });

    await controller.unlockAndActivate();
    await controller.shutdown();

    expect(orchestrator.shutdown).toHaveBeenCalledTimes(1);
    expect(controller.getOrchestrator()).toBeNull();
  });

  it("cancels an in-flight unlock before activate can publish readiness", async () => {
    const orchestrator = new FakeOrchestrator();
    const onReady = vi.fn();
    let resolveUnlock!: () => void;
    const controller = new P2PSyncInitController({
      unlockKeyring: () =>
        new Promise<void>((resolve) => {
          resolveUnlock = resolve;
        }),
      createOrchestrator: () => orchestrator,
      onReady,
    });

    const activation = controller.unlockAndActivate();
    const shutdown = controller.shutdown();
    resolveUnlock();

    await Promise.all([expect(activation).rejects.toThrow("p2p_activation_cancelled"), shutdown]);

    expect(orchestrator.activate).not.toHaveBeenCalled();
    expect(orchestrator.shutdown).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(controller.getOrchestrator()).toBeNull();
  });
});
