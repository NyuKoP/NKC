import { canonicalBytes } from "../crypto/canonicalJson";
import type { ReceiveContext } from "../accounts/receiveContext";
import { getLastEventHash, listProfiles, saveEvent } from "../db/repo";
import { createId } from "../utils/ids";
import { encodeBase64Url, decodeBase64Url } from "../security/base64url";
import { getDhPublicKey, getIdentityPrivateKey, getIdentityPublicKey } from "../security/identityKeys";
import { getPublicStore } from "../security/publicStore";
import { getSodium } from "../security/sodium";
import { getOrCreateDeviceId } from "../security/deviceRole";
import { writeVault } from "../db/vaultAccess";
import { VAULT_REGISTRY_KEY, getRegistry, encodeDeviceRegistry } from "./deviceRegistry";
import { encryptJsonRecord, sameStoredCiphertext } from "../crypto/vault";
import { authorityMetaKey, authorityState, authorityDigest, assertAuthorityFresh, prepareAuthorityMutation,
  matchCurrentAuthority, readRootRecoveryCheckpoint, experimentalWitnessEnabled } from "../freshness/authorityCheckpoint";
import { selectSecurityUpdates } from "./securityState";
import { assertNoLocalRollback, compareLocalRollbackHint } from "../freshness/localRollbackHint";

import type { DeviceAuthorization } from "./deviceAuthorization";
import { verifyDeviceCertificate, authorizationIssuersAllowed, MAX_AUTHORITY_ROSTER_BYTES } from "./deviceAuthorization";
export type { DeviceAuthorization } from "./deviceAuthorization";

export const ACCOUNT_ROOT_META_KEY = "nkc_account_root_v1";

export const verifyDeviceAuthorization = async (event: DeviceAuthorization, pinnedRoot: string) => {
  return verifyDeviceCertificate(event, pinnedRoot, async (payload, sig, key) => {
    const bytes = decodeBase64Url(key);
    return encodeBase64Url(bytes) === key && (await getSodium()).crypto_sign_verify_detached(decodeBase64Url(sig), payload, bytes);
  });
};

const certificateDigest = async (bytes: Uint8Array) => encodeBase64Url((await getSodium()).crypto_hash_sha256(bytes));
const assertIssuerState = async (certificates: DeviceAuthorization[], registry: Record<string, DeviceAuthorization>) => {
  if (!(await Promise.all(certificates.map(certificate => authorizationIssuersAllowed(certificate, registry, certificateDigest)))).every(Boolean)) {
    throw new Error("DEVICE_ISSUER_REVOKED");
  }
};

export const getAccountRootIdentity = async (context: ReceiveContext) => {
  await context.vault.assertMain();
  const root = (await context.vault.db.meta.get(ACCOUNT_ROOT_META_KEY))?.value;
  context.vault.assertLocal();

  return root ?? null;
};

export const createDeviceAuthorization = async (input: Omit<DeviceAuthorization,
  "v" | "accountRootIdentityPub" | "approvedBy" | "sig" | "ts" | "expiresAt"> & { expiresAt?: number }, context: ReceiveContext) => {
  const root = await getAccountRootIdentity(context);
  const own = encodeBase64Url(await getIdentityPublicKey(context));

  if (!root) throw new Error("ACCOUNT_ROOT_AUTHORITY_REQUIRED");
  await assertNoLocalRollback(root, Object.values(await readSignedDeviceRegistry(context)), context);
  await assertAuthorityFresh(root, await getRegistry(context), context);
  const local = (await getAuthorizedDeviceRegistry(context))[getOrCreateDeviceId(context)];

  if (local?.kind !== "DEVICE_ADDED" || local.identityPub !== own || local.dhPub !== encodeBase64Url(await getDhPublicKey(context))) throw new Error("DEVICE_AUTHORITY_REVOKED");
  // shortcut: experimental Witness transitions remain Root-signed; extend that protocol before delegated writes there.
  if (experimentalWitnessEnabled() && root !== own) throw new Error("WITNESS_DELEGATION_UNSUPPORTED");
  let issuer = local;
  while (issuer.issuer?.deviceId === local.deviceId) issuer = issuer.issuer;
  const retained = new Set<string>();
  if (input.kind === "DEVICE_REVOKED") {
    const registry = await getAuthorizedDeviceRegistry(context), target = registry[input.deviceId];
    if (!target || target.kind !== "DEVICE_ADDED" || input.deviceId === local.deviceId) throw new Error("DEVICE_AUTHORITY_REQUIRED");
    for (const entry of Object.values(registry)) {
      for (let certificate: DeviceAuthorization | undefined = entry; certificate; certificate = certificate.issuer) {
        if (certificate.v === 3 ? certificate.approvedBy === target.deviceId : target.identityPub === root) {
          retained.add(await certificateDigest(canonicalBytes(certificate)));
        }
      }
    }
  }

  const payload = { kind: input.kind, deviceId: input.deviceId, identityPub: input.identityPub, dhPub: input.dhPub,
    role: input.role, epoch: input.epoch, ...(input.route ? { route: input.route } : {}),
    v: root === own && input.kind === "DEVICE_ADDED" ? 2 as const : 3 as const, accountRootIdentityPub: root,
    approvedBy: getOrCreateDeviceId(context),
    ts: Date.now(), expiresAt: input.kind === "DEVICE_ADDED" ? Math.min(input.expiresAt ?? Number.MAX_SAFE_INTEGER, issuer.expiresAt) : Number.MAX_SAFE_INTEGER,
    ...(root !== own || input.kind === "DEVICE_REVOKED" ? { issuer } : {}),
    ...(input.kind === "DEVICE_REVOKED" ? { retainedApprovals: [...retained].sort() } : {}) };

  const sodium = await getSodium();

  const event: DeviceAuthorization = { ...payload, sig: encodeBase64Url(sodium.crypto_sign_detached(
    canonicalBytes(payload), await getIdentityPrivateKey(context))) };

  if (!await verifyDeviceAuthorization(event, root)) throw new Error("DEVICE_AUTHORIZATION_INVALID");
  await context.vault.assertMain();

  return event;
};

/** Called only after explicit root confirmation on linking, never on startup or remote claims. */
export const acceptAccountRoot = async (confirmedRoot: string, authorization: DeviceAuthorization, context: ReceiveContext,
  roster: DeviceAuthorization[] = []) => {
  if (authorization.kind !== "DEVICE_ADDED" || !await verifyDeviceAuthorization(authorization, confirmedRoot) ||
      authorization.deviceId !== getOrCreateDeviceId(context) ||
      authorization.identityPub !== encodeBase64Url(await getIdentityPublicKey(context)) ||
      authorization.dhPub !== encodeBase64Url(await getDhPublicKey(context))) throw new Error("ACCOUNT_ROOT_BINDING_INVALID");
  await commitDeviceAuthorization(authorization, confirmedRoot, context, true, undefined, roster);
};

/** Initial root opt-in reuses its existing keys; no root key or Ratchet is exported. */
export const initializeAccountRoot = async (context: ReceiveContext, route?: DeviceAuthorization["route"]) => {
  const root = encodeBase64Url(await getIdentityPublicKey(context));

  const payload = { v: 2 as const, kind: "DEVICE_ADDED" as const, accountRootIdentityPub: root,
    approvedBy: getOrCreateDeviceId(context),
    deviceId: getOrCreateDeviceId(context), identityPub: root, dhPub: encodeBase64Url(await getDhPublicKey(context)),
    role: "primary" as const, epoch: 1, ts: Date.now(), expiresAt: Number.MAX_SAFE_INTEGER, ...(route ? { route } : {}) };

  const event = { ...payload, sig: encodeBase64Url((await getSodium()).crypto_sign_detached(
    canonicalBytes(payload), await getIdentityPrivateKey(context))) };

  const pinned = await getAccountRootIdentity(context);

  if (pinned) {
    const local = await getAuthorizedDevice(getOrCreateDeviceId(context), context);
    if (!local) throw new Error("DEVICE_AUTHORITY_REVOKED");
    if (!route || local.route && encodeBase64Url(canonicalBytes(local.route)) === encodeBase64Url(canonicalBytes(route))) return local;
    const refreshed = await createDeviceAuthorization({ ...local, kind: "DEVICE_ADDED", route, epoch: local.epoch + 1 }, context);
    await commitDeviceAuthorization(refreshed, pinned, context);
    return refreshed;
  }
  const registry = await readSignedDeviceRegistry(context);
  const previous = registry[event.deviceId];

  if (previous) {
    if (previous.kind !== "DEVICE_ADDED") throw new Error("DEVICE_AUTHORITY_REVOKED");
    await assertAuthorityFresh(root, await getRegistry(context), context);

    if (!route || previous.route && encodeBase64Url(canonicalBytes(previous.route)) === encodeBase64Url(canonicalBytes(route))) return previous;

    const refreshed = await createDeviceAuthorization({ kind: "DEVICE_ADDED", deviceId: event.deviceId,
      identityPub: root, dhPub: event.dhPub, role: previous.role, epoch: previous.epoch + 1, route }, context);

    await commitDeviceAuthorization(refreshed, root, context);

    return refreshed;
  }

  await acceptAccountRoot(root, event, context);

  return event;
};

const pinnedRootProfile = async (root: string, context: ReceiveContext) => {
  const profiles = (await listProfiles(context.vault)).filter(profile => profile.kind === "friend" &&
    profile.identityPub === root && profile.friendStatus === "normal" && profile.trust?.status === "trusted" &&
    profile.verification?.status !== "blocked" && profile.verification?.status !== "key_changed");

  return profiles.length === 1 ? profiles[0] : null;
};

/** Signature-valid disk observations only, for initial opt-in and read-only recovery UI. Not authorization. */
export const readSignedDeviceRegistry = async (context: ReceiveContext, peerRoot?: string): Promise<Record<string, DeviceAuthorization>> => {
  const ownRoot = await getAccountRootIdentity(context);
  const root = peerRoot ?? ownRoot;

  if (!root) return {};

  if (root !== ownRoot && !await pinnedRootProfile(root, context)) throw new Error("ACCOUNT_ROOT_UNCONFIRMED");
  const registry = await getRegistry(context);
  const result: Record<string, DeviceAuthorization> = {};

  for (const [id, entry] of Object.entries(registry)) {
    const event = entry.authorization;

    if (event?.deviceId === id && await verifyDeviceAuthorization(event, root)) result[id] = event;
  }

  await context.vault.assertMain();

  return result;
};

export const getAuthorizedDeviceRegistry = async (context: ReceiveContext, peerRoot?: string): Promise<Record<string, DeviceAuthorization>> => {
  const ownRoot = await getAccountRootIdentity(context), root = peerRoot ?? ownRoot;
  if (!root) return {};
  for (const identity of new Set([ownRoot, root])) if (identity &&
      await context.vault.db.meta.get(`security_state_conflict_v1:${identity}`)) throw new Error("SECURITY_STATE_CONFLICT");
  const before = (await context.vault.db.meta.get(VAULT_REGISTRY_KEY))?.value;
  const result = await readSignedDeviceRegistry(context, peerRoot), registry = await getRegistry(context);
  await assertIssuerState(Object.values(result), result);
  if (ownRoot && ownRoot !== root) await assertAuthorityFresh(ownRoot, registry, context);
  await assertAuthorityFresh(root, registry, context);
  await context.vault.assertMain();
  if ((await context.vault.db.meta.get(VAULT_REGISTRY_KEY))?.value !== before) throw new Error("DEVICE_AUTHORITY_CHANGED");

  return result;
};

/** Root-signed public evidence may repair a stale pin before admitting the sending endpoint. */
export const reconcileDeviceAuthorizations = async (certificates: DeviceAuthorization[], root: string, context: ReceiveContext) => {
  if (!Array.isArray(certificates) || certificates.length > 32 ||
      canonicalBytes(certificates).length > MAX_AUTHORITY_ROSTER_BYTES ||
      !(await Promise.all(certificates.map(row => verifyDeviceAuthorization(row, root)))).every(Boolean)) throw new Error("DEVICE_AUTHORIZATION_INVALID");
  const local = await readSignedDeviceRegistry(context, root);
  let updates: DeviceAuthorization[];
  try { updates = selectSecurityUpdates(local, certificates); }
  catch (error) {
    if (error instanceof Error && error.message === "SECURITY_STATE_CONFLICT") {
      await writeVault(context.vault, [context.vault.db.meta], () => context.vault.db.meta.put({ key: `security_state_conflict_v1:${root}`, value: "conflict" }));
    }
    throw error;
  }
  const merged = { ...local, ...Object.fromEntries(updates.map(certificate => [certificate.deviceId, certificate])) };
  await assertIssuerState(Object.values(merged), merged);
  // Apply this endpoint's terminal revocation last so it cannot authorize further writes.
  updates.sort((a, b) => Number(a.deviceId === getOrCreateDeviceId(context)) - Number(b.deviceId === getOrCreateDeviceId(context)) ||
    Number(a.kind === "DEVICE_REVOKED") - Number(b.kind === "DEVICE_REVOKED"));
  let current = context;
  for (const certificate of updates) {
    await commitDeviceAuthorization(certificate, root, current, false, undefined, [], true);
    current = Object.freeze({ ...current, vault: Object.freeze({ ...current.vault, authorizationMeta: undefined }) });
  }
  return current;
};

export const getAuthorizedDevice = async (deviceId: string, context: ReceiveContext, peerRoot?: string) => {
  const ownRoot = await getAccountRootIdentity(context);
  if (!ownRoot) return null;
  const before = (await context.vault.db.meta.get(VAULT_REGISTRY_KEY))?.value;
  const ownRegistry = await getAuthorizedDeviceRegistry(context);
  await assertNoLocalRollback(ownRoot, Object.values(ownRegistry), context);
  const local = ownRegistry[getOrCreateDeviceId(context)];
  const registry = peerRoot && peerRoot !== ownRoot ? await getAuthorizedDeviceRegistry(context, peerRoot) : ownRegistry;
  const peer = registry[deviceId];

  if (local?.kind !== "DEVICE_ADDED" || peer?.kind !== "DEVICE_ADDED" ||
      local.identityPub !== encodeBase64Url(await getIdentityPublicKey(context)) ||
      local.dhPub !== encodeBase64Url(await getDhPublicKey(context))) return null;
  await context.vault.assertMain();
  if ((await context.vault.db.meta.get(VAULT_REGISTRY_KEY))?.value !== before) throw new Error("DEVICE_AUTHORITY_CHANGED");

  return peer;
};

export const commitDeviceAuthorization = async (event: DeviceAuthorization, pinnedRoot: string,
  context: ReceiveContext, confirmLocalRoot = false,
  application?: { eventId: string; eventHash: string; wireConvId: string; lamport: number },
  roster: DeviceAuthorization[] = [], reconciliation = false) => {
  const certificates = [event, ...roster];

  if (roster.length && (!confirmLocalRoot || application) || certificates.length > 32 ||
      new Set(certificates.map(item => item.deviceId)).size !== certificates.length ||
      !(await Promise.all(certificates.map(item => verifyDeviceAuthorization(item, pinnedRoot)))).every(Boolean)) {
    throw new Error("DEVICE_AUTHORIZATION_INVALID");
  }

  await context.vault.assertMain();
  const db = context.vault.db;
  const beforeRoot = await db.meta.get(ACCOUNT_ROOT_META_KEY);
  const external = beforeRoot && beforeRoot.value !== pinnedRoot && !confirmLocalRoot;
  const friend = external ? await pinnedRootProfile(pinnedRoot, context) : null;
  const beforeProfile = friend ? await db.profiles.get(friend.id) : undefined;

  if (external ? !beforeProfile : beforeRoot?.value !== pinnedRoot && !(confirmLocalRoot && !beforeRoot)) {
    throw new Error("ACCOUNT_ROOT_UNCONFIRMED");
  }

  // The explicit join path may only pin an authorization for this endpoint's own keys.
  if (confirmLocalRoot && (event.kind !== "DEVICE_ADDED" || event.deviceId !== getOrCreateDeviceId(context) ||
      event.identityPub !== encodeBase64Url(await getIdentityPublicKey(context)) ||
      event.dhPub !== encodeBase64Url(await getDhPublicKey(context)))) throw new Error("ACCOUNT_ROOT_BINDING_INVALID");
  const before = await db.meta.get(VAULT_REGISTRY_KEY);
  const beforeApplication = application ? await db.events.get(application.eventId) : undefined;

  if (application && (!beforeApplication?.authenticatedBody_enc || beforeApplication.applicationState !== "pending" ||
      !beforeApplication.applicationCryptoCommitted || beforeApplication.eventHash !== application.eventHash)) throw new Error("DEVICE_APPLICATION_CONFLICT");
  const lamportKey = `lamport_v1:${DEVICE_APPROVAL_LOG_ID}`;
  const beforeLamport = await db.meta.get(lamportKey);
  const clock = Number(beforeLamport?.value ?? 0);

  if (!Number.isSafeInteger(clock) || clock < 0 || clock === Number.MAX_SAFE_INTEGER) throw new Error("DEVICE_AUTHORIZATION_CLOCK_INVALID");
  const registry = await getRegistry(context);
  const previousRegistry = structuredClone(registry);
  if (!reconciliation && beforeRoot?.value === pinnedRoot) {
    await assertNoLocalRollback(pinnedRoot, Object.values(await readSignedDeviceRegistry(context)), context);
  }
  const checkpointKey = authorityMetaKey(pinnedRoot);
  const previousCheckpoint = (await db.meta.get(checkpointKey))?.value;
  if (external) await assertAuthorityFresh(beforeRoot!.value, previousRegistry, context);

  if (!confirmLocalRoot) {
    const local = registry[getOrCreateDeviceId(context)]?.authorization;

    if (!local || local.kind !== "DEVICE_ADDED" || !await verifyDeviceAuthorization(local, beforeRoot!.value) ||
        local.identityPub !== encodeBase64Url(await getIdentityPublicKey(context)) ||
        local.dhPub !== encodeBase64Url(await getDhPublicKey(context))) throw new Error("DEVICE_AUTHORITY_REVOKED");
  }

  const additions: Array<{ certificate: DeviceAuthorization; eventHash: string; eventId: string; envelopeJson: string }> = [];

  for (const certificate of certificates) {
    const previous = registry[certificate.deviceId]?.authorization;

    if (previous && encodeBase64Url(canonicalBytes(previous)) === encodeBase64Url(canonicalBytes(certificate))) continue;

    const issuer = certificate.v === 3 ? registry[certificate.approvedBy]?.authorization ?? certificate.issuer :
      Object.values(registry).find(entry => entry.authorization?.identityPub === pinnedRoot)?.authorization;
    if (issuer?.kind === "DEVICE_ADDED" && issuer.expiresAt <= Date.now()) throw new Error("DEVICE_ISSUER_EXPIRED");

    if (previous && (previous.accountRootIdentityPub !== pinnedRoot || previous.kind === "DEVICE_REVOKED" || certificate.epoch <= previous.epoch ||
        certificate.identityPub !== previous.identityPub || certificate.dhPub !== previous.dhPub)) throw new Error("DEVICE_AUTHORIZATION_CONFLICT");

    if (Object.values(registry).some(entry => entry.authorization && entry.deviceId !== certificate.deviceId &&
        (entry.authorization.identityPub === certificate.identityPub || entry.authorization.dhPub === certificate.dhPub))) {
      throw new Error("DEVICE_IDENTITY_AMBIGUOUS");
    }

    registry[certificate.deviceId] = { ...registry[certificate.deviceId], deviceId: certificate.deviceId, role: certificate.role,
      epoch: certificate.epoch, lastSeenAt: certificate.ts, lastEventTs: certificate.ts, authorization: certificate };
    const eventHash = encodeBase64Url((await getSodium()).crypto_generichash(32, canonicalBytes(certificate)));
    const eventId = `device-authorization-v2:${eventHash}`;
    additions.push({ certificate, eventHash, eventId, envelopeJson: JSON.stringify({ v: 2,
      authorization_enc: await encryptJsonRecord(context.vault.key, eventId, "device-authorization", certificate) }) });
  }

  if (!additions.length && !application) return false;

  const accountCertificates = Object.values(registry).flatMap(entry => entry.authorization?.accountRootIdentityPub === pinnedRoot ? [entry.authorization] : []);
  if (accountCertificates.length > 32 || canonicalBytes(accountCertificates).length > MAX_AUTHORITY_ROSTER_BYTES) throw new Error("DEVICE_AUTHORIZATION_INVALID");
  await assertIssuerState(accountCertificates, Object.fromEntries(accountCertificates.map(certificate => [certificate.deviceId, certificate])));

  if (!Number.isSafeInteger(clock + additions.length)) throw new Error("DEVICE_AUTHORIZATION_CLOCK_INVALID");
  const value = additions.length ? await encodeDeviceRegistry(registry, context) : before!.value;
  const isRootWriter = !external && encodeBase64Url(await getIdentityPublicKey(context)) === pinnedRoot;
  const checkpoint = experimentalWitnessEnabled() && additions.length ? isRootWriter
    ? await prepareAuthorityMutation(pinnedRoot, previousRegistry, registry, context, confirmLocalRoot && !beforeRoot)
    : await matchCurrentAuthority(pinnedRoot, registry, context) : previousCheckpoint;
  await writeVault(context.vault, [db.meta, db.events, db.profiles], async () => {
    if ((await db.meta.get(ACCOUNT_ROOT_META_KEY))?.value !== beforeRoot?.value ||
        (await db.meta.get(VAULT_REGISTRY_KEY))?.value !== before?.value ||
        (await db.meta.get(lamportKey))?.value !== beforeLamport?.value ||
        (await db.meta.get(checkpointKey))?.value !== previousCheckpoint) throw new Error("DEVICE_AUTHORIZATION_CONFLICT");

    if (beforeProfile && (await db.profiles.get(beforeProfile.id))?.enc_b64 !== beforeProfile.enc_b64) {
      throw new Error("ACCOUNT_ROOT_UNCONFIRMED");
    }

    if (application) {
      const candidate = await db.events.get(application.eventId);

      if (candidate?.eventHash !== application.eventHash || !sameStoredCiphertext(candidate.authenticatedBody_enc, beforeApplication!.authenticatedBody_enc) ||
          candidate.applicationState !== "pending" || !candidate.applicationCryptoCommitted) throw new Error("DEVICE_APPLICATION_CONFLICT");
      await db.events.update(application.eventId, { applicationState: "stored", authenticatedBody_enc: undefined });
      const key = `lamport_v1:${application.wireConvId}`;
      const current = Number((await db.meta.get(key))?.value ?? 0);
      await db.meta.put({ key, value: String(Math.max(Number.isFinite(current) ? current : 0, application.lamport)) });
    }

    if (!external) await db.meta.put({ key: ACCOUNT_ROOT_META_KEY, value: pinnedRoot });
    await db.meta.put({ key: VAULT_REGISTRY_KEY, value });
    if (checkpoint) await db.meta.put({ key: checkpointKey, value: checkpoint });

    if (additions.length) {
      await db.meta.put({ key: lamportKey, value: String(clock + additions.length) });

      for (const [index, addition] of additions.entries()) await db.events.add({ eventId: addition.eventId, convId: DEVICE_APPROVAL_LOG_ID,
        authorDeviceId: addition.certificate.approvedBy, lamport: clock + index + 1, ts: addition.certificate.ts,
        envelopeJson: addition.envelopeJson, eventHash: addition.eventHash, bodyType: "control", applicationState: "stored" });
    }
  }, value);

  // The profile is durable first. A crash here leaves a lagging hint, never an ahead hint from this write.
  if (!external) await compareLocalRollbackHint(pinnedRoot,
    Object.values(registry).flatMap(row => row.authorization?.accountRootIdentityPub === pinnedRoot ? [row.authorization] : []), context);

  if (event.kind === "DEVICE_REVOKED") await reconcileRevokedNativeDevices(context.vault.authorizationMeta ?
    Object.freeze({ ...context, vault: Object.freeze({ ...context.vault,
      authorizationMeta: Object.freeze({ key: VAULT_REGISTRY_KEY, value }) }) }) : context);

  return true;
};

/** Explicit migration only; an existing remote enrollment can never be overwritten. */
export const enrollAccountFreshness = async (context: ReceiveContext) => {
  if (!experimentalWitnessEnabled()) throw new Error("EXPERIMENTAL_WITNESS_DISABLED");
  const root = await getAccountRootIdentity(context);
  if (!root) throw new Error("ACCOUNT_ROOT_AUTHORITY_REQUIRED");
  const registry = await getRegistry(context), before = (await context.vault.db.meta.get(VAULT_REGISTRY_KEY))?.value;
  const certificates = Object.values(registry).flatMap(row => row.authorization?.accountRootIdentityPub === root ? [row.authorization] : []);
  if (!(await Promise.all(certificates.map(certificate => verifyDeviceAuthorization(certificate, root)))).every(Boolean)) throw new Error("DEVICE_AUTHORIZATION_INVALID");
  const checkpoint = await prepareAuthorityMutation(root, registry, registry, context, true);
  await writeVault(context.vault, [context.vault.db.meta], async () => {
    if ((await context.vault.db.meta.get(VAULT_REGISTRY_KEY))?.value !== before ||
        (await context.vault.db.meta.get(authorityMetaKey(root)))?.value) throw new Error("DEVICE_AUTHORIZATION_CONFLICT");
    await context.vault.db.meta.put({ key: authorityMetaKey(root), value: checkpoint });
  });
};

/** Repair a Witness-first crash or old Root snapshot without replaying roster mutations. */
export const recoverAccountFreshness = async (context: ReceiveContext) => {
  const root = await getAccountRootIdentity(context);
  if (!root) throw new Error("ACCOUNT_ROOT_AUTHORITY_REQUIRED");
  const before = (await context.vault.db.meta.get(VAULT_REGISTRY_KEY))?.value;
  const checkpointBefore = (await context.vault.db.meta.get(authorityMetaKey(root)))?.value;
  const registry = await getRegistry(context), state = await readRootRecoveryCheckpoint(root, context);
  const certificates = state.devices.map(row => row.certificate);
  if (new Set(certificates.map(row => row.deviceId)).size !== certificates.length ||
      new Set(certificates.map(row => row.identityPub)).size !== certificates.length ||
      new Set(certificates.map(row => row.dhPub)).size !== certificates.length ||
      !(await Promise.all(certificates.map(row => verifyDeviceAuthorization(row, root)))).every(Boolean)) throw new Error("RECOVERY_CHECKPOINT_INVALID");
  if (certificates.some(certificate => registry[certificate.deviceId]?.authorization &&
      registry[certificate.deviceId].authorization!.accountRootIdentityPub !== root)) throw new Error("RECOVERY_CHECKPOINT_INVALID");
  for (const [id, entry] of Object.entries(registry)) if (entry.authorization?.accountRootIdentityPub === root) delete registry[id];
  for (const certificate of certificates) registry[certificate.deviceId] = { deviceId: certificate.deviceId, role: certificate.role,
    epoch: certificate.epoch, lastSeenAt: certificate.ts, lastEventTs: certificate.ts, authorization: certificate };
  const normalized = authorityState(registry, root, state.rootId, state.authorityEpoch);
  if (encodeBase64Url(canonicalBytes(normalized)) !== encodeBase64Url(canonicalBytes(state))) throw new Error("RECOVERY_CHECKPOINT_INVALID");
  const value = await encodeDeviceRegistry(registry, context);
  const commitment = await authorityDigest("nkc:authority-state:v1", state);
  await writeVault(context.vault, [context.vault.db.meta], async () => {
    if ((await context.vault.db.meta.get(VAULT_REGISTRY_KEY))?.value !== before ||
        (await context.vault.db.meta.get(authorityMetaKey(root)))?.value !== checkpointBefore) throw new Error("DEVICE_AUTHORIZATION_CONFLICT");
    await context.vault.db.meta.put({ key: VAULT_REGISTRY_KEY, value });
    await context.vault.db.meta.put({ key: authorityMetaKey(root), value: JSON.stringify({ epoch: state.authorityEpoch, commitment }) });
  }, value);
  await assertAuthorityFresh(root, registry, context);
  await reconcileRevokedNativeDevices(context.vault.authorizationMeta ?
    Object.freeze({ ...context, vault: Object.freeze({ ...context.vault,
      authorizationMeta: Object.freeze({ key: VAULT_REGISTRY_KEY, value }) }) }) : context);
};

/** A failed native cancellation remains retryable from the existing durable authorization. */
export const reconcileRevokedNativeDevices = async (context: ReceiveContext, replayStopped = false) => {
  const revoke = typeof window !== "undefined" ? window.nkc?.revokeOnionDevice : undefined;

  if (!revoke) return true;
  const ownRoot = await getAccountRootIdentity(context);

  if (!ownRoot) return true;
  const registry = await getRegistry(context);
  let complete = true;

  for (const entry of Object.values(registry)) {
    const event = entry.authorization;

    if (event?.kind !== "DEVICE_REVOKED" || !await verifyDeviceAuthorization(event, event.accountRootIdentityPub) ||
        event.accountRootIdentityPub !== ownRoot && !await pinnedRootProfile(event.accountRootIdentityPub, context)) continue;
    const key = `device_native_revoke_v2:${event.deviceId}:${event.epoch}`;

    if (!replayStopped && await context.vault.db.meta.get(key)) continue;
    await context.vault.assertMain();

    try {
      if (await revoke(context.owner.session, event.deviceId)) {
        await writeVault(context.vault, [context.vault.db.meta], () => context.vault.db.meta.put({ key, value: "stopped" }));
      } else complete = false;
    } catch { complete = false; /* The next delivery tick retries the same signed revocation. */ }
  }

  return complete;
};

export type DeviceAddedPayload = {
  kind: "DEVICE_ADDED";
  deviceId: string;
  identityPub: string;
  dhPub: string;
  ts: number;
  expiresAt: number;
  approvedBy: string;
  approverIdentityPub: string;
  approverDhPub: string;
};

export type DeviceAddedEvent = DeviceAddedPayload & {
  sig: string;
};

const APPROVAL_STORE_KEY = "nkc_device_approvals_v1";

const DEFAULT_APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEVICE_APPROVAL_LOG_ID = "device-approvals";

const readApprovals = async (context?: ReceiveContext): Promise<Record<string, DeviceAddedEvent>> => {
  const store = getPublicStore(context?.vault);
  const raw = await store.get(APPROVAL_STORE_KEY);

  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as Record<string, DeviceAddedEvent>;

    if (!parsed || typeof parsed !== "object") return {};

    return parsed;
  } catch {
    return {};
  }
};

const writeApprovals = async (approvals: Record<string, DeviceAddedEvent>, context?: ReceiveContext) => {
  const store = getPublicStore(context?.vault);
  await store.set(APPROVAL_STORE_KEY, JSON.stringify(approvals));
};

const stripSig = (event: DeviceAddedEvent): DeviceAddedPayload => {
  const { sig, ...payload } = event;
  void sig;

  return payload;
};

const computeApprovalEventHash = async (event: DeviceAddedEvent) => {
  const sodium = await getSodium();
  const hash = sodium.crypto_generichash(32, canonicalBytes(event));

  return encodeBase64Url(hash);
};

export const createDeviceAddedEvent = async (input: {
  deviceId: string;
  identityPub: string;
  dhPub: string;
  expiresAt?: number;
}) => {
  const now = Date.now();
  const approverDeviceId = getOrCreateDeviceId();

  const [identityPriv, identityPub, dhPub] = await Promise.all([
    getIdentityPrivateKey(),
    getIdentityPublicKey(),
    getDhPublicKey(),
  ]);

  const payload: DeviceAddedPayload = {
    kind: "DEVICE_ADDED",
    deviceId: input.deviceId,
    identityPub: input.identityPub,
    dhPub: input.dhPub,
    ts: now,
    expiresAt: input.expiresAt ?? now + DEFAULT_APPROVAL_TTL_MS,
    approvedBy: approverDeviceId,
    approverIdentityPub: encodeBase64Url(identityPub),
    approverDhPub: encodeBase64Url(dhPub),
  };

  const sodium = await getSodium();
  const sig = sodium.crypto_sign_detached(canonicalBytes(payload), identityPriv);

  return { ...payload, sig: encodeBase64Url(sig) } satisfies DeviceAddedEvent;
};

export const verifyDeviceAddedEvent = async (event: DeviceAddedEvent) => {
  if (!event || event.kind !== "DEVICE_ADDED") return false;

  if (
    !event.sig ||
    !event.approverIdentityPub ||
    !event.approverDhPub ||
    !event.deviceId ||
    !event.identityPub ||
    !event.dhPub ||
    !event.approvedBy
  ) {
    return false;
  }

  if (!Number.isFinite(event.ts) || !Number.isFinite(event.expiresAt)) return false;

  if (event.expiresAt <= Date.now()) return false;

  try {
    const sodium = await getSodium();
    const sig = decodeBase64Url(event.sig);
    const verifyKey = decodeBase64Url(event.approverIdentityPub);
    const payload = stripSig(event);

    return sodium.crypto_sign_verify_detached(sig, canonicalBytes(payload), verifyKey);
  } catch {
    return false;
  }
};

export const storeDeviceApproval = async (event: DeviceAddedEvent) => {
  const ok = await verifyDeviceAddedEvent(event);

  if (!ok) return false;
  const approvals = await readApprovals();
  approvals[event.deviceId] = event;
  await writeApprovals(approvals);
  const prevHash = await getLastEventHash(DEVICE_APPROVAL_LOG_ID);
  const eventHash = await computeApprovalEventHash(event);
  await saveEvent({
    eventId: createId(),
    convId: DEVICE_APPROVAL_LOG_ID,
    authorDeviceId: event.approvedBy,
    lamport: event.ts,
    ts: event.ts,
    envelopeJson: JSON.stringify(event),
    prevHash,
    eventHash,
  });

  return true;
};

export const getApprovedDevice = async (deviceId: string, context?: ReceiveContext) => {
  const approvals = await readApprovals(context);
  const event = approvals[deviceId];

  if (!event) return null;
  const valid = await verifyDeviceAddedEvent(event);

  if (!valid) {
    delete approvals[deviceId];
    await writeApprovals(approvals, context);

    return null;
  }

  return event;
};

export const getDeviceApproval = async (deviceId: string, context?: ReceiveContext) => getApprovedDevice(deviceId, context);

export const isDeviceApproved = async (deviceId: string) => {
  const event = await getApprovedDevice(deviceId);

  return Boolean(event);
};
