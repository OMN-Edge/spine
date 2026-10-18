import { createHash, randomBytes } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from './store/index.js';
import type { ResolvedShareLink } from './store/index.js';

/**
 * A link that needs approval (SECURITY.md M-19) is opened by a *browser*, not by whoever holds the URL. The browser
 * is named by a random value in a cookie: the owner approves the request that value made, and the same value must
 * come with every later read. A copied URL alone, or a copy of the page's address on another device, reads nothing.
 *
 * Only `sha256(value)` is stored (P6), so the database does not hold working sessions. The value is 256 bits of
 * CSPRNG output, so a plain digest is the right primitive, as for share tokens.
 */
export const VISITOR_COOKIE = 'spine_share_visitor';
const VALUE_RE = /^[A-Za-z0-9_-]{43}$/;

export const hashVisitor = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export type Approval = 'open' | 'needed' | 'pending' | 'denied';

/** The digest of the cookie this request carries, or null when it carries none that has the right shape. */
export function visitorHashOf(req: FastifyRequest): string | null {
  const value = req.cookies?.[VISITOR_COOKIE];
  return typeof value === 'string' && VALUE_RE.test(value) ? hashVisitor(value) : null;
}

/** A new browser identity: sets the cookie and returns its digest. Scoped to the share API, so nothing else sees it. */
export function startVisitor(reply: FastifyReply): string {
  const value = randomBytes(32).toString('base64url');
  reply.setCookie(VISITOR_COOKIE, value, {
    path: '/api/share',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // as the session cookie: config.isProduction
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60,
  });
  return hashVisitor(value);
}

/**
 * Where this browser stands with the link. A link that does not need approval is `open`. Fail closed: anything but an
 * approved request for this link and this cookie is not `open`.
 */
export async function approvalFor(store: Store, req: FastifyRequest, link: ResolvedShareLink): Promise<Approval> {
  if (!link.requireApproval) return 'open';
  const visitor = visitorHashOf(req);
  if (!visitor) return 'needed';
  const request = await store.shareLinks.findRequest(link.id, visitor);
  if (!request) return 'needed';
  return request.status === 'approved' ? 'open' : request.status;
}
