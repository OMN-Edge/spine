import { createHash } from 'node:crypto';
import type { SessionStore } from '@fastify/session';
import { getAccountsStore } from 'spine-core/store/index.js';
import { sessionLimits } from './config.js';

/**
 * Where `@fastify/session` keeps a session's state: the accounts database, so a restart of the server signs no one out (SECURITY.md
 * S-16). A row is found by the sha256 of the cookie's session id, so a copy of the database opens no session; it ends when the cookie
 * does, and the row in `user_sessions` still decides whether a sign-in is valid (S-33).
 */
const digest = (sid: string) => createHash('sha256').update(sid).digest('hex');

// The library restores a session from the plain object it is given (its cookie from `cookie`), as with any store that serialises.
export const sessionStore: SessionStore = {
  get(sid, callback) {
    getAccountsStore().cookieSessions.get(digest(sid), new Date().toISOString())
      .then(data => callback(null, data ? JSON.parse(data) : null), (err: Error) => callback(err));
  },
  set(sid, session, callback) {
    const expires = session.cookie?.expires ? new Date(session.cookie.expires) : new Date(Date.now() + sessionLimits().absoluteMs);
    const userId = (session as { userId?: string }).userId ?? null;
    getAccountsStore().cookieSessions.set(digest(sid), { userId, data: JSON.stringify(session), expiresAt: expires.toISOString() })
      .then(() => callback(), (err: Error) => callback(err));
  },
  destroy(sid, callback) {
    getAccountsStore().cookieSessions.destroy(digest(sid)).then(() => callback(), (err: Error) => callback(err));
  },
};

/** How the server keeps sessions, shared with the tests that drive it so they run on the same store. Written only when a session changes, so a visitor with no sign-in leaves no row. */
export const sessionPersistence = { store: sessionStore, saveUninitialized: false, rolling: false } as const;
