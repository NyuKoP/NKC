import { describe, expect, it } from "vitest";
import { encodeBinaryTransportPacket } from "../adapters/transports/packetCodec";
import { encodeBase64Url } from "../security/base64url";

const enabled = process.env.NKC_LARGE_TRANSFER_BENCH === "1";
const TOTAL_BYTES = 500 * 1024 * 1024;
const CHUNK_BYTES = 192 * 1024;

const runPipeline = (mode: "legacy" | "binary") => {
  const chunk = new Uint8Array(CHUNK_BYTES).fill(0x5a);
  const chunks = Math.ceil(TOTAL_BYTES / CHUNK_BYTES);
  const rssBefore = process.memoryUsage().rss;
  const startedAt = performance.now();
  let wireBytes = 0;

  for (let index = 0; index < chunks; index += 1) {
    const remaining = TOTAL_BYTES - index * CHUNK_BYTES;
    const payload = remaining >= CHUNK_BYTES ? chunk : chunk.subarray(0, remaining);
    if (mode === "legacy") {
      wireBytes += JSON.stringify({
        id: `benchmark-${index}`,
        payload: { b64: encodeBase64Url(payload) },
      }).length;
    } else {
      wireBytes += encodeBinaryTransportPacket({
        id: `benchmark-${index}`,
        payload,
      })!.byteLength;
    }
  }

  return {
    elapsedMs: Math.round(performance.now() - startedAt),
    rssDeltaMiB: Math.round((process.memoryUsage().rss - rssBefore) / 1024 / 1024),
    wireMiB: Math.round((wireBytes / 1024 / 1024) * 10) / 10,
  };
};

describe.skipIf(!enabled)("500MB streaming transport pipeline", () => {
  it(
    "measures bounded-chunk legacy and binary encoding",
    () => {
      const legacy = runPipeline("legacy");
      const binary = runPipeline("binary");
      console.info("[transfer-benchmark]", { payloadMiB: 500, legacy, binary });

      expect(binary.wireMiB).toBeLessThan(legacy.wireMiB);
      expect(binary.elapsedMs).toBeLessThan(legacy.elapsedMs);
    },
    120_000
  );
});
