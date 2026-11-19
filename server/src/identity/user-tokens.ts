import { createHash, randomBytes } from 'node:crypto';

/**
 * Verification and reset tokens are capabilities: 256 bits of CSPRNG output,
 * and only the sha256 is stored (P6).
 */
/** 32 bytes of CSPRNG output, base64url: 256 bits, so a plain SHA-256 at rest is the right digest (nothing to brute-force). */
export const createUserToken = (): string => randomBytes(32).toString('base64url');
export const hashUserToken = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');
