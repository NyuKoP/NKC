import type { NativeWorkerClient } from "./nativeWorkerClient";
import type { OfflineQueueManager } from "./nativeOfflineQueueManager";
import type { OnionControllerHandle } from "./onionController";
import { coldStartTelemetry as cold } from "./coldStartTelemetry";

type OnionBackend = {
  worker: NativeWorkerClient;
  queue: OfflineQueueManager;
  controller: OnionControllerHandle;
};

type StartupSteps = {
  createWorker: () => NativeWorkerClient;
  createQueue: (worker: NativeWorkerClient) => Promise<OfflineQueueManager>;
  createController: (worker: NativeWorkerClient, queue: OfflineQueueManager) => Promise<OnionControllerHandle>;
  configureHiddenService: (controller: OnionControllerHandle) => void;
};

/** Owns the existing startup dependency chain. A failed attempt is cleaned up before retry. */
export class OnionStartup {
  private readonly steps: StartupSteps;
  private ready: OnionBackend | null = null;
  private pending: Promise<OnionBackend> | null = null;
  private closed = false;
  private attempt = 0;

  constructor(steps: StartupSteps) { this.steps = steps; }

  ensureReady(): Promise<OnionBackend> {
    if (this.closed) return Promise.reject(new Error("onion_startup_closed"));

    if (this.ready) {
      try {
        this.ready.worker.getInstanceId();
      } catch {
        return Promise.reject(new Error("native_worker_unavailable"));
      }

      return Promise.resolve(this.ready);
    }

    if (!this.pending) {
      this.pending = this.initialize().finally(() => { this.pending = null; });
    }

    return this.pending;
  }

  private async initialize(): Promise<OnionBackend> {
    const attempt = ++this.attempt;
    const end = cold.begin("onion.init.begin", { attempt });
    let worker: NativeWorkerClient | null = null;
    let queue: OfflineQueueManager | null = null;
    let controller: OnionControllerHandle | null = null;
    let stage: "worker" | "queue" | "controller" | "hidden_service" = "worker";

    try {
      worker = this.steps.createWorker();
      cold.mark("worker.start.begin", { attempt });
      await worker.start();
      cold.mark("worker.start.ok", { attempt });
      stage = "queue";
      cold.mark("queue.init.begin", { attempt });
      queue = await this.steps.createQueue(worker);
      cold.mark("queue.init.ok", { attempt });

      if (this.closed) throw new Error("onion_startup_closed");
      stage = "controller";
      cold.mark("controller.start.begin", { attempt });
      controller = await this.steps.createController(worker, queue);
      cold.mark("controller.start.ok", { attempt });

      if (this.closed) throw new Error("onion_startup_closed");
      stage = "hidden_service";
      this.steps.configureHiddenService(controller);
      queue.start();
      this.ready = { worker, queue, controller };
      end("onion.init.end", "ok");

      return this.ready;
    } catch {
      // Do not publish a partially initialized worker or a controller without native transport.
      queue?.stop();
      await Promise.allSettled([controller?.close(), worker?.stop()]);
      end("onion.init.end", "failed", { stage });
      throw new Error(this.closed ? "onion_startup_closed" : "onion_initialization_failed");
    }
  }

  /** Prevent late startup from publishing resources after app shutdown. */
  async close() {
    this.closed = true;
    await this.pending?.catch(() => {});
    const ready = this.ready;
    this.ready = null;
    ready?.queue.stop();
    await Promise.allSettled([ready?.controller.close(), ready?.worker.stop()]);
  }
}
