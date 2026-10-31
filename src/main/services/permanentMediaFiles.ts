import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { parseIncomingMediaRef, sanitizeMediaFilename } from "../../security/mediaPolicy";
import type { PermanentMediaRequest, PermanentMediaResult } from "../../media/permanentMediaTypes";

type FileTicket = {
  accountId: string; mediaId: string; size: number;
  directory: string; destination: string; temporary: string;
  digest?: string;
} & ({ version: 1; device: number; inode: number; modified?: number } |
  { version: 2; device: string; inode: string; modifiedNs?: string });

const exactFileId = (value: unknown): value is string => typeof value === "string" &&
  /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;

const exactTime = (value: unknown): value is string => typeof value === "string" && /^(0|-?[1-9][0-9]{0,21})$/.test(value);

type Dependencies = {
  chooseDestination: (name: string) => Promise<string | undefined>;
  protect: (value: string) => string;
  unprotect: (value: string) => string;
};

export const createPermanentMediaFiles = (dependencies: Dependencies) => {
  const issue = (ticket: FileTicket) => dependencies.protect(JSON.stringify(ticket));

  const parse = (token: string, accountId: string): FileTicket => {
    if (typeof token !== "string" || token.length > 32768) throw new Error("MEDIA_TICKET_INVALID");
    const t = JSON.parse(dependencies.unprotect(token));

    if (!t || (t.version !== 1 && t.version !== 2) || t.accountId !== accountId || typeof t.mediaId !== "string" ||
        !Number.isSafeInteger(t.size) || t.size <= 0 || t.size > 500 * 1024 * 1024 ||
        typeof t.directory !== "string" || !path.isAbsolute(t.directory) ||
        typeof t.destination !== "string" || path.dirname(t.destination) !== t.directory ||
        typeof t.temporary !== "string" || path.dirname(t.temporary) !== t.directory ||
        !/^\.nkc-decrypt-[a-f0-9-]{36}\.tmp$/.test(path.basename(t.temporary)) ||
        (t.digest !== undefined && !/^[a-f0-9]{64}$/.test(t.digest)) ||
        (t.version === 1
          ? !Number.isSafeInteger(t.device) || !Number.isSafeInteger(t.inode) || t.modifiedNs !== undefined ||
            (t.modified !== undefined && !Number.isFinite(t.modified))
          : !exactFileId(t.device) || !exactFileId(t.inode) || t.modified !== undefined ||
            (t.modifiedNs !== undefined && !exactTime(t.modifiedNs)) || (t.digest !== undefined && !exactTime(t.modifiedNs)))) {
      throw new Error("MEDIA_TICKET_INVALID");
    }

    return t;
  };

  const parent = async (t: FileTicket, assertOwner: () => void) => {
    assertOwner();

    if (await fs.realpath(t.directory) !== t.directory || (await fs.lstat(t.directory)).isSymbolicLink()) {
      throw new Error("MEDIA_DIRECTORY_CHANGED");
    }

    assertOwner();
  };

  const openOwned = async (t: FileTicket, file: string, writable: boolean, assertOwner: () => void) => {
    await parent(t, assertOwner);
    const before = await fs.lstat(file, { bigint: true });
    assertOwner();

    if (!before.isFile() || before.isSymbolicLink() || before.dev !== BigInt(t.device) || before.ino !== BigInt(t.inode)) {
      throw new Error("MEDIA_FILE_CHANGED");
    }

    const handle = await fs.open(file, writable ? "r+" : "r");

    try {
      const current = await handle.stat({ bigint: true });

      const modified = !t.digest || (t.version === 2 ? current.mtimeNs.toString() === t.modifiedNs :
        (await handle.stat()).mtimeMs === t.modified);

      assertOwner();

      if (current.dev !== before.dev || current.ino !== before.ino ||
          (t.digest && (current.size !== BigInt(t.size) || !modified))) throw new Error("MEDIA_FILE_CHANGED");

      return handle;
    } catch (error) { await handle.close(); throw error; }
  };

  const digest = async (handle: fs.FileHandle, assertOwner: () => void) => {
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;

    for (;;) {
      assertOwner();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      assertOwner();

      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }

    return hash.digest("hex");
  };

  return async (accountId: string, request: PermanentMediaRequest, assertOwner: () => void): Promise<PermanentMediaResult> => {
    assertOwner();

    if (!request || typeof request !== "object") throw new Error("MEDIA_REQUEST_INVALID");

    if (request.operation === "begin") {
      const media = request.media && parseIncomingMediaRef(request.media, request.media.ownerId);

      if (!media) throw new Error("MEDIA_MANIFEST_UNAVAILABLE");
      const selected = await dependencies.chooseDestination(sanitizeMediaFilename(media.name));
      assertOwner();

      if (!selected) return { cancelled: true };
      const name = path.basename(selected);

      if (!path.isAbsolute(selected) || /[<>:"|?*]/.test(name) || Array.from(name).some(character => character.charCodeAt(0) < 32) || /[. ]$/.test(name) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error("MEDIA_DESTINATION_INVALID");
      const directory = await fs.realpath(path.dirname(selected));
      const destination = path.join(directory, name), temporary = path.join(directory, `.nkc-decrypt-${randomUUID()}.tmp`);
      assertOwner();
      const handle = await fs.open(temporary, "wx", 0o600);

      try {
        const stat = await handle.stat({ bigint: true });
        assertOwner();

        return { token: issue({ version: 2, accountId, mediaId: media.ownerId, size: media.size,
          directory, destination, temporary, device: stat.dev.toString(), inode: stat.ino.toString() }) };
      } finally { await handle.close(); }
    }

    const t = parse(request.token, accountId);

    if (request.operation === "write") {
      if (t.digest || !(request.bytes instanceof Uint8Array) || !request.bytes.length || request.bytes.length > 1024 * 1024 ||
          !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset + request.bytes.length > t.size) {
        throw new Error("MEDIA_CHUNK_INVALID");
      }

      const handle = await openOwned(t, t.temporary, true, assertOwner);

      try {
        if ((await handle.stat()).size !== request.offset) throw new Error("MEDIA_OFFSET_CONFLICT");
        let written = 0;

        while (written < request.bytes.length) {
          assertOwner();
          const result = await handle.write(request.bytes, written, request.bytes.length - written, request.offset + written);

          if (!result.bytesWritten) throw new Error("MEDIA_WRITE_FAILED");
          written += result.bytesWritten;
        }

        assertOwner();
      } finally { await handle.close(); }

      return {};
    }

    if (request.operation === "seal") {
      const handle = await openOwned(t, t.temporary, true, assertOwner);

      try {
        if ((await handle.stat()).size !== t.size) throw new Error("MEDIA_INCOMPLETE");
        await handle.sync();
        const hash = await digest(handle, assertOwner);

        const stamp = t.version === 2 ? { modifiedNs: (await handle.stat({ bigint: true })).mtimeNs.toString() } :
          { modified: (await handle.stat()).mtimeMs };

        assertOwner();

        return { token: issue({ ...t, digest: hash, ...stamp }) };
      } finally { await handle.close(); }
    }

    if (request.operation === "discard") {
      await parent(t, assertOwner);

      try {
        const target = await fs.lstat(t.destination, { bigint: true });

        if (target.dev === BigInt(t.device) && target.ino === BigInt(t.inode)) throw new Error("MEDIA_PUBLICATION_MUST_RECOVER");
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      }

      try {
        const handle = await openOwned({ ...t, digest: undefined }, t.temporary, false, assertOwner);
        await handle.close();
        await parent(t, assertOwner);
        await fs.unlink(t.temporary);
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      }

      return {};
    }

    if (!t.digest) throw new Error("MEDIA_NOT_SEALED");

    if (request.operation === "publish") {
      let published = false;

      try {
        const existing = await openOwned(t, t.destination, false, assertOwner);

        try { if (await digest(existing, assertOwner) !== t.digest) throw new Error("MEDIA_FILE_CHANGED"); }
        finally { await existing.close(); }

        published = true;
      } catch (error) {
        // Only absence permits publication; a collision must preserve the encrypted source.
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      }

      if (!published) {
        const handle = await openOwned(t, t.temporary, false, assertOwner);

        try { if (await digest(handle, assertOwner) !== t.digest) throw new Error("MEDIA_FILE_CHANGED"); }
        finally { await handle.close(); }

        await parent(t, assertOwner);
        await fs.link(t.temporary, t.destination);
      }

      const final = await openOwned(t, t.destination, false, assertOwner);
      await final.close();

      try {
        const temporary = await openOwned(t, t.temporary, false, assertOwner);
        await temporary.close();
        await parent(t, assertOwner);
        await fs.unlink(t.temporary);
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      }

      assertOwner();

      return { token: issue(t) };
    }

    if (request.operation !== "read" || !Number.isSafeInteger(request.offset) || request.offset < 0 ||
        !Number.isSafeInteger(request.length) || request.length <= 0 || request.length > 1024 * 1024 ||
        request.offset + request.length > t.size) throw new Error("MEDIA_READ_INVALID");
    const handle = await openOwned(t, t.destination, false, assertOwner);

    try {
      if (request.offset === 0 && await digest(handle, assertOwner) !== t.digest) throw new Error("MEDIA_FILE_CHANGED");
      const bytes = new Uint8Array(request.length);
      let read = 0;

      while (read < bytes.length) {
        assertOwner();
        const result = await handle.read(bytes, read, bytes.length - read, request.offset + read);

        if (!result.bytesRead) throw new Error("MEDIA_FILE_CHANGED");
        read += result.bytesRead;
      }

      const stat = await handle.stat({ bigint: true });
      const modified = t.version === 2 ? stat.mtimeNs.toString() === t.modifiedNs : (await handle.stat()).mtimeMs === t.modified;
      assertOwner();

      if (stat.size !== BigInt(t.size) || !modified) throw new Error("MEDIA_FILE_CHANGED");

      return { bytes };
    } finally { await handle.close(); }
  };
};
