import type { Envelope, EnvelopeHeader } from "./box";

type Pending = {
  resolve: (value: Envelope | undefined) => void;
  reject: (error: Error) => void;
};

type WorkerSlot = {
  worker: Worker;
  pending: number;
};

export class EnvelopeCryptoPool {
  private readonly slots: WorkerSlot[];
  private readonly requests = new Map<number, Pending>();
  private nextId = 1;

  constructor(size: number) {
    const boundedSize = Math.max(1, Math.min(2, Math.trunc(size)));
    this.slots = Array.from({ length: boundedSize }, () => {
      const worker = new Worker(new URL("./envelopeCrypto.worker.ts", import.meta.url), {
        type: "module",
        name: "nkc-envelope-crypto",
      });
      const slot: WorkerSlot = { worker, pending: 0 };
      worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; envelope?: Envelope; error?: string }>) => {
        const pending = this.requests.get(event.data.id);
        if (!pending) return;
        this.requests.delete(event.data.id);
        slot.pending = Math.max(0, slot.pending - 1);
        if (event.data.ok) pending.resolve(event.data.envelope);
        else pending.reject(new Error(event.data.error ?? "Envelope encryption worker failed"));
      };
      worker.onerror = (event) => {
        for (const [id, pending] of this.requests) {
          pending.reject(new Error(event.message || "Envelope encryption worker crashed"));
          this.requests.delete(id);
        }
        slot.pending = 0;
      };
      return slot;
    });
  }

  private request<T extends Envelope | undefined>(slot: WorkerSlot, payload: object): Promise<T> {
    const id = this.nextId++;
    slot.pending += 1;
    return new Promise<T>((resolve, reject) => {
      this.requests.set(id, {
        resolve: resolve as (value: Envelope | undefined) => void,
        reject,
      });
      slot.worker.postMessage({ id, ...payload });
    });
  }

  async prewarm(): Promise<void> {
    await Promise.all(this.slots.map((slot) => this.request(slot, { type: "prewarm" })));
  }

  async encrypt(
    key: Uint8Array,
    header: EnvelopeHeader,
    body: unknown,
    identityPrivateKey: Uint8Array
  ): Promise<Envelope> {
    const slot = this.slots.reduce((best, candidate) =>
      candidate.pending < best.pending ? candidate : best
    );
    const envelope = await this.request<Envelope>(slot, {
      type: "encrypt",
      key,
      header,
      body,
      identityPrivateKey,
    });
    if (!envelope) throw new Error("Envelope encryption worker returned no envelope");
    return envelope;
  }

  close(): void {
    for (const pending of this.requests.values()) {
      pending.reject(new Error("Envelope encryption worker closed"));
    }
    this.requests.clear();
    for (const slot of this.slots) slot.worker.terminate();
  }
}
