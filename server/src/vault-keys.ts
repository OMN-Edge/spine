import { createHmac } from 'crypto';
import type { VaultKeys } from 'spine-core/store/types.js';

/**
 * What the server checks about the vault's keys: only their shape. It cannot check more, because everything in them is sealed or
 * public. The shape checks are what stop a client storing something that cannot be a key (and a weak Argon2id cost).
 */
const B64URL = /^[A-Za-z0-9_-]+$/;

export const AUTH_VALUE = /^[A-Za-z0-9_-]{43}$/;

export interface KdfParams {
  alg: 'argon2id13';
  ops: number;
  /** Memory in KiB. */
  memKiB: number;
}

export const DEFAULT_KDF: KdfParams = { alg: 'argon2id13', ops: 3, memKiB: 65536 };

export function parseKdfParams(raw: unknown): KdfParams | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const { alg, ops, memKiB } = value as Record<string, unknown>;
  if (alg !== 'argon2id13' || !Number.isInteger(ops) || !Number.isInteger(memKiB)) return null;
  // Not below the OWASP minimum (19 MiB, 2 passes), and not so high that signing in burns a phone.
  if ((ops as number) < 2 || (ops as number) > 12 || (memKiB as number) < 19456 || (memKiB as number) > 1048576) return null;
  return { alg, ops: ops as number, memKiB: memKiB as number };
}

export const sealed = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max && B64URL.test(v);

/** The keys a client sends, or null when any part is not what it should be. */
export function parseVaultKeys(raw: unknown): VaultKeys | null {
  if (!raw || typeof raw !== 'object') return null;
  const k = raw as Record<string, unknown>;
  const params = parseKdfParams(k.kdf_params);
  if (!params) return null;
  // 16-byte salt = 22 characters; a public key = 43; a sealed 32-byte key = nonce 24 + 32 + tag 16 = 72 bytes = 96 characters.
  if (!sealed(k.kdf_salt, 22, 22) || !sealed(k.public_key, 43, 43)) return null;
  if (!sealed(k.wrapped_by_master, 90, 200) || !sealed(k.wrapped_by_recovery, 90, 200) || !sealed(k.wrapped_private_key, 90, 200)) return null;
  return {
    kdf_salt: k.kdf_salt,
    kdf_params: JSON.stringify(params),
    wrapped_by_master: k.wrapped_by_master,
    wrapped_by_recovery: k.wrapped_by_recovery,
    public_key: k.public_key,
    wrapped_private_key: k.wrapped_private_key,
  };
}

/**
 * A salt for an address that has no vault, the same every time for that address and unguessable without the server's secret, so asking
 * for the salt of an unknown address looks like asking for a real one.
 */
export function pretendSalt(email: string, secret: string): string {
  return createHmac('sha256', secret).update(`spine-kdf-salt:${email}`).digest().subarray(0, 16).toString('base64url');
}
