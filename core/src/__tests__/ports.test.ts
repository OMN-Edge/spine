import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requireRecentAuth, useRequestAuth, REAUTH_REQUIRED } from '../routes/middleware.js';
import { HEALTH_CONSENT_VERSION, TERMS_VERSION } from '../consent.js';
import { ownerCanBeMailed, useShareHost, type ShareHost } from '../share-host.js';
import { useOwnerNotices } from '../owner-notices.js';
import type { UserRecord } from '../store/index.js';

/**
 * The two ports the routes depend on. RequestAuth is how a request is tied to a person (the server reads a session, the device has one
 * person): with none registered nobody is signed in, so a process that forgot to say refuses everything. OwnerNotices is how an owner is
 * mailed about a request to open a share.
 */
const reply = () => {
  const r = { code: 0, body: undefined as unknown, status(code: number) { r.code = code; return r; }, send(body: unknown) { r.body = body; return r; } };
  return r;
};
const request = (url = '/api/documents') => ({ url, userId: '' }) as unknown as FastifyRequest & { userId: string };
const user = (over: Partial<UserRecord> = {}) => ({ id: 'u-1', health_consent_version: HEALTH_CONSENT_VERSION, terms_version: TERMS_VERSION, ...over }) as UserRecord;

afterEach(() => { useRequestAuth(null); useShareHost(null); useOwnerNotices(null); });

describe('requireAuth', () => {
  it('refuses every request when no way of knowing who it is from has been registered', async () => {
    const r = reply();
    await requireAuth(request(), r as unknown as FastifyReply);
    expect(r.code).toBe(401);
  });

  it('refuses a request the registered way does not know', async () => {
    useRequestAuth({ user: async () => null, recent: () => true });
    const r = reply();
    await requireAuth(request(), r as unknown as FastifyReply);
    expect(r.code).toBe(401);
  });

  it('lets a known person through and says who they are', async () => {
    useRequestAuth({ user: async () => user(), recent: () => true });
    const req = request();
    const r = reply();
    await requireAuth(req, r as unknown as FastifyReply);
    expect(r.code).toBe(0);
    expect(req.userId).toBe('u-1');
  });

  it('holds an account that has not agreed to the current texts, except where it can agree, sign out or leave', async () => {
    useRequestAuth({ user: async () => user({ terms_version: 'an older text' }), recent: () => true });
    const held = reply();
    await requireAuth(request('/api/documents'), held as unknown as FastifyReply);
    expect(held.code).toBe(403);
    expect(held.body).toMatchObject({ code: 'consent_required' });
    for (const allowed of ['/api/auth/me', '/api/account/consent', '/api/account/delete']) {
      const r = reply();
      await requireAuth(request(allowed), r as unknown as FastifyReply);
      expect(r.code, allowed).toBe(0);
    }
  });
});

describe('requireRecentAuth', () => {
  it('asks for the password again when it was not typed lately, and when nothing is registered', async () => {
    useRequestAuth({ user: async () => user(), recent: () => false });
    const stale = reply();
    await requireRecentAuth(request(), stale as unknown as FastifyReply);
    expect(stale.code).toBe(403);
    expect(stale.body).toEqual(REAUTH_REQUIRED);

    useRequestAuth(null);
    const none = reply();
    await requireRecentAuth(request(), none as unknown as FastifyReply);
    expect(none.code).toBe(403);
  });

  it('lets a request through when it was', async () => {
    useRequestAuth({ user: async () => user(), recent: () => true });
    const r = reply();
    await requireRecentAuth(request(), r as unknown as FastifyReply);
    expect(r.code).toBe(0);
  });
});

describe('whether the owner can be told by mail when a browser asks to open a link', () => {
  const host = (mails: boolean) => ({ mailsOwner: () => mails }) as unknown as ShareHost;
  const notices = (enabled: boolean) => ({ enabled: () => enabled, accessRequested: async () => {} });

  it('asks the device’s share host when there is one, whatever the route’s own mailer is', () => {
    useShareHost(host(true));
    useOwnerNotices(notices(false));
    expect(ownerCanBeMailed()).toBe(true);
    useShareHost(host(false));
    useOwnerNotices(notices(true));
    expect(ownerCanBeMailed()).toBe(false);
  });

  it('asks the route’s own mailer without a device, and says no when there is neither', () => {
    useOwnerNotices(notices(true));
    expect(ownerCanBeMailed()).toBe(true);
    useOwnerNotices(notices(false));
    expect(ownerCanBeMailed()).toBe(false);
    useOwnerNotices(null);
    expect(ownerCanBeMailed()).toBe(false);
  });
});
