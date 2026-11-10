import type { KdfParams } from './keys.js';

/**
 * What the device believes of the server's answer about how to derive the sign-in credential (`/api/auth/kdf`). The answer decides what
 * the page sends: the password itself for an account with no vault, a credential derived at the cost it names otherwise. A server that
 * lies (or whatever ends TLS for it) could therefore be sent the password, or a credential made cheap to guess from. So the answer is held
 * to bounds, and to what this browser saw for the address after its last sign-in.
 */
export type KdfAnswer = { vault: false } | { vault: true; salt: string; params: KdfParams };

/** The same floor and ceiling the server holds a stored cost to (`parseKdfParams`): the OWASP minimum, and not so high that opening burns a phone. */
export const KDF_BOUNDS = { minOps: 2, maxOps: 12, minMemKiB: 19456, maxMemKiB: 1048576 };

export class KdfRefusedError extends Error {
  constructor(why: string) {
    super(`The server's answer about how to sign in was refused: ${why}. Nothing was sent.`);
    this.name = 'KdfRefusedError';
  }
}

const key = (address: string) => `spine.kdf:${address.trim().toLowerCase()}`;

function remembered(address: string): KdfParams | null {
  try {
    const raw = localStorage.getItem(key(address));
    return raw ? (JSON.parse(raw) as KdfParams) : null;
  } catch {
    return null;
  }
}

/** Kept after a sign-in the server accepted: the address has a vault, made at least this costly. Best effort; an unreadable store remembers nothing. */
export function rememberKdf(address: string, answer: KdfAnswer): void {
  if (!answer.vault) return;
  try { localStorage.setItem(key(address), JSON.stringify(answer.params)); } catch { /* the next sign-in is held to the bounds only */ }
}

/** Returns the answer if it can be believed, else throws `KdfRefusedError`. */
export function checkKdfAnswer(address: string, answer: KdfAnswer): KdfAnswer {
  const before = remembered(address);
  if (!answer.vault) {
    if (before) throw new KdfRefusedError('it says this account has no vault, which this browser saw it have');
    return answer;
  }
  const p = answer.params as Partial<KdfParams> | null | undefined;
  if (!p || p.alg !== 'argon2id13' || !Number.isInteger(p.ops) || !Number.isInteger(p.memKiB)) throw new KdfRefusedError('the cost is not one this app uses');
  const { ops, memKiB } = p as KdfParams;
  if (ops < KDF_BOUNDS.minOps || memKiB < KDF_BOUNDS.minMemKiB) throw new KdfRefusedError('the cost is below the minimum');
  if (ops > KDF_BOUNDS.maxOps || memKiB > KDF_BOUNDS.maxMemKiB) throw new KdfRefusedError('the cost is above what a device can be asked for');
  if (before && (ops < before.ops || memKiB < before.memKiB)) throw new KdfRefusedError('the cost is lower than this browser saw for the address');
  return answer;
}
