import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { REAUTH_WINDOW_MS, sessionIsLive } from '../sessions.js';
import { getStore, type UserRecord } from '../store/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth`. Empty on a route that has not passed through it. */
    userId: string;
  }
}

/**
 * A login that has the right password but not yet the second factor. It lives in the
 * session but is not a login: `authenticate` ignores it, and only the second step turns
 * it into `userId`. It records the `auth_version` it was started under, so a password
 * change in between voids it.
 */
export interface PendingLogin {
  userId: string;
  authVersion: number;
  expiresAt: number;
  failures: number;
}

export interface SessionData {
  userId?: string;
  authVersion?: number;
  /** This sign-in's row in `user_sessions` (S-33). */
  sid?: string;
  /** When the password was last typed for this session, for actions that ask again (S-33). */
  reauthAt?: number;
  pending?: PendingLogin;
}

/** Declares the request property; call once on the root instance, before routes. */
export function decorateAuth(app: FastifyInstance): void {
  app.decorateRequest('userId', '');
}

/**
 * Resolve the session to a live user, or null.
 *
 * Checked against the database on every call, not trusted from the cookie: a
 * deleted user or a changed password (`auth_version`) ends the session at once.
 */
export async function authenticate(req: FastifyRequest): Promise<UserRecord | null> {
  const session = req.session as SessionData;
  if (!session.userId) return null;

  const user = await getStore().users.findById(session.userId);
  if (!user || !user.email_verified_at || user.auth_version !== session.authVersion) {
    await req.session.destroy();
    return null;
  }
  // The row is what makes the cookie valid: ended from the list, idle too long or too old, and it is not (S-33).
  if (!(await sessionIsLive(user.id, session))) {
    await req.session.destroy();
    return null;
  }
  return user;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const user = await authenticate(req);
  if (!user) return reply.status(401).send({ error: 'not authenticated' });
  req.userId = user.id;
}

/** The reply that makes the page ask for the password again (SECURITY.md S-33). */
export const REAUTH_REQUIRED = { error: 'type your password again to continue', code: 'reauth_required' } as const;

/** Whether the password was typed for this sign-in within the last few minutes. */
export function recentlyAuthenticated(req: FastifyRequest): boolean {
  const at = (req.session as SessionData).reauthAt;
  return typeof at === 'number' && Date.now() - at <= REAUTH_WINDOW_MS;
}

/**
 * For the actions a stolen session cookie would use to take everything at once or to widen what a link shows: the
 * whole-archive export, and a share link that shows page images. Run after `requireAuth`.
 */
export async function requireRecentAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!recentlyAuthenticated(req)) return reply.status(403).send(REAUTH_REQUIRED);
}
