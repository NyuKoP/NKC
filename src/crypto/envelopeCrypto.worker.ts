/// <reference lib="webworker" />

import { encryptEnvelope, type EnvelopeHeader } from "./box";
import { getSodium } from "../security/sodium";

type WorkerRequest =
  | { id: number; type: "prewarm" }
  | {
      id: number;
      type: "encrypt";
      key: Uint8Array;
      header: EnvelopeHeader;
      body: unknown;
      identityPrivateKey: Uint8Array;
    };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "prewarm") {
      await getSodium();
      scope.postMessage({ id: request.id, ok: true });
      return;
    }
    try {
      const envelope = await encryptEnvelope(
        request.key,
        request.header,
        request.body,
        request.identityPrivateKey
      );
      scope.postMessage({ id: request.id, ok: true, envelope });
    } finally {
      request.key.fill(0);
      request.identityPrivateKey.fill(0);
    }
  } catch (error) {
    scope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
