import { describe, expect, it } from "vitest";
import {
  FILE_TRANSFER_AAD_BYTES,
  FileFrameAssembler,
  buildFileChunkAad,
  decryptFileChunk,
  deriveFileTransferMaterial,
  encryptFileChunk,
  splitFileChunkFrames,
  type FileTransferManifest,
} from "../fileTransferProtocol";

const manifest = (direction: "FORWARD" | "REVERSE" = "FORWARD"): FileTransferManifest => ({
  version: 1,
  transferId: "018f47a0-7b75-7cc1-8c3f-5bc637ff1077",
  transferSalt: Uint8Array.from({ length: 32 }, (_, i) => i),
  senderDeviceId: "018f47a0-7b75-7cc1-8c3f-5bc637ff1078",
  receiverDeviceId: "018f47a0-7b75-7cc1-8c3f-5bc637ff1079",
  direction,
  fileSize: 1024 * 1024 + 3,
  chunkSize: 1024 * 1024,
  totalChunks: 2,
  fileSha256: new Uint8Array(32),
});

describe("fileTransferProtocol", () => {
  it("uses the canonical 96-byte AAD layout", () => {
    const aad = buildFileChunkAad(manifest(), 1, 3);
    expect(aad).toHaveLength(FILE_TRANSFER_AAD_BYTES);
    const view = new DataView(aad.buffer);
    expect(view.getUint32(68, false)).toBe(1);
    expect(view.getUint32(72, false)).toBe(2);
    expect(view.getBigUint64(76, false)).toBe(1048576n);
    expect(view.getUint32(84, false)).toBe(3);
    expect(view.getBigUint64(88, false)).toBe(1048579n);
  });

  it("derives direction-separated keys and decrypts unordered chunks", async () => {
    const sessionKey = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
    const forward = await deriveFileTransferMaterial(sessionKey, manifest());
    const reverse = await deriveFileTransferMaterial(sessionKey, manifest("REVERSE"));
    expect(forward.key).not.toEqual(reverse.key);
    const first = new Uint8Array(1024 * 1024).fill(7);
    const last = Uint8Array.of(8, 9, 10);
    const encrypted = await Promise.all([
      encryptFileChunk(forward, manifest(), 0, first),
      encryptFileChunk(forward, manifest(), 1, last),
    ]);
    expect(await decryptFileChunk(forward, manifest(), 1, encrypted[1])).toEqual(last);
    expect(await decryptFileChunk(forward, manifest(), 0, encrypted[0])).toEqual(first);
  }, 15_000);

  it("assembles transport frames in arrival order without trusting it", () => {
    const ciphertext = Uint8Array.from({ length: 150_000 }, (_, i) => i % 251);
    const frames = splitFileChunkFrames(manifest().transferId, 0, ciphertext, 32 * 1024);
    const assembler = new FileFrameAssembler();
    let result: Uint8Array | null = null;
    for (const frame of [...frames].reverse()) result = assembler.push(frame) ?? result;
    expect(result).toEqual(ciphertext);
  });

  it("rejects overlapping frame ranges", () => {
    const frames = splitFileChunkFrames(manifest().transferId, 0, new Uint8Array(64 * 1024), 32 * 1024);
    const assembler = new FileFrameAssembler();
    assembler.push(frames[0]);
    expect(() => assembler.push({ ...frames[1], ciphertextOffset: 16 * 1024 })).toThrow("overlapping frame ranges");
  });
});
