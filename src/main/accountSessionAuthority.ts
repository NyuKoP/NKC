import { randomUUID } from "node:crypto";
import type { MainAccountSession } from "../accounts/mainSessionTypes";

export const validateLocalAccountId = (value: unknown): string => {
  if (typeof value !== "string" || (value !== "legacy" &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) {
    throw new Error("OWNER_ACCOUNT_INVALID");
  }

  return value.toLowerCase();
};

/** Main owns versions/nonces; account identity is announced by trusted local IPC. */
export class AccountSessionAuthority {
  private generation = 0;
  private sessions = new Map<number, MainAccountSession>();
  private destroyed = new Set<number>();

  private advance() {
    if (this.generation >= Number.MAX_SAFE_INTEGER) throw new Error("OWNER_GENERATION_EXHAUSTED");

    return ++this.generation;
  }

  activate(rendererId: number, account: string): MainAccountSession {
    if (this.destroyed.has(rendererId)) throw new Error("OWNER_RENDERER_DESTROYED");
    const accountId = validateLocalAccountId(account);
    const session = Object.freeze({ accountId, generation: this.advance(), token: randomUUID() });
    this.sessions.set(rendererId, session);

    return session;
  }

  assertCurrent(rendererId: number, candidate: MainAccountSession, account?: string) {
    const current = this.sessions.get(rendererId);

    if (!current || !candidate || current.token !== candidate.token ||
        current.generation !== candidate.generation || current.accountId !== candidate.accountId) {
      throw new Error("OWNER_SESSION_CHANGED");
    }

    if (account !== undefined && current.accountId !== validateLocalAccountId(account)) {
      throw new Error("OWNER_ACCOUNT_MISMATCH");
    }

    return current;
  }

  revoke(rendererId: number) {
    this.sessions.delete(rendererId);
    this.advance();
  }

  cancelActivation(rendererId: number, candidate: MainAccountSession) {
    if (this.sessions.get(rendererId)?.token === candidate.token) this.revoke(rendererId);
  }

  revokeAccount(account: string) {
    const accountId = validateLocalAccountId(account);

    for (const [rendererId, session] of this.sessions) {
      if (session.accountId === accountId) this.revoke(rendererId);
    }
  }

  destroyRenderer(rendererId: number) {
    this.revoke(rendererId);
    this.destroyed.add(rendererId);
  }
}

export const bindAccountSessionLifecycle = (authority: AccountSessionAuthority,
  contents: Electron.WebContents) => {
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) authority.revoke(contents.id);
  });
  contents.on("render-process-gone", () => authority.revoke(contents.id));
  contents.once("destroyed", () => authority.destroyRenderer(contents.id));
};
