import { canonicalBytes } from "../crypto/canonicalJson";
import { getSodium } from "../security/sodium";
import { decodeBase64Url, encodeBase64Url } from "../security/base64url";
import { getDhPrivateKey, getDhPublicKey, getIdentityPrivateKey, getIdentityPublicKey } from "../security/identityKeys";
import type { DeviceRegistry } from "../devices/deviceRegistry";
import type { ReceiveContext } from "../accounts/receiveContext";
import type { SignedTransition } from "../main/freshness/witnessProtocol";

export const authorityMetaKey = (root: string) => `nkc_authority_checkpoint_v1:${root}`;
export const experimentalWitnessEnabled = () => typeof window !== "undefined" && window.nkcExperimental?.freshnessWitness === true;
export const authorityDigest = async (domain: string, value: unknown) => encodeBase64Url((await getSodium()).crypto_hash_sha256(
  new Uint8Array([...new TextEncoder().encode(domain + "\0"), ...canonicalBytes(value)])));
export const authorityState = (registry: DeviceRegistry, root: string, rootId: string, authorityEpoch: number) => ({
  protocolVersion: 1, rootId, rootPublicKey: root, authorityEpoch,
  devices: Object.values(registry).flatMap(entry => entry.authorization?.accountRootIdentityPub === root
    ? [{ certificate: entry.authorization, generation: entry.authorization.epoch }] : [])
    .sort((a, b) => a.certificate.deviceId < b.certificate.deviceId ? -1 : a.certificate.deviceId > b.certificate.deviceId ? 1 : 0),
});
const bridge = () => {
  const verify = typeof window === "undefined" ? undefined : window.nkc?.verifyAuthorityFreshness;
  if (!verify) throw new Error("WITNESS_REQUIRED");

  return verify;
};
export const readAuthorityHead = async (root: string, registry: DeviceRegistry, context: ReceiveContext) => {
  await context.vault.assertMain();
  const raw = (await context.vault.db.meta.get(authorityMetaKey(root)))?.value;
  if (!raw) return { rootPublicKey: root, epoch: 0, commitment: null };
  const head = JSON.parse(raw) as { epoch: number; commitment: string };
  if (!Number.isSafeInteger(head.epoch) || head.epoch < 1 || typeof head.commitment !== "string") throw new Error("LOCAL_AUTHORITY_INVALID");
  const state = authorityState(registry, root, await authorityDigest("nkc:freshness-root:v1", root), head.epoch);
  if (await authorityDigest("nkc:authority-state:v1", state) !== head.commitment) throw new Error("LOCAL_AUTHORITY_INVALID");

  return { ...head, rootPublicKey: root };
};
export const assertAuthorityFresh = async (root: string, registry: DeviceRegistry, context: ReceiveContext) => {
  if (!experimentalWitnessEnabled()) { await context.vault.assertMain(); return; }
  const head = await readAuthorityHead(root, registry, context);
  const result = await bridge()(context.owner.session, head);
  await context.vault.assertMain();
  if (result.state !== "TRUSTED_CURRENT") throw new Error(result.state);

  return head;
};

/** Witness commits first; encrypted recovery permits repair if the following Vault commit crashes. */
export const prepareAuthorityMutation = async (root: string, before: DeviceRegistry, after: DeviceRegistry,
  context: ReceiveContext, explicitEnrollment = false) => {
  if (!experimentalWitnessEnabled()) throw new Error("EXPERIMENTAL_WITNESS_DISABLED");
  if (encodeBase64Url(await getIdentityPublicKey(context)) !== root) throw new Error("ACCOUNT_ROOT_AUTHORITY_REQUIRED");
  const previous = await readAuthorityHead(root, before, context);
  if (explicitEnrollment ? previous.epoch !== 0 : previous.epoch === 0) throw new Error("FRESHNESS_ENROLLMENT_REQUIRED");
  if (!explicitEnrollment) await assertAuthorityFresh(root, before, context);
  const rootId = await authorityDigest("nkc:freshness-root:v1", root);
  const state = authorityState(after, root, rootId, previous.epoch + 1);
  if (!state.devices.length || state.devices.length > 32) throw new Error("AUTHORITY_ROSTER_INVALID");
  const rootCertificate = state.devices.find(row => row.certificate.identityPub === root)?.certificate;
  if (!rootCertificate || rootCertificate.dhPub !== encodeBase64Url(await getDhPublicKey(context))) throw new Error("AUTHORITY_ROOT_CERTIFICATE_REQUIRED");
  const sodium = await getSodium();
  const commitment = await authorityDigest("nkc:authority-state:v1", state);
  const encryptedRecoveryCheckpoint = encodeBase64Url(sodium.crypto_box_seal(canonicalBytes(state), decodeBase64Url(rootCertificate.dhPub)));
  const transition: SignedTransition["transition"] = { version: 1, rootId, rootPublicKey: root,
    previousEpoch: previous.epoch, previousCommitment: previous.commitment,
    nextEpoch: state.authorityEpoch, nextCommitment: commitment,
    recoveryBlobDigest: await authorityDigest("nkc:recovery-blob:v1", encryptedRecoveryCheckpoint),
    transitionNonce: encodeBase64Url(sodium.randombytes_buf(32)) };
  const bytes = new Uint8Array([...new TextEncoder().encode("nkc:authority-transition:v1\0"), ...canonicalBytes(transition)]);
  const record = { transition, encryptedRecoveryCheckpoint, rootSignature: encodeBase64Url(sodium.crypto_sign_detached(bytes, await getIdentityPrivateKey(context))) };
  const head = { rootPublicKey: root, epoch: state.authorityEpoch, commitment };
  const result = await bridge()(context.owner.session, head, record);
  await context.vault.assertMain();
  if (result.state !== "TRUSTED_CURRENT") throw new Error(result.state);

  return JSON.stringify({ epoch: head.epoch, commitment });
};

/** Secondary/contact imports may adopt only the complete roster bound to the independently current checkpoint. */
export const matchCurrentAuthority = async (root: string, registry: DeviceRegistry, context: ReceiveContext) => {
  if (!experimentalWitnessEnabled()) throw new Error("EXPERIMENTAL_WITNESS_DISABLED");
  const result = await bridge()(context.owner.session, { rootPublicKey: root, epoch: 0, commitment: null });
  await context.vault.assertMain();
  const checkpoint = result.response.checkpoint;
  if (checkpoint.authorityEpoch === 0) throw new Error("FRESHNESS_ENROLLMENT_REQUIRED");
  const state = authorityState(registry, root, checkpoint.rootId, checkpoint.authorityEpoch);
  if (await authorityDigest("nkc:authority-state:v1", state) !== checkpoint.authorityCommitment) return null;

  return JSON.stringify({ epoch: checkpoint.authorityEpoch, commitment: checkpoint.authorityCommitment });
};

export const readRootRecoveryCheckpoint = async (root: string, context: ReceiveContext) => {
  if (!experimentalWitnessEnabled()) throw new Error("EXPERIMENTAL_WITNESS_DISABLED");
  if (encodeBase64Url(await getIdentityPublicKey(context)) !== root) throw new Error("FRESHNESS_ROOT_RECOVERY_REQUIRED");
  const result = await bridge()(context.owner.session, { rootPublicKey: root, epoch: 0, commitment: null });
  const record = result.response.record;
  if (!record) throw new Error("FRESHNESS_ENROLLMENT_REQUIRED");
  const sodium = await getSodium();
  const plain = sodium.crypto_box_seal_open(decodeBase64Url(record.encryptedRecoveryCheckpoint),
    await getDhPublicKey(context), await getDhPrivateKey(context));
  if (!plain) throw new Error("RECOVERY_CHECKPOINT_INVALID");
  try {
    const state = JSON.parse(new TextDecoder().decode(plain)) as ReturnType<typeof authorityState>;
    if (state.rootPublicKey !== root || state.rootId !== result.response.checkpoint.rootId ||
        state.authorityEpoch !== result.response.checkpoint.authorityEpoch ||
        await authorityDigest("nkc:authority-state:v1", state) !== result.response.checkpoint.authorityCommitment ||
        !Array.isArray(state.devices) || state.devices.length < 1 || state.devices.length > 32) throw new Error("RECOVERY_CHECKPOINT_INVALID");
    await context.vault.assertMain();

    return state;
  } finally { sodium.memzero(plain); }
};
