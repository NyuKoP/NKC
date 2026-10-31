/** Application completion; a deferred Controller item must remain unconsumed. */
export type ReceiveCompletion =
  | { status: "STORED"; accountId: string; eventId: string }
  | { status: "VERIFIED_DUPLICATE"; accountId: string; eventId: string }
  | { status: "OWNED_DEFERRED"; accountId: string; eventId: string;
      recoveryOwner: { mechanism: "existing-inbox" | "existing-outbox" | "existing-event"; reference: string } }
  | { status: "FAILED"; code: string };

/** Signed control frames have no chat message; do not call their storage message delivery. */
export type IncomingCompletion = ReceiveCompletion |
  { status: "CONTROL_APPLIED"; accountId: string; operationId: string };

export const receiveSucceeded = (result: IncomingCompletion | undefined) =>
  result?.status === "STORED" || result?.status === "VERIFIED_DUPLICATE" || result?.status === "CONTROL_APPLIED";

export const combineReceiveCompletions = (results: Array<IncomingCompletion | void>): IncomingCompletion | undefined => {
  const handled = results.filter((result): result is IncomingCompletion => result !== undefined);

  return handled.find(result => result.status === "FAILED") ??
    handled.find(result => result.status === "OWNED_DEFERRED") ?? handled[0];
};
