import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, seedDocument } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { useShareHost, type ShareHost, type PublishInput } from '../share-host.js';

/**
 * The share routes with a device behind them: what they ask it to do, in what order, and what they say when it fails. The device's own
 * work (making the copy, sealing it, wrapping a key) is tested where it lives.
 */
describe('share links made by a device', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  let doc: string;
  const calls: string[] = [];
  let published: PublishInput[] = [];
  let failWith: (Error & { status?: number }) | null = null;
  let keyCounter = 0;

  const host: ShareHost = {
    async publish(input) { if (failWith) throw failWith; published.push(input); calls.push(`publish${input.newKey ? ':new-key' : ''}`); return { key: `key-${++keyCounter}` }; },
    async update(l) { calls.push(`update:${l.requireApproval}`); },
    async revoke(id) { if (failWith) throw failWith; calls.push(`revoke:${id.length > 0}`); },
    async pull() { calls.push('pull'); },
    async answer(_u, r, decision, shareKey) { if (failWith) throw failWith; calls.push(`answer:${decision}:${r.visitorKey}:${shareKey}`); },
    mailsOwner: () => true,
    addressOf: (id, key) => `https://spine.test/share/${id}${key ? `#${key}` : ''}`,
  };

  beforeAll(async () => {
    app = await buildTestApp();
    cookie = await loginSession(app);
    doc = (await seedDocument({})).id;
    useShareHost(host);
  });
  afterAll(() => useShareHost(null));
  beforeEach(() => { calls.length = 0; published = []; failWith = null; });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url, headers: { cookie }, payload: payload as object | undefined });
  const create = (extra: Record<string, unknown> = {}) => call('POST', '/api/share-links', { scope: 'document_ids', scope_value: [doc], ...extra });

  it('has the device seal and send the copy, keeps the key in the owner’s records, and gives an address with the key after the #', async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; url: string; token: string }>();
    expect(body.url).toBe(`https://spine.test/share/${body.id}#key-${keyCounter}`);
    expect(body.token).toBe(body.id);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ userId: OWNER_ID, documentIds: [doc], newKey: true });
    expect(await getStore().shareLinks.keyFor(OWNER_ID, body.id)).toBe(`key-${keyCounter}`);
  });

  it('gives an address with no key for a link that needs approval, and says whether the owner will be mailed', async () => {
    const res = await create({ require_approval: true });
    const body = res.json<{ id: string; url: string; approval_mail: boolean }>();
    expect(body.url).toBe(`https://spine.test/share/${body.id}`);
    expect(body.approval_mail).toBe(true);
  });

  it('does not leave a link behind that could not be published', async () => {
    failWith = Object.assign(new Error('the shares hold too much; revoke one first'), { status: 413, code: 'full' });
    const res = await create({ label: 'will fail' });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('full');
    const links = (await call('GET', '/api/share-links')).json<Array<{ label: string | null; revoked: boolean }>>();
    expect(links.find(l => l.label === 'will fail')?.revoked).toBeTruthy();
  });

  it('collects what visitors did before showing the list, a link, or the requests', async () => {
    const { id } = (await create()).json<{ id: string }>();
    calls.length = 0;
    await call('GET', '/api/share-links');
    await call('GET', `/api/share-links/${id}`);
    await call('GET', '/api/share-requests');
    expect(calls.filter(c => c === 'pull')).toHaveLength(3);
  });

  it('makes the copy again when what it holds changes, under a new key only when the approval setting does', async () => {
    const { id } = (await create({ label: 'first' })).json<{ id: string }>();
    calls.length = 0;
    const relabel = await call('PATCH', `/api/share-links/${id}`, { label: 'second', allow_chat: true });
    expect(calls).toEqual(['publish']);
    expect(relabel.json().url).toContain('#key-');

    calls.length = 0;
    const approval = await call('PATCH', `/api/share-links/${id}`, { require_approval: true });
    expect(calls).toEqual(['publish:new-key']);
    expect(approval.json().url).toBe(`https://spine.test/share/${id}`);

    calls.length = 0;
    await call('PATCH', `/api/share-links/${id}`, { expires_days: 3 });
    expect(calls).toEqual(['update:true']);
  });

  it('revokes at the server too, and says so when the server could not be told', async () => {
    const { id } = (await create()).json<{ id: string }>();
    calls.length = 0;
    expect((await call('DELETE', `/api/share-links/${id}`)).statusCode).toBe(200);
    expect(calls).toEqual(['revoke:true']);

    const other = (await create()).json<{ id: string }>();
    failWith = new Error('offline');
    const res = await call('DELETE', `/api/share-links/${other.id}`);
    expect(res.statusCode).toBe(502);
    expect(res.json().revoked).toBe(true);
  });

  it('answers a visitor’s request through the device, with the share key only for an approval', async () => {
    const { id } = (await create({ require_approval: true })).json<{ id: string }>();
    await getStore().shareLinks.createRequest(id, { id: 'req-1', visitorHash: 'visitor-public-key', note: 'Dr. Example', ipAddress: 'NL', userAgent: null, requestedAt: new Date().toISOString() }, 5);
    calls.length = 0;
    const res = await call('POST', '/api/share-requests/req-1/decision', { decision: 'approve' });
    expect(res.statusCode).toBe(200);
    expect(calls).toContain(`answer:approve:visitor-public-key:key-${keyCounter}`);
    expect((await call('GET', '/api/share-requests/req-1')).json().status).toBe('approved');

    await getStore().shareLinks.createRequest(id, { id: 'req-2', visitorHash: 'another-key', note: null, ipAddress: null, userAgent: null, requestedAt: new Date().toISOString() }, 5);
    calls.length = 0;
    await call('POST', '/api/share-requests/req-2/decision', { decision: 'deny' });
    expect(calls).toContain('answer:deny:another-key:null');
  });

  it('leaves a request unanswered here when the answer could not be sent', async () => {
    const { id } = (await create({ require_approval: true })).json<{ id: string }>();
    await getStore().shareLinks.createRequest(id, { id: 'req-3', visitorHash: 'k3', note: null, ipAddress: null, userAgent: null, requestedAt: new Date().toISOString() }, 5);
    failWith = new Error('offline');
    expect((await call('POST', '/api/share-requests/req-3/decision', { decision: 'approve' })).statusCode).toBe(502);
    expect((await call('GET', '/api/share-requests/req-3')).json().status).toBe('pending');
  });
});
