import { describe, expect, it, vi } from "vitest";
import {
  P2PLifecycleManager,
  registerP2PLifecycleHooks,
  type ElectronAppLike,
  type QuitEventLike,
} from "../lifecycleManager";

class FakeApp implements ElectronAppLike {
  readonly listeners = new Map<string, ((event?: QuitEventLike) => void)[]>();
  quit = vi.fn();

  on(event: "before-quit" | "will-quit", listener: (event?: QuitEventLike) => void) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: "before-quit" | "will-quit", payload?: QuitEventLike) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

describe("P2PLifecycleManager", () => {
  it("deduplicates concurrent shutdown calls", async () => {
    const orchestrator = { shutdown: vi.fn(async () => undefined) };
    const manager = new P2PLifecycleManager({
      getOrchestrator: () => orchestrator,
    });

    await Promise.all([manager.shutdown("logout"), manager.shutdown("before-quit")]);

    expect(orchestrator.shutdown).toHaveBeenCalledTimes(1);
    expect(manager.isShutdownComplete()).toBe(true);
  });

  it("prevents before-quit until orchestrator shutdown finishes", async () => {
    const app = new FakeApp();
    const preventDefault = vi.fn();
    const orchestrator = { shutdown: vi.fn(async () => undefined) };

    registerP2PLifecycleHooks(app, {
      getOrchestrator: () => orchestrator,
    });
    app.emit("before-quit", { preventDefault });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(orchestrator.shutdown).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it("runs afterShutdown after the orchestrator is stopped", async () => {
    const calls: string[] = [];
    const manager = new P2PLifecycleManager({
      getOrchestrator: () => ({
        shutdown: async () => {
          calls.push("orchestrator");
        },
      }),
      afterShutdown: async (reason) => {
        calls.push(reason);
      },
    });

    await manager.shutdown("logout");

    expect(calls).toEqual(["orchestrator", "logout"]);
  });
});
