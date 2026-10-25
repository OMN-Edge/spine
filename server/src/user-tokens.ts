import { createShareToken, hashShareToken } from 'spine-core/share-token.js';

/**
 * Verification and reset tokens are capabilities, handled like share tokens:
 * 256 bits of CSPRNG output, and only the sha256 is stored (P6). The primitives
 * are the same ones; the names say what they are used for here.
 */
export const createUserToken = createShareToken;
export const hashUserToken = hashShareToken;
