import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { buildTestApp, loginSession } from './helpers/app.js';
import { seedDocument, createTestUser, TEST_PASSWORD } from './helpers/seed.js';
import { resetMailer, type Mailer, type MailMessage } from '../mail/index.js';

/** SECURITY.md M-19: a link that needs approval is read only by a browser the owner approved. */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let owner: string;
let docId: string;
let sent: MailMessage[];
let mailerEnabled: boolean;

const fakeMailer: Mailer = {
  get enabled() { return mailerEnabled; },
  async send(message) { sent.push(message); },
};

beforeAll(async () => { app = await buildTestApp(); owner = await loginSession(app); docId = (await seedDocument({})).id; });
afterAll(async () => { await app.close(); });
beforeEach(() => { sent = []; mailerEnabled = true; resetMailer(fakeMailer); });
afterEach(() => resetMailer(null));

async function approvalLink(requireApproval = true) {
  const res = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie: owner }, payload: { scope: 'all', label: 'Dr. Invented', require_approval: requireApproval } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string };
}
const visitorCookie = (res: { cookies: Array<{ name: string; value: string }> }) => res.cookies.map(c => `${c.name}=${c.value}`).join('; ');
const ask = (token: string, cookie?: string, note?: string) =>
  app.inject({ method: 'POST', url: `/api/share/${token}/access-request`, headers: cookie ? { cookie } : {}, payload: { note } });
const read = (token: string, cookie?: string) =>
  app.inject({ method: 'GET', url: `/api/share/${token}/documents`, headers: cookie ? { cookie } : {} });
const decide = (id: string, decision: string, cookie = owner) =>
  app.inject({ method: 'POST', url: `/api/share-requests/${id}/decision`, headers: { cookie }, payload: { decision } });
type Row = { id: string; status: string; note: string | null; share_link_id: string };
const requests = async (cookie = owner) => (await app.inject({ method: 'GET', url: '/api/share-requests', headers: { cookie } })).json() as Row[];
const requestsOf = async (linkId: string) => (await requests()).filter(r => r.share_link_id === linkId);

describe('a link that needs approval', () => {
  it('reads nothing for a browser that has not asked, is waiting, or was denied', async () => {
    const { id, token } = await approvalLink();
    expect((await read(token)).statusCode).toBe(403);

    const first = await ask(token, undefined, 'Dr. Invented, front desk');
    expect(first.statusCode).toBe(202);
    const cookie = visitorCookie(first);
    expect(cookie).toContain('spine_share_visitor=');
    expect(first.cookies[0]).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/share' });
    const waiting = await read(token, cookie);
    expect(waiting.statusCode).toBe(403);
    expect(waiting.json().approval).toBe('pending');

    const [request] = await requestsOf(id);
    expect(request.note).toBe('Dr. Invented, front desk');
    expect((await decide(request.id, 'deny')).statusCode).toBe(200);
    expect((await read(token, cookie)).json().approval).toBe('denied');
  });

  it('is read by the approved browser and by no other', async () => {
    const { id, token } = await approvalLink();
    const cookie = visitorCookie(await ask(token));
    const [request] = await requestsOf(id);
    expect((await decide(request.id, 'approve')).statusCode).toBe(200);

    expect((await read(token, cookie)).statusCode).toBe(200);
    expect((await read(token)).statusCode).toBe(403);
    // Another browser asks on its own account and is not let in by the first one's approval.
    const other = await ask(token);
    expect((await read(token, visitorCookie(other))).statusCode).toBe(403);
    // The approval is for this link: the same cookie opens no other.
    const second = await approvalLink();
    expect((await read(second.token, cookie)).statusCode).toBe(403);
  });

  it('reports its state in meta, and the owner can withdraw an approval', async () => {
    const { id, token } = await approvalLink();
    const cookie = visitorCookie(await ask(token));
    const [request] = await requestsOf(id);
    await decide(request.id, 'approve');
    expect((await app.inject({ method: 'GET', url: `/api/share/${token}/meta`, headers: { cookie } })).json().approval).toBe('open');
    await decide(request.id, 'deny');
    expect((await read(token, cookie)).statusCode).toBe(403);
  });

  it('shuts every data route, not just the list', async () => {
    const { token } = await approvalLink();
    for (const url of [
      `/api/share/${token}/trends`, `/api/share/${token}/trends/series?name=x`, `/api/share/${token}/documents/${docId}`,
      `/api/share/${token}/pages/x/image`, `/api/share/${token}/documents/${docId}/translation?lang=en`,
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(403);
    }
  });

  it('does not count a refused read as a view', async () => {
    const { id, token } = await approvalLink();
    await read(token);
    const links = (await app.inject({ method: 'GET', url: '/api/share-links', headers: { cookie: owner } })).json() as Array<{ id: string; view_count: number; require_approval: boolean }>;
    expect(links.find(l => l.id === id)).toMatchObject({ view_count: 0, require_approval: true });
  });

  it('tells the owner by mail, once per browser, with nothing from the link or the note', async () => {
    const { id, token } = await approvalLink();
    const cookie = visitorCookie(await ask(token, undefined, 'a note naming a diagnosis'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await ask(token, cookie);
    await ask(token, cookie);
    expect(sent).toHaveLength(1);
    const [request] = await requestsOf(id);
    expect(sent[0].text).toContain(`/share-requests/${request.id}`);
    const text = `${sent[0].subject} ${sent[0].text}`;
    expect(text).not.toMatch(/Invented|diagnosis|medic|health|record|document|patient|clinic|doctor/i);
    expect(text).not.toContain(token);
  });

  it('still takes the request when there is no mailer', async () => {
    mailerEnabled = false;
    const { id, token } = await approvalLink();
    expect((await ask(token)).statusCode).toBe(202);
    expect(sent).toEqual([]);
    expect((await requestsOf(id)).map(r => r.status)).toEqual(['pending']);
  });

  it('caps how many requests wait on one link', async () => {
    const { token } = await approvalLink();
    for (let i = 0; i < 5; i++) expect((await ask(token)).statusCode).toBe(202);
    expect((await ask(token)).statusCode).toBe(429);
  });

  it('is decided only by its owner, and not once the link is revoked', async () => {
    const { id, token } = await approvalLink();
    await ask(token);
    const [request] = await requestsOf(id);

    await createTestUser('someone-else@example.com');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'someone-else@example.com', password: TEST_PASSWORD } });
    const stranger = visitorCookie(login);
    expect((await decide(request.id, 'approve', stranger)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/share-requests/${request.id}`, headers: { cookie: stranger } })).statusCode).toBe(404);
    expect(await requests(stranger)).toEqual([]);

    await app.inject({ method: 'DELETE', url: `/api/share-links/${id}`, headers: { cookie: owner } });
    expect((await decide(request.id, 'approve')).statusCode).toBe(409);
  });

  it('needs a signed-in owner to see or decide', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/share-requests' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/share-requests/x/decision', payload: { decision: 'approve' } })).statusCode).toBe(401);
  });
});

describe('a link that does not need approval', () => {
  it('is read as before', async () => {
    const { token } = await approvalLink(false);
    expect((await read(token)).statusCode).toBe(200);
    expect((await ask(token)).json().approval).toBe('open');
  });
});
