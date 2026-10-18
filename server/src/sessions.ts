import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessionLimits } from './config.js';
import { getStore } from './store/index.js';
import type { SessionData } from './routes/middleware.js';

/**
 * Sign-ins the owner can see and end (SECURITY.md S-33). The cookie session lives in memory; the row in
 * `user_sessions` is what makes it valid, so a sign-in can be listed, ended from another browser, expired by
 * inactivity and by age, and a stolen cookie is good for hours rather than weeks.
 */

export const DEVICE_COOKIE = 'spine_device';
const ONE_YEAR_S = 365 * 24 * 60 * 60;
/** Last-seen is written at most this often, so reading a page is not a write each time. */
const TOUCH_EVERY_MS = 60 * 1000;
/** After this long since the password (or password and code) was last typed, a sensitive action asks again. */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

const clean = (value: unknown, max: number) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';

export const deviceHash = (cookie: string) => createHash('sha256').update(cookie).digest('hex');

export type DeviceState = 'first' | 'known' | 'new';

/**
 * Records a sign-in for a user whose password (and second factor) has just been accepted. The caller has already
 * regenerated the cookie session. Returns whether this browser is new to the account, so it can be mailed about.
 */
export async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string, authVersion: number): Promise<DeviceState> {
  const now = new Date();
  const session = req.session as SessionData;
  session.userId = userId;
  session.authVersion = authVersion;
  session.sid = randomUUID();
  session.reauthAt = now.getTime(); // the password was just typed

  const store = getStore();
  const limits = sessionLimits();
  await store.sessions.prune(userId, new Date(now.getTime() - limits.absoluteMs).toISOString(), new Date(now.getTime() - limits.idleMs).toISOString());
  await store.sessions.open(userId, {
    id: session.sid,
    at: now.toISOString(),
    userAgent: clean(req.headers['user-agent'], 200),
    address: clean(req.ip, 64),
  });

  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies ?? {};
  let device = cookies[DEVICE_COOKIE];
  if (!device || !/^[A-Za-z0-9_-]{43}$/.test(device)) {
    device = randomBytes(32).toString('base64url');
    reply.setCookie(DEVICE_COOKIE, device, {
      path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: ONE_YEAR_S,
    });
  }
  return store.sessions.rememberDevice(userId, deviceHash(device), now.toISOString());
}

/**
 * Whether the cookie session is still a live sign-in; refreshes last-seen. False (and the row removed) once it is
 * past its idle or absolute limit, or was ended from the list.
 */
export async function sessionIsLive(userId: string, session: SessionData): Promise<boolean> {
  if (!session.sid) return false;
  const store = getStore();
  const row = await store.sessions.get(userId, session.sid);
  if (!row) return false;
  const now = Date.now();
  const limits = sessionLimits();
  if (now - Date.parse(row.created_at) > limits.absoluteMs || now - Date.parse(row.last_seen_at) > limits.idleMs) {
    await store.sessions.revoke(userId, session.sid);
    return false;
  }
  if (now - Date.parse(row.last_seen_at) > TOUCH_EVERY_MS) await store.sessions.touch(userId, session.sid, new Date(now).toISOString());
  return true;
}

/** Ends every sign-in of this user except the one making the request (a password or second-factor change). */
export function endOtherSessions(userId: string, session: SessionData): Promise<number> {
  return getStore().sessions.revokeExcept(userId, session.sid ?? null);
}
