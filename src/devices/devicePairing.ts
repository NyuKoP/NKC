import { initializeAccountRoot, createDeviceAuthorization, commitDeviceAuthorization, acceptAccountRoot,
  getAccountRootIdentity, getAuthorizedDeviceRegistry, verifyDeviceAuthorization, type DeviceAuthorization, type DeviceAddedEvent } from "./deviceApprovals";
import { captureLocalOperationContext, type ReceiveContext } from "../accounts/receiveContext";
import { onAccountOwnerChange } from "../accounts/accountOwnerLifecycle";
import { onVaultKeyChange } from "../crypto/sessionKeyring";
import { getIdentityPublicKey, getIdentityPrivateKey, getDhPublicKey } from "../security/identityKeys";
import { getSodium } from "../security/sodium";
import { encodeBase64Url, decodeBase64Url } from "../security/base64url";
import { canonicalBytes } from "../crypto/canonicalJson";
import { encryptJsonRecord, decryptJsonRecord } from "../crypto/vault";
import { ensureLocalOnionEndpoint } from "../net/tor/localOnionEndpoint";
import { sanitizeRoutingHints } from "../net/privacy";
import { createDirectP2PTransport } from "../adapters/transports/directP2PTransport";
import { assertTorBackedTransport } from "../net/transportPolicy";
import { RendezvousClient, type RendezvousConfig } from "../net/rendezvousSignaling";
import { resolveInternalRendezvousConfig } from "../net/rendezvousConfig";
import { getOrCreateDeviceId } from "../security/deviceRole";
import { createId } from "../utils/ids";

export type SyncCodeState = {
  code: string;
  issuedAt: number;
  expiresAt: number;
  used: boolean;
};

export type PairingRequest = {
  requestId: string;
  code: string;
  deviceId: string;
  identityPub: string;
  dhPub: string;
  ts: number;
  rootLink?: { v: 2; root: string; expiresAt: number; route: NonNullable<DeviceAuthorization["route"]>; sig: string };
};

export type PairingResult = {
  requestId: string;
  status: "approved" | "rejected" | "error";
  message?: string;
  event?: DeviceAddedEvent;
  authorizations?: DeviceAuthorization[];
  confirmedRoot?: string;
};

type DirectSignalTransport = ReturnType<typeof createDirectP2PTransport> & {
  createOfferCode: () => Promise<string>;
  acceptSignalCode: (code: string) => Promise<void>;
  onSignalCode: (cb: (code: string) => void) => void;
  onState: (cb: (state: "idle" | "connecting" | "connected" | "failed" | "degraded") => void) => void;
};

export type RendezvousPairingStatus =
  | "idle"
  | "connecting"
  | "exchanging"
  | "connected"
  | "error";

export type RendezvousPairingSession = {
  syncCode: string;
  stop: () => void;
  getStatus: () => RendezvousPairingStatus;
  onStatus: (cb: (status: RendezvousPairingStatus) => void) => () => void;
};

const CHANNEL_NAME = "nkc-device-pairing-v1";

const REMOTE_PAIRING_CHANNEL = "nkc-pairing-v1";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const REMOTE_POLL_INTERVAL_MS = 1200;

const REMOTE_POLL_ERROR_INTERVAL_MS = 2500;

const activeCodes = new Map<string, SyncCodeState & { context?: ReceiveContext; rootAuthorization?: DeviceAuthorization; linkRequestId?: string }>();

const pendingRequests = new Map<string, PairingRequest>();

const requestListeners = new Set<(req: PairingRequest) => void>();

const resultListeners = new Set<(res: PairingResult) => void>();

const handledResults = new Set<string>();

const remotePollers = new Map<string, () => void>();

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;

type PairingMessage =
  | {
      type: "PAIR_REQ";
      code: string;
      requestId: string;
      deviceId: string;
      identityPub: string;
      dhPub: string;
      ts: number;
      rootLink?: PairingRequest["rootLink"];
    }
  | {
      type: "PAIR_RES";
      code?: string;
      requestId: string;
      status: PairingResult["status"];
      message?: string;
      event?: DeviceAddedEvent;
      authorizations?: DeviceAuthorization[];
    };

type RemotePairingPayload = {
  channel: typeof REMOTE_PAIRING_CHANNEL;
  version: 1;
  message: PairingMessage;
};

const ROOT_LINK_PREFIX = "NKC-DEVICE2-";

const normalizeCode = (value: string) => value.trim().startsWith(ROOT_LINK_PREFIX) ? value.trim() : value.replace(/[\s-]+/g, "").toUpperCase();

const rootInvite = (code: string) => {
  try {
  if (!code.startsWith(ROOT_LINK_PREFIX) || code.length > 512) throw new Error("DEVICE_LINK_INVALID");

  const invite = JSON.parse(new TextDecoder().decode(decodeBase64Url(code.slice(ROOT_LINK_PREFIX.length)))) as
    { v: 2; root: string; secret: string; expiresAt: number };

  if (invite.v !== 2 || decodeBase64Url(invite.root).length !== 32 || decodeBase64Url(invite.secret).length !== 32 ||
      !Number.isSafeInteger(invite.expiresAt) || invite.expiresAt <= Date.now() || invite.expiresAt > Date.now() + DEFAULT_TTL_MS) {
    throw new Error("DEVICE_LINK_INVALID");
  }

  return invite;
  } catch { throw new Error("DEVICE_LINK_INVALID"); }
};

const rootRoom = async (code: string) => encodeBase64Url((await getSodium()).crypto_generichash(32,
  canonicalBytes({ domain: "nkc-device-link-v2", secret: rootInvite(code).secret })));

const getMessageCode = (message: PairingMessage) => {
  if (message.type === "PAIR_REQ") return normalizeCode(message.code);

  if (!message.code) return null;

  return normalizeCode(message.code);
};

const toRemotePayload = (message: PairingMessage): string =>
  JSON.stringify({
    channel: REMOTE_PAIRING_CHANNEL,
    version: 1,
    message,
  } satisfies RemotePairingPayload);

const fromRemotePayload = async (payload: string, code: string): Promise<PairingMessage | null> => {
  try {
    if (code.startsWith(ROOT_LINK_PREFIX)) {
      const message = await decryptJsonRecord<PairingMessage>(decodeBase64Url(rootInvite(code).secret), await rootRoom(code), "device-link", payload);

      if (getMessageCode(message) !== code) return null;

      return message;
    }

    const parsed = JSON.parse(payload) as Partial<RemotePairingPayload>;

    if (!parsed || parsed.channel !== REMOTE_PAIRING_CHANNEL || parsed.version !== 1) return null;

    if (!parsed.message || typeof parsed.message !== "object" || !("type" in parsed.message)) return null;
    const type = parsed.message.type;

    if (type !== "PAIR_REQ" && type !== "PAIR_RES") return null;

    return parsed.message;
  } catch {
    return null;
  }
};

const resolveRendezvousConfig = async (): Promise<RendezvousConfig> => {
  return resolveInternalRendezvousConfig();
};

const createRendezvousClient = async (code?: string) => {
  const config = await resolveRendezvousConfig();

  return new RendezvousClient(code?.startsWith(ROOT_LINK_PREFIX) ? { ...config, useOnionProxy: true } : config);
};

const stopRemotePoller = (code: string) => {
  const normalized = normalizeCode(code);
  const stop = remotePollers.get(normalized);

  if (!stop) return;
  remotePollers.delete(normalized);
  stop();
};

const ensureRemotePoller = (code: string) => {
  const normalized = normalizeCode(code);

  if (!normalized || remotePollers.has(normalized) || typeof window === "undefined") return;

  let stopped = false;
  let timer: number | null = null;
  let afterTs = 0;

  const stop = () => {
    stopped = true;

    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = window.setTimeout(tick, delayMs);
  };

  const tick = async () => {
    if (stopped) return;

    try {
      if (normalized.startsWith(ROOT_LINK_PREFIX)) {
        rootInvite(normalized);
        const context = activeCodes.get(normalized)?.context;

        if (!context) throw new Error("OWNER_SESSION_CHANGED");
        await context.vault.assertMain();
      }

      const client = await createRendezvousClient(normalized);
      const result = await client.poll(normalized.startsWith(ROOT_LINK_PREFIX) ? await rootRoom(normalized) : normalized, getOrCreateDeviceId(), afterTs);
      afterTs = result.nextAfterTs;

      for (const item of result.items) {
        const message = await fromRemotePayload(item.payload, normalized);

        if (!message) continue;
        await handleMessage(message).catch(() => {});
      }

      schedule(REMOTE_POLL_INTERVAL_MS);
    } catch {
      if (normalized.startsWith(ROOT_LINK_PREFIX)) {
        try { rootInvite(normalized); await activeCodes.get(normalized)?.context?.vault.assertMain(); }
        catch { stopRemotePoller(normalized);

 return; }
      }

      schedule(REMOTE_POLL_ERROR_INTERVAL_MS);
    }
  };

  remotePollers.set(normalized, stop);
  schedule(50);
};

const publishRemoteMessage = (message: PairingMessage) => {
  const code = getMessageCode(message);

  if (!code) return;
  ensureRemotePoller(code);

  return (async () => {
    try {
      const root = code.startsWith(ROOT_LINK_PREFIX);
      const context = activeCodes.get(code)?.context;

      if (root && !context) throw new Error("OWNER_SESSION_CHANGED");

      if (root) await context!.vault.assertMain();
      const client = await createRendezvousClient(code);
      const room = root ? await rootRoom(code) : code;
      const payload = root ? await encryptJsonRecord(decodeBase64Url(rootInvite(code).secret), room, "device-link", message) : toRemotePayload(message);

      if (root) await context!.vault.assertMain();
      await client.publish(room, getOrCreateDeviceId(), [payload]);
    } catch {
      if (code.startsWith(ROOT_LINK_PREFIX)) throw new Error("DEVICE_LINK_PUBLISH_FAILED");
      // keep local flow alive even if remote signaling is unavailable
    }
  })();
};

const toBase32 = (bytes: Uint8Array) => {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      const index = (value >> (bits - 5)) & 31;
      output += CODE_ALPHABET[index];
      bits -= 5;
    }
  }

  if (bits > 0) {
    const index = (value << (5 - bits)) & 31;
    output += CODE_ALPHABET[index];
  }

  return output;
};

const generateShortSyncCode = () => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable.");
  }

  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  const raw = toBase32(bytes).slice(0, 6);

  return `NKC-SYNC1-${raw}`;
};

const generateCode = () => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable.");
  }

  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  const raw = toBase32(bytes).slice(0, 8);
  const partA = raw.slice(0, 4);
  const partB = raw.slice(4, 8);

  return `NKC-SYNC-${partA}-${partB}`;
};

const cleanupExpiredCodes = () => {
  const now = Date.now();

  for (const [code, entry] of activeCodes.entries()) {
    if (entry.expiresAt <= now) {
      activeCodes.delete(code);
      stopRemotePoller(code);
    }
  }
};

const emitRequest = (req: PairingRequest) => {
  requestListeners.forEach((listener) => {
    try {
      listener(req);
    } catch {
      // ignore listener errors
    }
  });
};

const emitResult = (res: PairingResult) => {
  resultListeners.forEach((listener) => {
    try {
      listener(res);
    } catch {
      // ignore listener errors
    }
  });
};

const postMessage = (message: PairingMessage) => {
  if (getMessageCode(message)?.startsWith(ROOT_LINK_PREFIX)) return publishRemoteMessage(message);

  if (channel) {
    channel.postMessage(message);
  } else {
    handleMessage(message);
  }

  void publishRemoteMessage(message);

  return Promise.resolve();
};

const respondWithError = (requestId: string, message: string, code?: string) => {
  postMessage({ type: "PAIR_RES", requestId, status: "error", message, code });
};

const handlePairReq = async (message: Extract<PairingMessage, { type: "PAIR_REQ" }>) => {
  cleanupExpiredCodes();
  const code = normalizeCode(message.code);

  if (pendingRequests.has(message.requestId)) return;
  const entry = activeCodes.get(code);

  if (!entry) {
    respondWithError(message.requestId, "코드가 유효하지 않습니다.", code);

    return;
  }

  if (code.startsWith(ROOT_LINK_PREFIX)) {
    if (!entry.context || !entry.rootAuthorization || !message.rootLink) return;
    await entry.context.vault.assertMain();
    const invite = rootInvite(code), proof = message.rootLink;
    const { sig, ...link } = proof;

    const request = { requestId: message.requestId, deviceId: message.deviceId, identityPub: message.identityPub,
      dhPub: message.dhPub, ts: message.ts, rootLink: link };

    const route = sanitizeRoutingHints(proof.route);

    if (proof.v !== 2 || proof.root !== invite.root || proof.expiresAt !== invite.expiresAt ||
        route?.deviceId !== message.deviceId || route.onionAddr !== proof.route.onionAddr || route.inboxWriteToken !== proof.route.inboxWriteToken ||
        !Number.isSafeInteger(message.ts) || Math.abs(Date.now() - message.ts) > DEFAULT_TTL_MS ||
        decodeBase64Url(message.dhPub).length !== 32 || !await getSodium().then(sodium => sodium.crypto_sign_verify_detached(
          decodeBase64Url(sig), canonicalBytes(request), decodeBase64Url(message.identityPub)))) return;
  } else if (message.rootLink) return;

  if (entry.expiresAt <= Date.now()) {
    activeCodes.delete(code);
    stopRemotePoller(code);
    respondWithError(message.requestId, "코드가 만료되었습니다.", code);

    return;
  }

  if (entry.used) {
    respondWithError(message.requestId, "코드가 이미 사용되었습니다.", code);

    return;
  }

  entry.used = true;

  const req: PairingRequest = {
    requestId: message.requestId,
    code: entry.code,
    deviceId: message.deviceId,
    identityPub: message.identityPub,
    dhPub: message.dhPub,
    ts: message.ts ?? Date.now(),
    ...(message.rootLink ? { rootLink: message.rootLink } : {}),
  };

  pendingRequests.set(req.requestId, req);
  emitRequest(req);
};

const handlePairRes = (message: Extract<PairingMessage, { type: "PAIR_RES" }>) => {
  const resultKey = `${message.requestId}:${message.status}`;

  if (handledResults.has(resultKey)) return;
  handledResults.add(resultKey);

  if (handledResults.size > 1000) {
    handledResults.clear();
  }

  if (message.code) {
    stopRemotePoller(message.code);
  }

  emitResult({
    requestId: message.requestId,
    status: message.status,
    message: message.message,
    event: message.event,
    authorizations: message.authorizations,
    confirmedRoot: message.code?.startsWith(ROOT_LINK_PREFIX) ? rootInvite(message.code).root : undefined,
  });
};

const handleMessage = async (message: PairingMessage) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;

  if (message.type === "PAIR_REQ") {
    await handlePairReq(message);

    return;
  }

  if (message.type === "PAIR_RES") {
    handlePairRes(message);
  }
};

if (channel) {
  channel.onmessage = (event) => {
    if (getMessageCode(event.data as PairingMessage)?.startsWith(ROOT_LINK_PREFIX)) return;
    void handleMessage(event.data as PairingMessage).catch(() => {});
  };
}

const localLinkRoute = async (context: ReceiveContext): Promise<NonNullable<DeviceAuthorization["route"]>> => {
  const onionAddr = await ensureLocalOnionEndpoint();
  const deviceId = getOrCreateDeviceId(context);
  const mailbox = await window.nkc?.registerOnionMailbox?.(deviceId, context.owner.session);
  await context.vault.assertMain();

  if (!onionAddr || !mailbox?.ok || !mailbox.inboxWriteToken) throw new Error("DEVICE_ROUTE_UNAVAILABLE");

  return { onionAddr, deviceId, inboxWriteToken: mailbox.inboxWriteToken };
};

/** Explicit existing-device opt-in. The invitation contains a short-lived bearer secret, never a private identity. */
export const createRootSyncCode = async (context?: ReceiveContext, route?: NonNullable<DeviceAuthorization["route"]>): Promise<SyncCodeState> => {
  context ??= await captureLocalOperationContext();

  if (!context) throw new Error("OWNER_REQUIRED");
  const rootAuthorization = await initializeAccountRoot(context, route ?? await localLinkRoute(context));
  const issuedAt = Date.now(), expiresAt = issuedAt + DEFAULT_TTL_MS;

  const code = ROOT_LINK_PREFIX + encodeBase64Url(canonicalBytes({ v: 2, root: rootAuthorization.accountRootIdentityPub,
    secret: encodeBase64Url((await getSodium()).randombytes_buf(32)), expiresAt }));

  const state = { code, issuedAt, expiresAt, used: false };
  activeCodes.set(code, { ...state, context, rootAuthorization });
  ensureRemotePoller(code);

  return state;
};

export const submitRootSyncCode = async (code: string, context?: ReceiveContext,
  route?: NonNullable<DeviceAuthorization["route"]>) => {
  const invite = rootInvite(code);
  context ??= await captureLocalOperationContext();

  if (!context || await getAccountRootIdentity(context)) throw new Error("NEW_DEVICE_REQUIRED");
  const localRoute = route ?? await localLinkRoute(context);
  const rootLink = { v: 2 as const, root: invite.root, expiresAt: invite.expiresAt, route: localRoute };

  const request = { requestId: createId(), deviceId: getOrCreateDeviceId(context),
    identityPub: encodeBase64Url(await getIdentityPublicKey(context)), dhPub: encodeBase64Url(await getDhPublicKey(context)),
    ts: Date.now(), rootLink };

  const sig = encodeBase64Url((await getSodium()).crypto_sign_detached(canonicalBytes(request), await getIdentityPrivateKey(context)));
  await context.vault.assertMain();
  activeCodes.set(code, { code, issuedAt: Date.now(), expiresAt: invite.expiresAt, used: true, context, linkRequestId: request.requestId });
  await postMessage({ type: "PAIR_REQ", code, ...request, rootLink: { ...rootLink, sig } });

  return request.requestId;
};

export const approveRootPairingRequest = async (requestId: string) => {
  const request = pendingRequests.get(requestId);
  const entry = request && activeCodes.get(request.code);

  if (!request?.rootLink || !entry?.context || !entry.rootAuthorization) throw new Error("DEVICE_LINK_INVALID");
  rootInvite(request.code);
  const previous = (await getAuthorizedDeviceRegistry(entry.context))[request.deviceId];

  if (previous && (previous.kind !== "DEVICE_ADDED" || previous.identityPub !== request.identityPub ||
      previous.dhPub !== request.dhPub || JSON.stringify(previous.route) !== JSON.stringify(request.rootLink.route))) throw new Error("DEVICE_AUTHORIZATION_CONFLICT");

  const event = previous ?? await createDeviceAuthorization({ kind: "DEVICE_ADDED", deviceId: request.deviceId,
    identityPub: request.identityPub, dhPub: request.dhPub, role: "secondary", epoch: 1, route: request.rootLink.route }, entry.context);

  await commitDeviceAuthorization(event, request.rootLink.root, entry.context);
  const authorizations = Object.values(await getAuthorizedDeviceRegistry(entry.context));
  await postMessage({ type: "PAIR_RES", requestId, code: request.code, status: "approved", authorizations });
  pendingRequests.delete(requestId);

  return event;
};

export const acceptRootPairingResult = async (code: string, result: PairingResult) => {
  const invite = rootInvite(code), entry = activeCodes.get(code), context = entry?.context;
  const certificates = result.authorizations;

  if (!context || entry?.rootAuthorization || entry?.linkRequestId !== result.requestId || result.status !== "approved" || result.confirmedRoot !== invite.root ||
      !certificates?.length || certificates.length > 32) throw new Error("DEVICE_LINK_INVALID");
  const own = certificates.filter(item => item.deviceId === getOrCreateDeviceId(context));

  const approver = own[0] && certificates.find(item => item.deviceId === own[0].approvedBy && item.kind === "DEVICE_ADDED");
  if (own.length !== 1 || !approver || !certificates.some(item => item.identityPub === invite.root) ||
      new Set(certificates.map(item => item.deviceId)).size !== certificates.length ||
      !(await Promise.all(certificates.map(item => verifyDeviceAuthorization(item, invite.root)))).every(Boolean)) throw new Error("DEVICE_LINK_INVALID");
  await acceptAccountRoot(invite.root, own[0], context, certificates.filter(certificate => certificate.deviceId !== own[0].deviceId));
  stopRemotePoller(code); activeCodes.delete(code);

  return approver;
};

export const cancelSyncCode = (code: string) => {
  const normalized = normalizeCode(code);
  stopRemotePoller(normalized); activeCodes.delete(normalized);

  for (const [id, request] of pendingRequests) if (request.code === normalized) pendingRequests.delete(id);
};

const cancelOwnedLinks = () => {
  for (const [code, entry] of activeCodes) if (entry.context) cancelSyncCode(code);
};

onAccountOwnerChange(cancelOwnedLinks);

onVaultKeyChange(cancelOwnedLinks);

export const createSyncCode = (ttlMs: number = DEFAULT_TTL_MS): SyncCodeState => {
  cleanupExpiredCodes();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;
  const formatted = generateCode();
  const normalized = normalizeCode(formatted);
  const entry: SyncCodeState = { code: formatted, issuedAt, expiresAt, used: false };
  activeCodes.set(normalized, entry);
  ensureRemotePoller(normalized);

  return entry;
};

export const getSyncCodeState = (code: string) => {
  const entry = activeCodes.get(normalizeCode(code));

  if (!entry) return null;

  return { code: entry.code, issuedAt: entry.issuedAt, expiresAt: entry.expiresAt, used: entry.used };
};

export const onPairingRequest = (listener: (req: PairingRequest) => void) => {
  requestListeners.add(listener);

  return () => requestListeners.delete(listener);
};

export const onPairingResult = (listener: (res: PairingResult) => void) => {
  resultListeners.add(listener);

  return () => resultListeners.delete(listener);
};

export const submitSyncCode = (payload: {
  code: string;
  deviceId: string;
  identityPub: string;
  dhPub: string;
}) => {
  const normalizedCode = normalizeCode(payload.code);

  if (normalizedCode.startsWith(ROOT_LINK_PREFIX)) throw new Error("VERSIONED_DEVICE_LINK_REQUIRED");
  ensureRemotePoller(normalizedCode);
  const requestId = createId();
  postMessage({
    type: "PAIR_REQ",
    code: normalizedCode,
    requestId,
    deviceId: payload.deviceId,
    identityPub: payload.identityPub,
    dhPub: payload.dhPub,
    ts: Date.now(),
  });

  return requestId;
};

export const approvePairingRequest = (requestId: string, event: DeviceAddedEvent) => {
  const request = pendingRequests.get(requestId);
  pendingRequests.delete(requestId);
  postMessage({
    type: "PAIR_RES",
    requestId,
    code: request?.code ? normalizeCode(request.code) : undefined,
    status: "approved",
    event,
  });
};

export const rejectPairingRequest = (requestId: string, message: string) => {
  const request = pendingRequests.get(requestId);
  pendingRequests.delete(requestId);
  void postMessage({
    type: "PAIR_RES",
    requestId,
    code: request?.code ? normalizeCode(request.code) : undefined,
    status: "rejected",
    message,
  })?.catch(() => {});
};

const createRendezvousSession = (syncCode: string) => {
  let status: RendezvousPairingStatus = "idle";
  const listeners = new Set<(next: RendezvousPairingStatus) => void>();

  const setStatus = (next: RendezvousPairingStatus) => {
    status = next;
    listeners.forEach((listener) => listener(next));
  };

  return {
    syncCode,
    setStatus,
    getStatus: () => status,
    onStatus: (cb: (next: RendezvousPairingStatus) => void) => {
      listeners.add(cb);

      return () => listeners.delete(cb);
    },
  };
};

const startPolling = (args: {
  client: RendezvousClient;
  syncCode: string;
  deviceId: string;
  onItems: (payloads: string[]) => Promise<void>;
  onError: (error: unknown) => void;
  setStatus: (status: RendezvousPairingStatus) => void;
  activeRef: { current: boolean };
}) => {
  let afterTs = 0;
  let timer: number | null = null;
  const intervals = [900, 1500, 2500];
  let backoffIndex = 0;

  const tick = async () => {
    if (!args.activeRef.current) return;

    try {
      const result = await args.client.poll(args.syncCode, args.deviceId, afterTs);
      afterTs = result.nextAfterTs;
      backoffIndex = 0;

      if (result.items.length) {
        const payloads = result.items.map((item) => item.payload);
        await args.onItems(payloads);

        if (args.activeRef.current) args.setStatus("exchanging");
      }
    } catch (error) {
      backoffIndex = Math.min(backoffIndex + 1, intervals.length - 1);
      args.onError(error);
    }

    if (!args.activeRef.current) return;
    const delay = intervals[backoffIndex];
    timer = window.setTimeout(tick, delay);
  };

  timer = window.setTimeout(tick, intervals[0]);

  return () => {
    if (timer) window.clearTimeout(timer);
  };
};

export const startRendezvousPairingAsHost = (args: {
  syncCode?: string;
  deviceId: string;
  rendezvousConfig: RendezvousConfig;
  transport?: DirectSignalTransport;
}): RendezvousPairingSession => {
  if (!args.transport) assertTorBackedTransport("directP2P");
  const syncCode = args.syncCode ?? generateShortSyncCode();
  const session = createRendezvousSession(syncCode);
  const activeRef = { current: true };
  const client = new RendezvousClient(args.rendezvousConfig);
  const transport = args.transport ?? createDirectP2PTransport();

  const stopPolling = startPolling({
    client,
    syncCode,
    deviceId: args.deviceId,
    onItems: async (payloads) => {
      await Promise.all(payloads.map((payload) => transport.acceptSignalCode(payload)));
    },
    onError: () => session.setStatus("error"),
    setStatus: session.setStatus,
    activeRef,
  });

  transport.onSignalCode((code) => {
    if (!activeRef.current) return;
    void client.publish(syncCode, args.deviceId, [code]).catch(() => {
      if (activeRef.current) session.setStatus("error");
    });
  });

  transport.onState((next) => {
    if (!activeRef.current) return;

    if (next === "connected") session.setStatus("connected");
  });

  const start = async () => {
    try {
      session.setStatus("connecting");
      await transport.start();
      const offer = await transport.createOfferCode();
      await client.publish(syncCode, args.deviceId, [offer]);
      session.setStatus("exchanging");
    } catch {
      session.setStatus("error");
    }
  };

  void start();

  return {
    syncCode,
    getStatus: session.getStatus,
    onStatus: session.onStatus,
    stop: () => {
      activeRef.current = false;
      stopPolling();
      void transport.stop();
      session.setStatus("idle");
    },
  };
};

export const startRendezvousPairingAsGuest = (args: {
  syncCode: string;
  deviceId: string;
  rendezvousConfig: RendezvousConfig;
  transport?: DirectSignalTransport;
}): RendezvousPairingSession => {
  if (!args.transport) assertTorBackedTransport("directP2P");
  const session = createRendezvousSession(args.syncCode);
  const activeRef = { current: true };
  const client = new RendezvousClient(args.rendezvousConfig);
  const transport = args.transport ?? createDirectP2PTransport();

  const stopPolling = startPolling({
    client,
    syncCode: args.syncCode,
    deviceId: args.deviceId,
    onItems: async (payloads) => {
      await Promise.all(payloads.map((payload) => transport.acceptSignalCode(payload)));
    },
    onError: () => session.setStatus("error"),
    setStatus: session.setStatus,
    activeRef,
  });

  transport.onSignalCode((code) => {
    if (!activeRef.current) return;
    void client.publish(args.syncCode, args.deviceId, [code]).catch(() => {
      if (activeRef.current) session.setStatus("error");
    });
  });

  transport.onState((next) => {
    if (!activeRef.current) return;

    if (next === "connected") session.setStatus("connected");
  });

  const start = async () => {
    try {
      session.setStatus("connecting");
      await transport.start();
    } catch {
      session.setStatus("error");
    }
  };

  void start();

  return {
    syncCode: args.syncCode,
    getStatus: session.getStatus,
    onStatus: session.onStatus,
    stop: () => {
      activeRef.current = false;
      stopPolling();
      void transport.stop();
      session.setStatus("idle");
    },
  };
};
