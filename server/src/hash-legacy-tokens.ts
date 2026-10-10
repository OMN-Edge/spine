import { getStore } from './store/index.js';
import { hashShareToken, looksLikeRawToken, looksLikeTokenDigest } from './share-token.js';

export interface LegacyTokenRewrite {
  hashed: number;
  /** Rows matching neither shape. Left untouched — they need a human. */
  unrecognised: string[];
}

/**
 * One-time, idempotent rewrite of plaintext share tokens to their digests
 * (SECURITY.md S-4, P6).
 *
 * No link has to break: the plaintext is in the row, so its digest is
 * computable in place. The two shapes are unambiguous — 43 base64url
 * characters issued, 64 hex characters stored — so this is safe to run on every
 * boot and a no-op after the first, which is how the rest of the schema already
 * works. It therefore does not have to wait for the migration runner.
 */
export async function hashLegacyShareTokens(): Promise<LegacyTokenRewrite> {
  const store = getStore();
  const rows = await store.maintenance.listShareLinkTokens();

  const unrecognised: string[] = [];
  const toHash: Array<{ id: string; digest: string }> = [];

  for (const row of rows) {
    if (looksLikeTokenDigest(row.token)) continue;
    if (looksLikeRawToken(row.token)) {
      toHash.push({ id: row.id, digest: hashShareToken(row.token) });
    } else {
      unrecognised.push(row.id);
    }
  }

  if (toHash.length > 0) {
    await store.transaction(async (tx) => {
      for (const { id, digest } of toHash) {
        await tx.maintenance.setShareLinkToken(id, digest);
      }
    });
  }

  return { hashed: toHash.length, unrecognised };
}
