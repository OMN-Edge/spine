/**
 * Hashing, for the shared code: the checksum of an upload, of an export, the digest of a translation or a summary card. It is not a
 * native tool: there is one algorithm (SHA-256), and each host brings it (Node's `crypto` for the tests and the server, libsodium on the
 * device) with `useDigests`. A process that registered none fails at the first hash, saying so.
 */
export interface Sha256 {
  update(data: string | Uint8Array): Sha256;
  /** The digest as lowercase hex. */
  hex(): string;
}

export interface Digests {
  sha256(): Sha256;
}

let current: Digests | null = null;

/** Called once by the process that brings the hashing: the device when its core starts, the tests' setup file. */
export function useDigests(digests: Digests | null): void {
  current = digests;
}

/** A hasher, for data that arrives in pieces. */
export function sha256(): Sha256 {
  if (!current) throw new Error('no hashing has been registered for this process (useDigests)');
  return current.sha256();
}

/** The SHA-256 of a string (as UTF-8) or of bytes, as hex. */
export const sha256Hex = (data: string | Uint8Array): string => sha256().update(data).hex();
