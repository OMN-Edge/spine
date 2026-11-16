import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * What the operator keeps in the store and must not read back by anyone who reads the database (ANAF's tokens), sealed with AES-256-GCM under a key that is in the
 * process's environment and never in the store: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. A sealed string that was changed, or opened with another key, does not open.
 */
export function sealText(key: Buffer, plain: string): string {
  if (key.length !== 32) throw new Error('the sealing key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function openText(key: Buffer, sealed: string): string {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('not a sealed text');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
