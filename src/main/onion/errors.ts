export class PinnedHashMissingError extends Error {
  readonly code = "PINNED_HASH_MISSING";
  readonly details: string;

  constructor(details: string) {
    super("PINNED_HASH_MISSING");
    this.name = "PinnedHashMissingError";
    this.details = details;
  }
}
