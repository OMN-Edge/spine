import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getStore, type UserRecord } from '../store/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth`. Empty on a route that has not passed through it. */
    userId: string;
  }
}

export interface SessionData {
  userId?: string;
  authVersion?: number;
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
  return user;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const user = await authenticate(req);
  if (!user) return reply.status(401).send({ error: 'not authenticated' });
  req.userId = user.id;
}
