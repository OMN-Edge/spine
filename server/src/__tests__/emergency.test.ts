import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { holdsRecordsInThisRun } from 'spine-core/testing/store-kind.js';
import { useShareHost, type ShareHost } from 'spine-core/share-host.js';
import { getAccountsStore, getStore } from 'spine-core/store/index.js';
import { buildTestApp, loginAs, loginSession, testShareHost } from './helpers/app.js';
import { createTestUser, OWNER_ID } from './helpers/seed.js';
import { resetMailer, type MailMessage } from '../mail/index.js';
import { remindCardReviews } from '../routes/shared.js';

const records = holdsRecordsInThisRun();
const CARD_ID = 'c0ffee00-0000-4000-8000-000000000001';
const CARD_BODY = { name: 'Jane Example', allergies: ['penicillin'], contacts: [{ name: 'Sam', relation: 'partner', phone: '+40 700 000 000' }] };

describe.runIf(records)('the owner’s emergency card', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  const sent: Array<{ id: string | null; key: string | null; content: string }> = [];
  const revoked: string[] = [];
  const reviewedIds: string[] = [];
  let made = 0;
  let failNext: (Error & { code?: string }) | null = null;
  let revokeFails = false;
  const host: ShareHost = {
    ...testShareHost,
    async publishCard(input) { if (failNext) { const e = failNext; failNext = null; throw e; } sent.push(input); return { id: input.id ?? (made++ === 0 ? CARD_ID : `${CARD_ID}-${made}`), key: input.key ?? (made === 1 ? 'k'.repeat(43) : String(made).repeat(43).slice(0, 43)) }; },
    async revokeCard(id) { if (revokeFails) throw new Error('down'); revoked.push(id); },
    async reviewCard(id) { reviewedIds.push(id); },
  };

  beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); useShareHost(host); });
  afterAll(() => useShareHost(testShareHost));
  beforeEach(() => { sent.length = 0; revoked.length = 0; reviewedIds.length = 0; failNext = null; revokeFails = false; });

  const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown, who = cookie) => app.inject({ method, url, headers: { cookie: who }, payload: payload as object | undefined });

  it('is for the signed-in only, and starts empty and off', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/emergency' })).statusCode).toBe(401);
    const body = (await call('GET', '/api/emergency')).json();
    expect(body).toMatchObject({ card: { name: '', allergies: [] }, published: null, scans: [] });
  });

  it('keeps what is written, cleaned, and refuses what is not a card', async () => {
    const saved = (await call('PUT', '/api/emergency', { ...CARD_BODY, allergies: [' penicillin ', ''] })).json();
    expect(saved.card.allergies).toEqual(['penicillin']);
    expect(saved.offline.text).toContain('Allergies: penicillin');
    expect((await call('PUT', '/api/emergency', { name: 'x'.repeat(500) })).statusCode).toBe(400);
    expect((await call('GET', '/api/emergency')).json().card.name).toBe('Jane Example');
  });

  it('is not sent anywhere until it is turned on, and not turned on while empty', async () => {
    await call('PUT', '/api/emergency', CARD_BODY);
    expect(sent).toEqual([]);
    const user = await createTestUser('empty-card@spine.test');
    const mine = await loginAs(app, user.email, user.password);
    const refused = await call('POST', '/api/emergency/publish', undefined, mine);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('empty');
  });

  it('is turned on once, gives an address that holds its key, and the same address after an edit', async () => {
    await call('PUT', '/api/emergency', CARD_BODY);
    const on = (await call('POST', '/api/emergency/publish')).json();
    expect(on.published.id).toBe(CARD_ID);
    expect(on.published.address).toBe(`https://spine.test/share/${CARD_ID}#${'k'.repeat(43)}`);
    expect(JSON.parse(sent[0].content).name).toBe('Jane Example');
    expect(sent[0]).toMatchObject({ id: null, key: null });

    // An edit is sent again under the same id and key, so the printed code keeps working.
    await call('PUT', '/api/emergency', { ...CARD_BODY, medications: ['warfarin 5 mg'] });
    expect(sent[1]).toMatchObject({ id: CARD_ID, key: 'k'.repeat(43) });
    expect(JSON.parse(sent[1].content).medications).toEqual(['warfarin 5 mg']);
  });

  it('says so when it could not be sent, and keeps what was written', async () => {
    await call('PUT', '/api/emergency', CARD_BODY);
    failNext = Object.assign(new Error('down'), { code: 'too_many_cards' });
    const refused = await call('POST', '/api/emergency/publish');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('too_many_cards');
    failNext = new Error('down');
    const unsent = await call('PUT', '/api/emergency', { ...CARD_BODY, notes: 'edited' });
    expect(unsent.statusCode).toBe(502);
    expect(unsent.json().code).toBe('not_sent');
    expect((await call('GET', '/api/emergency')).json().card.notes).toBe('edited'); // written here, to be sent when it is saved again
  });

  it('is turned off at the server and forgets the address', async () => {
    const off = (await call('DELETE', '/api/emergency/publish')).json();
    expect(revoked).toEqual([CARD_ID]);
    expect(off.published).toBeNull();
    expect((await getStore().emergency.get(OWNER_ID))?.card_key).toBeNull();
    // On again: a new id and key, not the old.
    await call('POST', '/api/emergency/publish');
    expect(sent.at(-1)).toMatchObject({ id: null, key: null });
  });

  it('keeps official details with the person and sends only the ones turned on', async () => {
    await call('PUT', '/api/emergency', { ...CARD_BODY, details: [{ kind: 'national_id', value: '1234567890123', on_card: true }, { kind: 'insurance_number', value: 'HI-998877' }] });
    const mine = (await call('GET', '/api/emergency')).json();
    expect(mine.card.details.map((d: { value: string }) => d.value)).toEqual(['1234567890123', 'HI-998877']); // the owner sees both
    expect(mine.offline.text).toContain('1234567890123');
    expect(mine.offline.text).not.toContain('HI-998877');
    await call('POST', '/api/emergency/publish');
    const sentNow = JSON.parse(sent.at(-1)!.content);
    expect(sentNow.details).toEqual([{ kind: 'national_id', label: '', value: '1234567890123', on_card: true }]);
    expect(sent.at(-1)!.content).not.toContain('HI-998877');
    // Turning one on later is sent on the next save, and turning one off takes it from the card.
    await call('PUT', '/api/emergency', { ...CARD_BODY, details: [{ kind: 'national_id', value: '1234567890123' }, { kind: 'insurance_number', value: 'HI-998877', on_card: true }] });
    const edited = sent.at(-1)!.content;
    expect(edited).toContain('HI-998877');
    expect(edited).not.toContain('1234567890123');
    await call('DELETE', '/api/emergency/publish');
  });

  it('is not turned on for a card with only details that are off', async () => {
    const user = await createTestUser('details-off@spine.test');
    const mine = await loginAs(app, user.email, user.password);
    await call('PUT', '/api/emergency', { details: [{ kind: 'insurer', value: 'Acme Health' }] }, mine);
    const refused = await call('POST', '/api/emergency/publish', undefined, mine);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('empty');
  });

  it('asks the owner to look at the card again after a year, and a look starts the year over', async () => {
    await call('PUT', '/api/emergency', CARD_BODY);
    await call('POST', '/api/emergency/publish');
    const fresh = (await call('GET', '/api/emergency')).json();
    expect(fresh.review_due).toBe(false);
    await getStore().emergency.markReviewed(OWNER_ID, new Date(Date.now() - 400 * 24 * 3600e3).toISOString());
    expect((await call('GET', '/api/emergency')).json().review_due).toBe(true);
    const again = (await call('POST', '/api/emergency/reviewed')).json();
    expect(again.review_due).toBe(false);
    expect(reviewedIds).toEqual([again.published.id]); // the server's year starts over too
    // An edit counts as a look.
    await getStore().emergency.markReviewed(OWNER_ID, new Date(Date.now() - 400 * 24 * 3600e3).toISOString());
    expect((await call('PUT', '/api/emergency', { ...CARD_BODY, notes: 'checked' })).json().review_due).toBe(false);
    await call('DELETE', '/api/emergency/publish');
    expect((await call('GET', '/api/emergency')).json().review_due).toBe(false); // a card that is off is not asked about
  });

  it('is replaced with a new code when the old one is lost: the old is turned off first, then a new id and key', async () => {
    expect((await call('POST', '/api/emergency/replace')).statusCode).toBe(409); // not on
    await call('PUT', '/api/emergency', CARD_BODY);
    const first = (await call('POST', '/api/emergency/publish')).json().published;
    const replaced = await call('POST', '/api/emergency/replace');
    expect(replaced.statusCode).toBe(200);
    const next = replaced.json().published;
    expect(revoked).toEqual([first.id]);
    expect(next.id).not.toBe(first.id);
    expect(next.address).not.toBe(first.address);
    expect(sent.at(-1)).toMatchObject({ id: null, key: null });
    expect(JSON.parse(sent.at(-1)!.content).name).toBe('Jane Example');

    // If the old code cannot be turned off nothing is changed; if the new one cannot be made the card is left off, and says so.
    revokeFails = true;
    const stuck = await call('POST', '/api/emergency/replace');
    expect(stuck.statusCode).toBe(502);
    expect((await call('GET', '/api/emergency')).json().published.id).toBe(next.id);
    revokeFails = false;
    failNext = new Error('down');
    const off = await call('POST', '/api/emergency/replace');
    expect(off.statusCode).toBe(502);
    expect(off.json().code).toBe('old_off');
    expect((await call('GET', '/api/emergency')).json().published).toBeNull();
    await call('POST', '/api/emergency/publish'); // and turning it on again works
    await call('DELETE', '/api/emergency/publish');
  });

  it('shows each opening, newest first, to its owner only', async () => {
    const store = getStore();
    await store.emergency.addScan(OWNER_ID, { id: 's1', at: '2026-01-01T10:00:00.000Z', country: 'IT' });
    await store.emergency.addScan(OWNER_ID, { id: 's2', at: '2026-01-02T10:00:00.000Z', country: null });
    expect((await call('GET', '/api/emergency')).json().scans.map((s: { id: string }) => s.id)).toEqual(['s2', 's1']);
    const other = await createTestUser('other-card@spine.test');
    const theirs = await call('GET', '/api/emergency', undefined, await loginAs(app, other.email, other.password));
    expect(theirs.json().scans).toEqual([]);
    expect(theirs.json().card.name).toBe('');
  });
});

describe('the sealed card at the server', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  const mails: MailMessage[] = [];
  beforeAll(async () => {
    resetMailer({ enabled: true, send: async m => { mails.push(m); } });
    app = await buildTestApp();
    cookie = await loginSession(app);
  });
  afterAll(() => resetMailer(null));

  const putCard = (id: string, who = cookie, body = Buffer.from('sealed card')) => app.inject({ method: 'PUT', url: `/api/shared/${id}`, headers: { cookie: who, 'content-type': 'application/octet-stream', 'x-spine-kind': 'card' }, payload: body });
  const ID_A = 'card-aaaaaaaaaaaaaaaaaaaaaaaa';
  const ID_B = 'card-bbbbbbbbbbbbbbbbbbbbbbbb';

  it('is stored with no end, outside the share count, and is said to be a card', async () => {
    expect((await putCard(ID_A)).statusCode).toBe(201);
    const meta = (await app.inject({ method: 'GET', url: `/api/shared/${ID_A}/meta` })).json();
    expect(meta).toMatchObject({ kind: 'card', expires_at: null, approval: false });
    expect(await getAccountsStore().shared.usage(OWNER_ID, new Date().toISOString())).toEqual({ bundles: 0, bytes: 0 });
    const bundle = await app.inject({ method: 'GET', url: `/api/shared/${ID_A}/bundle` });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.rawPayload.toString()).toBe('sealed card');
  });

  it('is replaced under its own id, one is allowed for each person and no more than ten', async () => {
    expect((await putCard(ID_A, cookie, Buffer.from('second'))).statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: `/api/shared/${ID_A}/bundle` })).rawPayload.toString()).toBe('second');
    expect((await putCard(ID_B)).statusCode).toBe(201); // another person's card
    for (let n = 2; n < 10; n++) expect((await putCard(`card-${String(n).padStart(24, 'c')}`)).statusCode).toBe(201);
    const eleven = await putCard('card-zzzzzzzzzzzzzzzzzzzzzzzz');
    expect(eleven.statusCode).toBe(409);
    expect(eleven.json().code).toBe('too_many_cards');
    expect((await app.inject({ method: 'DELETE', url: '/api/shared/card-zzzzzzzzzzzzzzzzzzzzzzzz', headers: { cookie } })).statusCode).toBe(404);
    for (const id of [ID_B, ...Array.from({ length: 8 }, (_, k) => `card-${String(k + 2).padStart(24, 'c')}`)]) expect((await app.inject({ method: 'DELETE', url: `/api/shared/${id}`, headers: { cookie } })).statusCode).toBe(200);
  });

  it('is refused when it is empty, too big or someone else’s', async () => {
    expect((await putCard(ID_B, cookie, Buffer.alloc(70 * 1024))).statusCode).toBe(400);
    const other = await createTestUser('thief@spine.test');
    expect((await putCard(ID_A, await loginAs(app, other.email, other.password))).statusCode).toBe(404);
  });

  it('is counted and the owner told when it is opened, once in a while however often it is', async () => {
    mails.length = 0;
    const open = () => app.inject({ method: 'POST', url: `/api/shared/${ID_A}/opened`, payload: {} });
    expect((await open()).statusCode).toBe(204);
    expect((await open()).statusCode).toBe(204);
    await vi.waitFor(() => expect(mails).toHaveLength(1));
    expect(mails[0].to).toBe('owner@spine.test');
    expect(`${mails[0].subject} ${mails[0].text}`).not.toMatch(/medic|health|record|document|patient|clinic|doctor|allerg/i);
    expect((await getAccountsStore().shared.pendingOpens(OWNER_ID, 10)).length).toBe(2);
    const totals = Object.fromEntries((await getAccountsStore().metrics.totals('2000-01-01')).map(t => [t.name, t.total]));
    expect(totals.card_opened).toBeGreaterThanOrEqual(2);
  });

  it('is remembered about once a year: a mail to its owner when it has not been sent or looked at for a year, then not again until the next', async () => {
    mails.length = 0;
    const year = 365 * 24 * 3600e3;
    const store = getAccountsStore();
    const bundle = (await store.shared.get(ID_A))!;
    const created = Date.parse(bundle.createdAt);
    expect(await remindCardReviews(new Date(created + year - 3600e3))).toBe(0); // not yet a year
    expect(await remindCardReviews(new Date(created + year + 3600e3))).toBe(1);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('owner@spine.test');
    expect(`${mails[0].subject} ${mails[0].text}`).not.toMatch(/medic|health|record|document|patient|clinic|doctor|allerg/i);
    expect(await remindCardReviews(new Date(created + year + 2 * 3600e3))).toBe(0); // once, not every hour
    expect(await remindCardReviews(new Date(created + 2 * year + 7200e3))).toBe(1); // and again the year after, if still nothing

    // Saying it is still right, or sending it again, starts the year over.
    const later = new Date(created + 3 * year);
    expect((await app.inject({ method: 'POST', url: `/api/shared/${ID_A}/review`, headers: { cookie } })).statusCode).toBe(200);
    expect(await remindCardReviews(new Date(Date.now() + year - 3600e3))).toBe(0);
    void later;
    const other = await createTestUser('not-the-owner@spine.test');
    expect((await app.inject({ method: 'POST', url: `/api/shared/${ID_A}/review`, headers: { cookie: await loginAs(app, other.email, other.password) } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/shared/none-none-none-none-none-none/review', headers: { cookie } })).statusCode).toBe(404);
  });

  it('stops opening when it is turned off', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/api/shared/${ID_A}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/shared/${ID_A}/bundle` })).statusCode).toBe(410);
    expect((await putCard('card-dddddddddddddddddddddddd')).statusCode).toBe(201); // and a new one can be made in its place
    expect((await putCard(ID_B)).statusCode).toBe(409); // but a turned-off id is not brought back
  });
});
