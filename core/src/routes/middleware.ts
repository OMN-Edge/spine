import type { HttpApp, HttpRequest } from '../http.js';

/** What the hooks below ask of a request and a reply, so any host's own objects fit (the server's are Fastify's). */
export type HookRequest = Pick<HttpRequest, 'url' | 'userId'>;
export interface HookReply { status(code: number): { send(payload?: unknown): unknown } }
import type { UserRecord } from '../store/index.js';
import { consentCurrent } from '../consent.js';

/**
 * How a request is tied to a person. The routes only ask `requireAuth`, so they run unchanged where there is a session cookie to read
 * (the server: `server/src/session-auth.ts`, checked against its database on every call) and where there is one person and no cookie (the
 * device: `web/src/core/boot.ts`). With none registered nobody is signed in, so a process that forgot to say refuses every request.
 */
export interface RequestAuth {
  /** The live user the request comes from, or null. */
  user(req: HookRequest): Promise<UserRecord | null>;
  /** Whether the password was typed recently enough for the actions that ask again (SECURITY.md S-33). */
  recent(req: HookRequest): boolean;
}

let current: RequestAuth | null = null;
export const useRequestAuth = (auth: RequestAuth | null): void => { current = auth; };

/** Declares the request property; call once on the root instance, before routes. */
export function decorateAuth(app: HttpApp): void {
  app.decorateRequest('userId', '');
}

/**
 * What an account may do before it has agreed to the current texts: sign out and change the sign-in (`/api/auth/`), say what it
 * agrees to, and leave by deleting the account. Everything else holds medical records, which are not touched without consent.
 */
const BEFORE_CONSENT = ['/api/auth/', '/api/account/consent', '/api/account/delete'];

export async function requireAuth(req: HookRequest, reply: HookReply) {
  const user = current ? await current.user(req) : null;
  if (!user) return reply.status(401).send({ error: 'not authenticated' });
  if (!consentCurrent(user)) {
    const path = req.url.split('?')[0];
    if (!BEFORE_CONSENT.some(p => path.startsWith(p))) return reply.status(403).send({ error: 'agree to the terms and the use of your health data first', code: 'consent_required' });
  }
  req.userId = user.id;
}

/** The reply that makes the page ask for the password again (SECURITY.md S-33). */
export const REAUTH_REQUIRED = { error: 'type your password again to continue', code: 'reauth_required' } as const;

/** Whether the password was typed for this sign-in within the last few minutes. */
export const recentlyAuthenticated = (req: HookRequest): boolean => current?.recent(req) ?? false;

/**
 * For the actions a stolen session cookie would use to take everything at once or to widen what a link shows: the
 * whole-archive export, and a share link that shows page images. Run after `requireAuth`.
 */
export async function requireRecentAuth(req: HookRequest, reply: HookReply) {
  if (!recentlyAuthenticated(req)) return reply.status(403).send(REAUTH_REQUIRED);
}
