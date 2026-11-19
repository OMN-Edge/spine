import type { FastifyInstance } from 'fastify';
import { publicUrl } from 'spine-core/config.js';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** The operator's contact as RFC 9116 wants it: an address becomes `mailto:`, a link stays as it is. Nothing, or something that is neither, is no contact. */
export function securityContact(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value || /\s/.test(value)) return null;
  if (/^(https?:\/\/|mailto:)/i.test(value)) return value;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? `mailto:${value}` : null;
}

/**
 * `/.well-known/security.txt` (RFC 9116): how to tell whoever runs this instance of a vulnerability, from the instance's own settings
 * (`SPINE_OPERATOR_SECURITY_CONTACT`, else `SPINE_OPERATOR_CONTACT`) so that every way of serving it (nginx, Caddy, the container) publishes the operator's contact and never the
 * project's. With no contact there is no file, since the standard requires one. It carries an expiry a year on, worked out at each request:
 * the file is a pointer that is true as long as the setting is.
 */
export async function securityTxtRoutes(app: FastifyInstance) {
  app.get('/.well-known/security.txt', async (_req, reply) => {
    // A contact of its own for vulnerabilities when the operator has one, else the contact for everything.
    const contact = securityContact(process.env.SPINE_OPERATOR_SECURITY_CONTACT) ?? securityContact(process.env.SPINE_OPERATOR_CONTACT);
    if (!contact) return reply.status(404).type('text/plain; charset=utf-8').send('not found\n');
    const expires = new Date(Date.now() + YEAR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const body = [`Contact: ${contact}`, `Expires: ${expires}`, 'Preferred-Languages: en', `Canonical: ${publicUrl('/.well-known/security.txt')}`, ''].join('\n');
    return reply.header('Cache-Control', 'public, max-age=3600').type('text/plain; charset=utf-8').send(body);
  });
}
