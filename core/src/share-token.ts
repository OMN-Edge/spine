import { createHash, randomBytes } from 'crypto';

/**
 * Share tokens are capabilities: possession alone grants read access to part of
 * someone's medical history, with no account and no second factor.
 *
 * SECURITY.md P6 — they are hashed at rest, so reading `spine.db` does not hand
 * over working links. The raw token exists in exactly two places: the creation
 * response, and whatever the owner pasted it into.
 *
 * A plain SHA-256 is the right primitive here, unlike for a password: the input
 * is 256 bits of CSPRNG output, so there is nothing to brute-force and no need
 * for a slow KDF. (A reset token, per M-11, is the same shape.)
 */

/** 32 bytes, base64url — 43 characters, 256 bits. */
export function createShareToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashShareToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

/** A token as `createShareToken` issues it: 43 base64url characters. */
export function looksLikeRawToken(value: string): boolean {
  return RAW_TOKEN_RE.test(value);
}

/** A stored digest: 64 lowercase hex characters. */
export function looksLikeTokenDigest(value: string): boolean {
  return DIGEST_RE.test(value);
}
