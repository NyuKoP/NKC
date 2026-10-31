import type { ValidatedIncomingMediaRef } from "../security/mediaPolicy";

export type PermanentMediaRequest =
  | { operation: "begin"; media: ValidatedIncomingMediaRef }
  | { operation: "write"; token: string; offset: number; bytes: Uint8Array }
  | { operation: "seal" | "publish" | "discard"; token: string }
  | { operation: "read"; token: string; offset: number; length: number };

export type PermanentMediaResult = { token?: string; bytes?: Uint8Array; cancelled?: boolean };
