import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The pass the Spine server gives a signed-in device to show the relay: who it is for and until when, signed with a secret only those
 * two share (HS256, the JWT shape without the library). The relay learns an opaque user id and an expiry, nothing about the records.
 * Short-lived: a stolen pass is good for minutes, and the device asks for a new one.
 */
const b64 = (data: Buffer | string) => Buffer.from(data).toString('base64url');
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest();
const HEADER = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

export const MIN_SECRET_LENGTH = 32;

export function issueToken(secret: string, userId: string, ttlMs: number, now = Date.now()): { token: string; expiresAt: number } {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error('the relay secret is too short');
  const expiresAt = now + ttlMs;
  const body = `${HEADER}.${b64(JSON.stringify({ sub: userId, iat: Math.floor(now / 1000), exp: Math.floor(expiresAt / 1000) }))}`;
  return { token: `${body}.${b64(sign(secret, body))}`, expiresAt };
}

/** The user the pass was issued for, or null if it is not valid, not ours, or past its time. */
export function verifyToken(secret: string, token: string, now = Date.now()): { userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;
  const given = Buffer.from(parts[2], 'base64url');
  const expected = sign(secret, `${parts[0]}.${parts[1]}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { sub?: unknown; exp?: unknown };
    if (typeof claims.sub !== 'string' || claims.sub === '' || typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
    return { userId: claims.sub };
  } catch {
    return null;
  }
}
