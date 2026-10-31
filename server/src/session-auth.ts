import type { FastifyRequest } from 'fastify';
import { useRequestAuth, type RequestAuth } from 'spine-core/routes/middleware.js';
import { getAccountsStore, type UserRecord } from 'spine-core/store/index.js';
import { REAUTH_WINDOW_MS, sessionIsLive } from './sessions.js';

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
  /** A passkey challenge the server made and the device has yet to sign: single use, short lived. */
  passkey?: { kind: 'register' | 'login'; challenge: string; expiresAt: number };
}

/**
 * Whether an account may have a session at all: its address is confirmed and, under `SPINE_REGISTRATION=approval`, the administrator has approved
 * it. Every place that would issue or keep a session asks this, so a sign-up that is waiting cannot get in by another door (passkey, second step,
 * enrolment).
 */
export const maySignIn = (user: Pick<UserRecord, 'email_verified_at' | 'approved'>): boolean => !!user.email_verified_at && user.approved !== 0;

/**
 * Resolve the session to a live user, or null.
 *
 * Checked against the database on every call, not trusted from the cookie: a
 * deleted user or a changed password (`auth_version`) ends the session at once.
 */
export async function authenticate(req: FastifyRequest): Promise<UserRecord | null> {
  const session = req.session as SessionData;
  if (!session.userId) return null;

  const user = await getAccountsStore().users.findById(session.userId);
  if (!user || !maySignIn(user) || user.auth_version !== session.authVersion) {
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

/** The server's way of knowing who a request is from: the session cookie, checked against the database. */
export const sessionAuth: RequestAuth = {
  // The request a hook is given on this server is Fastify's, which has the session.
  user: req => authenticate(req as FastifyRequest),
  recent: req => {
    const at = ((req as FastifyRequest).session as SessionData).reauthAt;
    return typeof at === 'number' && Date.now() - at <= REAUTH_WINDOW_MS;
  },
};

/** Called by every entry point that serves requests, before routes are registered. Without it every request is refused. */
export function useSessionAuth(): void {
  useRequestAuth(sessionAuth);
}
