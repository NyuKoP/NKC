import { randomBytes } from "node:crypto";
import { MAX_WITNESS_BODY, freshnessRootId, validBytes, validateSignedTransition, validateWitnessResponse,
  type SignedTransition, type WitnessResponse } from "./witnessProtocol";
import type { SocksFetch } from "../socksHttpClient";

export type FreshnessState = "UNVERIFIED_LOCAL" | "TRUSTED_CURRENT" | "RECONCILIATION_REQUIRED" | "REKEY_REQUIRED" | "SECURITY_STATE_CONFLICT";
export type WitnessConfiguration = { endpoint: string; publicKey: string };
export type LocalAuthorityHead = { rootPublicKey: string; epoch: number; commitment: string | null };

export const validateWitnessConfiguration = (input: unknown): WitnessConfiguration => {
  const config = input as WitnessConfiguration;
  if (!config || !validBytes(config.publicKey, 32) || typeof config.endpoint !== "string") throw new Error("WITNESS_CONFIGURATION_REQUIRED");
  const url = new URL(config.endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("WITNESS_CONFIGURATION_INVALID");

  return { endpoint: url.origin, publicKey: config.publicKey };
};

/** RAM state is a cache of an independent proof; each validation uses a new signed challenge. */
export class FreshnessAuthority {
  private states = new Map<string, { state: FreshnessState; epoch: number; commitment: string | null }>();
  private configuration: WitnessConfiguration;
  private fetch: SocksFetch;
  private proxy: () => string | null;

  constructor(configuration: unknown, fetch: SocksFetch, proxy: () => string | null) {
    this.configuration = validateWitnessConfiguration(configuration); this.fetch = fetch; this.proxy = proxy;
  }

  state(owner: string, rootPublicKey: string): FreshnessState {
    return this.states.get(owner + ":" + freshnessRootId(rootPublicKey))?.state ?? "UNVERIFIED_LOCAL";
  }

  forget(owner: string) {
    for (const key of this.states.keys()) if (key.startsWith(owner + ":")) this.states.delete(key);
  }

  private async request(rootPublicKey: string, record: SignedTransition | undefined, assertOwner: () => void): Promise<WitnessResponse> {
    assertOwner();
    const rootId = freshnessRootId(rootPublicKey), challenge = randomBytes(32).toString("base64url");
    const proxy = this.proxy();
    if (!proxy || !/^socks5h?:\/\/127\.0\.0\.1:\d+$/.test(proxy)) throw new Error("WITNESS_TOR_REQUIRED");
    const body = record ? Buffer.from(JSON.stringify(validateSignedTransition(record))) : undefined;
    if (body && body.length > MAX_WITNESS_BODY) throw new Error("WITNESS_REQUEST_TOO_LARGE");
    const response = await this.fetch(`${this.configuration.endpoint}/v1/root/${rootId}/${record ? "transition" : "checkpoint"}?challenge=${challenge}`,
      { method: record ? "POST" : "GET", headers: record ? { "Content-Type": "application/json" } : {}, body,
        timeoutMs: 10000, diagnose: false, retry: { attempts: 1 }, socksProxyUrl: proxy });
    assertOwner();
    if (response.status === 409) throw new Error("SECURITY_STATE_CONFLICT");
    if (response.status !== 200 || response.body.length > MAX_WITNESS_BODY) throw new Error("WITNESS_UNAVAILABLE");

    return validateWitnessResponse(JSON.parse(response.body.toString("utf8")), rootId, challenge, this.configuration.publicKey);
  }

  async verify(owner: string, head: LocalAuthorityHead, assertOwner: () => void, record?: SignedTransition) {
    if (!head || typeof head !== "object" || !Number.isSafeInteger(head.epoch) || head.epoch < 0 ||
        (head.epoch === 0 ? head.commitment !== null : !validBytes(head.commitment, 32))) throw new Error("LOCAL_AUTHORITY_INVALID");
    const key = owner + ":" + freshnessRootId(head.rootPublicKey), previous = this.states.get(key);
    if (!previous && this.states.size >= 4096) throw new Error("WITNESS_OWNER_LIMIT");
    this.states.set(key, { state: "UNVERIFIED_LOCAL", epoch: previous?.epoch ?? 0, commitment: previous?.commitment ?? null });

    try {
      if (record && (record.transition.rootPublicKey !== head.rootPublicKey || record.transition.nextEpoch !== head.epoch ||
          record.transition.nextCommitment !== head.commitment)) throw new Error("LOCAL_AUTHORITY_INVALID");
      const response = await this.request(head.rootPublicKey, record, assertOwner), c = response.checkpoint;
      const latest = this.states.get(key);
      if (latest && (c.authorityEpoch < latest.epoch || c.authorityEpoch === latest.epoch && c.authorityCommitment !== latest.commitment)) throw new Error("SECURITY_STATE_CONFLICT");
      const state: FreshnessState = head.epoch === c.authorityEpoch && head.commitment === c.authorityCommitment && head.epoch > 0
        ? "TRUSTED_CURRENT" : head.epoch === c.authorityEpoch ? "SECURITY_STATE_CONFLICT" : "RECONCILIATION_REQUIRED";
      assertOwner();
      this.states.set(key, { state, epoch: c.authorityEpoch, commitment: c.authorityCommitment });

      return { state, response };
    } catch (error) {
      this.states.set(key, { state: error instanceof Error && error.message === "SECURITY_STATE_CONFLICT" ? "SECURITY_STATE_CONFLICT" : "UNVERIFIED_LOCAL",
        epoch: this.states.get(key)?.epoch ?? previous?.epoch ?? 0, commitment: this.states.get(key)?.commitment ?? previous?.commitment ?? null });
      const code = error instanceof Error && ["SECURITY_STATE_CONFLICT", "OWNER_SESSION_CHANGED", "OWNER_ACCOUNT_MISMATCH",
        "WITNESS_TOR_REQUIRED", "WITNESS_RESPONSE_INVALID", "WITNESS_TRANSITION_INVALID", "LOCAL_AUTHORITY_INVALID", "WITNESS_REQUEST_TOO_LARGE"]
        .includes(error.message) ? error.message : "WITNESS_UNAVAILABLE";
      throw new Error(code);
    }
  }
}
