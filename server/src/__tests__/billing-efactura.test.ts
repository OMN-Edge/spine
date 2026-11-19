import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ZipFile } from 'yazl';
import { getAccountsStore } from 'spine-core/store/index.js';
import { AnafError } from 'spine-anaf/error.js';
import { InvoiceError, type InvoiceDraft } from 'spine-billing/invoicing/issuer.js';
import { processInvoice, reverseRefunded } from '../billing/invoicing/queue.js';
import { changeSeller } from '../billing/invoicing/seller.js';
import type { Sale } from '../billing/provider.js';
import { efacturaIssuer, linkIsValid, signedLink } from 'spine-anaf/issuer.js';
import { AnafLink, expiryOf } from 'spine-anaf/anaf.js';
import { openText, sealText } from 'spine-anaf/seal.js';
import { readZip } from 'spine-anaf/zip.js';
import { openEfactura } from 'spine-billing/invoicing/efactura.js';
import { loadInvoicingConfig } from '../billing/invoicing/config.js';
import { loadBillingConfig } from '../billing/config.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser, TEST_PASSWORD } from './helpers/seed.js';

/** Spine's own e-Factura link (`packages/anaf/`): the authorisation with ANAF, the numbered documents, what is sent and what ANAF says, with ANAF scripted. */
const KEY = Buffer.alloc(32, 7);
const T0 = new Date('2026-11-16T10:00:00.000Z');
const ADMIN = 'admin-efactura@spine.test';
const SELLER = { name: 'Omni Edge SRL', tradeName: 'Spine', cif: '12345678', street: 'Str. Exemplului 1', city: 'Sector 1', county: 'B', sector: '1', postalCode: '010101' };
const ENV = {
  SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_efactura', STRIPE_WEBHOOK_SECRET: 'whsec_efactura',
  SPINE_STRIPE_PRICE_YEAR: 'pri_year', SPINE_STRIPE_PRICE_MONTH: 'pri_month', SPINE_STRIPE_PRICE_FOUNDING: 'pri_founding',
  SPINE_INVOICING: 'efactura', SPINE_INVOICING_VAT_PERCENT: '0', SPINE_INVOICING_ZERO_VAT: 'O', SPINE_DOMAIN: 'spine.test',
  ANAF_CLIENT_ID: 'client-id', ANAF_CLIENT_SECRET: 'client-secret', SPINE_EFACTURA_REDIRECT_URI: 'https://spine.test/api/admin/efactura/callback', SPINE_EFACTURA_KEY: KEY.toString('base64'),
};

/** A JWT as ANAF's: only its dates are read. */
const jwt = (expires: Date) => `${Buffer.from('{"alg":"RS512"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(expires.getTime() / 1000) })).toString('base64url')}.sig`;
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const zipOf = (files: Record<string, string>): Promise<Buffer> => new Promise((resolve, reject) => {
  const zip = new ZipFile();
  for (const [name, text] of Object.entries(files)) zip.addBuffer(Buffer.from(text), name);
  zip.end();
  const chunks: Buffer[] = [];
  zip.outputStream.on('data', c => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
});

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
/** ANAF, scripted by address: each entry answers any call to a URL that contains its key, in order; a `string` is a body, a `Buffer` a file. */
function anaf(script: Record<string, Array<string | Buffer | { status: number; body: string | Buffer }>>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: String(init.method ?? 'GET'), headers: (init.headers ?? {}) as Record<string, string>, body: typeof init.body === 'string' ? init.body : '' });
    const key = Object.keys(script).find(k => url.includes(k));
    // ANAF's check before an upload says the file is fine unless a test scripts another answer.
    if (!key && url.includes('/validare/')) return new Response(JSON.stringify({ stare: 'ok', Messages: [] }), { status: 200 });
    const next = key ? script[key]!.shift() : undefined;
    if (next === undefined) throw new Error(`unexpected call to ${url}`);
    const answer = typeof next === 'string' || Buffer.isBuffer(next) ? { status: 200, body: next } : next;
    return new Response(answer.body as never, { status: answer.status });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
const tokenAnswer = (access: Date, refresh: Date) => JSON.stringify({ access_token: jwt(access), refresh_token: jwt(refresh), token_type: 'Bearer' });

describe('Spine’s own e-Factura link', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-efactura-'));
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    app = await buildTestApp({ accounts: { registration: 'approval' }, admin: { admins: () => new Set([ADMIN]), readers: () => new Set([ADMIN]) } });
    await createTestUser(ADMIN);
    // The seller is saved on the admin page, for e-Factura as for a service.
    expect(await changeSeller(getAccountsStore(), SELLER, T0.toISOString())).toBeNull();
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => vi.unstubAllGlobals());
  const store = () => getAccountsStore().billing;
  const settings = (fetcher: typeof fetch, now = T0) => ({ mode: 'test' as const, clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'https://spine.test/cb', key: KEY, fetcher, now: () => now });
  const issuerOver = (fetcher: typeof fetch, now = T0, seller: typeof SELLER | null = SELLER) => {
    const link = new AnafLink(settings(fetcher, now), store());
    return efacturaIssuer({ seller: async () => seller, series: 'SPN', zeroVat: { category: 'O' }, pdfLink: id => `https://spine.test/pdf/${id}`, now: () => now, fetcher }, store(), link);
  };

  describe('the authorisation', () => {
    it('is asked of ANAF’s sign-in with the application, the way back and a one-time state, and exchanged within the time for the pair, which is kept sealed', async () => {
      const { calls, fetcher } = anaf({ '/token': [tokenAnswer(days(90), days(365))] });
      const link = new AnafLink(settings(fetcher), store());
      expect((await link.status()).authorised).toBe(false);
      const url = new URL(await link.authorisationUrl());
      expect(`${url.origin}${url.pathname}`).toBe('https://logincert.anaf.ro/anaf-oauth2/v1/authorize');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: 'client-id', redirect_uri: 'https://spine.test/cb', token_content_type: 'jwt' });
      const state = url.searchParams.get('state')!;
      await link.complete('the-code', state);
      expect(calls[0]).toMatchObject({ url: 'https://logincert.anaf.ro/anaf-oauth2/v1/token', method: 'POST' });
      expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
      expect(new URLSearchParams(calls[0]!.body).get('grant_type')).toBe('authorization_code');
      expect(new URLSearchParams(calls[0]!.body).get('code')).toBe('the-code');
      const kept = (await store().efacturaTokens())!;
      expect(kept.sealed).not.toContain('eyJ');
      expect(JSON.parse(openText(KEY, kept.sealed))).toHaveProperty('refresh');
      expect(() => openText(Buffer.alloc(32, 8), kept.sealed)).toThrow();
      expect(await link.status()).toMatchObject({ authorised: true, accessExpiresAt: days(90).toISOString(), refreshExpiresAt: days(365).toISOString(), refreshDue: false });
    });

    it('can be tried against ANAF’s own test service, which takes nothing for e-Factura and shows nothing of what it echoes', async () => {
      const { calls, fetcher } = anaf({ '/token': [tokenAnswer(days(90), days(365))], '/TestOauth/': ['Hello, Spine\nkey=Authorization val=[Bearer abc]\nkey=serial_certificate val=[123]', { status: 403, body: 'no' }, 'Request Rejected'] });
      const link = new AnafLink(settings(fetcher), store());
      await link.complete('the-code', new URL(await link.authorisationUrl()).searchParams.get('state')!);
      const taken = await link.hello();
      expect(taken).toEqual({ ok: true, status: 200, message: '', certificateSeen: true });
      expect(JSON.stringify(taken)).not.toMatch(/Bearer|abc|123/);
      expect(calls.at(-1)).toMatchObject({ url: 'https://api.anaf.ro/TestOauth/jaxrs/hello?name=Spine' });
      expect(calls.at(-1)!.headers.authorization).toMatch(/^Bearer /);
      expect(await link.hello()).toMatchObject({ ok: false, status: 403, message: expect.stringMatching(/sign in with the certificate again/) });
      expect(await link.hello()).toMatchObject({ ok: false, status: 200 });
    });

    it('is refused for a state that was not asked for, that was used already, or that took too long', async () => {
      const { fetcher } = anaf({ '/token': [tokenAnswer(days(90), days(365))] });
      const link = new AnafLink(settings(fetcher), store());
      await expect(link.complete('c', 'made-up')).rejects.toThrow(/not asked for/);
      const state = new URL(await link.authorisationUrl()).searchParams.get('state')!;
      await expect(new AnafLink(settings(fetcher, new Date(T0.getTime() + 11 * 60_000)), store()).complete('c', state)).rejects.toThrow(/took too long|not asked for/);
      // The late attempt used it up: the state cannot be tried again.
      await expect(link.complete('c', state)).rejects.toThrow(/not asked for/);
    });

    it('says what ANAF refused, and that waiting will not mend it', async () => {
      const { fetcher } = anaf({ '/token': [{ status: 400, body: JSON.stringify({ error: 'invalid_client' }) }] });
      const link = new AnafLink(settings(fetcher), store());
      const state = new URL(await link.authorisationUrl()).searchParams.get('state')!;
      await expect(link.complete('c', state)).rejects.toMatchObject({ name: 'AnafError', retry: false, message: expect.stringContaining('invalid_client') });
    });
  });

  describe('the access token', () => {
    const authorise = async (access: Date, refresh: Date, at = T0) => {
      const { fetcher } = anaf({ '/token': [tokenAnswer(access, refresh)] });
      const link = new AnafLink(settings(fetcher, at), store());
      await link.complete('c', new URL(await link.authorisationUrl()).searchParams.get('state')!);
    };

    it('is used as it is while it has weeks left, and refreshed when it has less than two (the pair replaced: ANAF rotates the refresh token)', async () => {
      await authorise(days(90), days(365));
      const quiet = anaf({});
      expect(expiryOf(await new AnafLink(settings(quiet.fetcher), store()).accessToken())).toEqual(days(90));
      expect(quiet.calls).toHaveLength(0);

      const { calls, fetcher } = anaf({ '/token': [tokenAnswer(days(180), days(455))] });
      const later = days(80);
      const fresh = await new AnafLink(settings(fetcher, later), store()).accessToken();
      expect(expiryOf(fresh)).toEqual(days(180));
      expect(new URLSearchParams(calls[0]!.body).get('grant_type')).toBe('refresh_token');
      expect(await new AnafLink(settings(quiet.fetcher, later), store()).status()).toMatchObject({ accessExpiresAt: days(180).toISOString(), refreshExpiresAt: days(455).toISOString() });
    });

    it('keeps working on the old one when a refresh fails while it is still good, and stops when it is not', async () => {
      await authorise(days(10), days(300));
      const failing = anaf({ '/token': [{ status: 400, body: JSON.stringify({ error: 'invalid_grant' }) }] });
      expect(expiryOf(await new AnafLink(settings(failing.fetcher), store()).accessToken())).toEqual(days(10));
      const dead = anaf({ '/token': [{ status: 400, body: JSON.stringify({ error: 'invalid_grant' }) }] });
      await expect(new AnafLink(settings(dead.fetcher, days(11)), store()).accessToken()).rejects.toThrow(/refused/);
    });

    it('is asked for again by the operator once the refresh token has ended, and before any authorisation', async () => {
      await authorise(days(90), days(365));
      await expect(new AnafLink(settings(anaf({}).fetcher, days(366)), store()).accessToken()).rejects.toMatchObject({ retry: true, message: expect.stringContaining('ended') });
    });

    it('is shared by callers at once: one refresh', async () => {
      await authorise(days(10), days(300));
      const { calls, fetcher } = anaf({ '/token': [tokenAnswer(days(100), days(400))] });
      const link = new AnafLink(settings(fetcher), store());
      const [a, b] = await Promise.all([link.accessToken(), link.accessToken()]);
      expect(a).toBe(b);
      expect(calls).toHaveLength(1);
    });
  });

  describe('the documents', () => {
    const draft = (over: Partial<InvoiceDraft> = {}): InvoiceDraft => ({
      id: 'cs_one', paidAt: '2026-11-16T09:00:00.000Z', currency: 'EUR', sendEmail: false,
      buyer: { name: 'Ion Popescu', email: 'ion@spine.test', country: 'RO', city: 'Cluj-Napoca', region: 'CJ', address: 'Str. Mare 5' },
      lines: [{ name: 'Spine Premium, lunar', amountMinor: 1190, quantity: 1, vatPercent: 0 }], ...over,
    });
    const authorised = async () => {
      const { fetcher } = anaf({ '/token': [tokenAnswer(days(90), days(365))] });
      const link = new AnafLink(settings(fetcher), store());
      await link.complete('c', new URL(await link.authorisationUrl()).searchParams.get('state')!);
    };

    it('are numbered in the series with no gaps and no repeats, a payment once however often it is asked', async () => {
      const issuer = issuerOver(anaf({}).fetcher);
      const first = await issuer.issue(draft({ id: 'cs_n1' }));
      expect(first).toMatchObject({ id: 'cs_n1', series: 'SPN', link: null });
      expect(await issuer.issue(draft({ id: 'cs_n1' }))).toEqual(first);
      const second = await issuer.issue(draft({ id: 'cs_n2' }));
      expect(Number(second.number)).toBe(Number(first.number) + 1);
      const row = (await store().efacturaDocument('cs_n1'))!;
      expect(row).toMatchObject({ kind: 'invoice', series: 'SPN', issue_date: '2026-11-16', anaf_state: null });
      expect(row.xml).toContain(`<cbc:ID>SPN-${first.number}</cbc:ID>`);
      expect(row.xml).toContain('<cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount>');
      expect(await issuer.pdfUrl({ id: 'cs_n1' })).toBe('https://spine.test/pdf/cs_n1');
    });

    it('wait, numbered, until an administrator has saved a seller, and are made once there is one', async () => {
      const draftNow = draft({ id: 'cs_noseller' });
      await expect(issuerOver(anaf({}).fetcher, T0, null).issue(draftNow)).rejects.toMatchObject({ name: 'AnafError', retry: true, message: expect.stringContaining('no seller') });
      expect((await store().efacturaDocument('cs_noseller'))!.xml).toBeNull();
      const made = await issuerOver(anaf({}).fetcher).issue(draftNow);
      expect(made).toMatchObject({ id: 'cs_noseller', series: 'SPN' });
      expect((await store().efacturaDocument('cs_noseller'))!.xml).toContain('Omni Edge SRL');
    });

    it('are dated the day they were paid, never a day that has not come', async () => {
      const issuer = issuerOver(anaf({}).fetcher);
      await issuer.issue(draft({ id: 'cs_old', paidAt: '2026-11-12T22:30:00.000Z' }));
      await issuer.issue(draft({ id: 'cs_future', paidAt: '2026-12-31T10:00:00.000Z' }));
      // 22:30 UTC is the next day in Romania.
      expect((await store().efacturaDocument('cs_old'))!.issue_date).toBe('2026-11-13');
      expect((await store().efacturaDocument('cs_future'))!.issue_date).toBe('2026-11-16');
    });

    it('date a credit note by the day of the refund, not the day it is made: the accountant\u2019s rule, so a refund retried later keeps its own day', async () => {
      const issuer = issuerOver(anaf({}).fetcher);
      const made = await issuer.issue(draft({ id: 'cs_refday' }));
      // 22:30 UTC on the 12th is the 13th in Romania; the credit note is made on the 16th (T0).
      await issuer.reverse({ id: 'cs_refday', series: made.series, number: made.number }, 'Rambursare', '2026-11-12T22:30:00.000Z');
      expect((await store().efacturaDocument('credit:cs_refday'))!.issue_date).toBe('2026-11-13');
      const plain = await issuer.issue(draft({ id: 'cs_refnow' }));
      await issuer.reverse({ id: 'cs_refnow', series: plain.series, number: plain.number }, 'Rambursare');
      expect((await store().efacturaDocument('credit:cs_refnow'))!.issue_date).toBe('2026-11-16');
    });

    it('refuse a draft that cannot be written as an invoice, as one that will not pass by waiting', async () => {
      const issuer = issuerOver(anaf({}).fetcher);
      await expect(issuer.issue(draft({ id: 'cs_nocounty', buyer: { name: 'Ion', email: 'i@spine.test', country: 'RO' } }))).rejects.toMatchObject({ name: 'AnafError', retry: false, message: expect.stringContaining('county') });
    });

    it('reverse an invoice with a credit note of its own number, once, from what the invoice was made from', async () => {
      const issuer = issuerOver(anaf({}).fetcher);
      const made = await issuer.issue(draft({ id: 'cs_rev' }));
      const credit = await issuer.reverse({ id: 'cs_rev', series: made.series, number: made.number }, 'Rambursare');
      expect(credit).toMatchObject({ id: 'credit:cs_rev', series: 'SPN' });
      expect(Number(credit!.number)).toBeGreaterThan(Number(made.number));
      expect(await issuer.reverse({ id: 'cs_rev', series: made.series, number: made.number }, 'Rambursare')).toEqual(credit);
      const row = (await store().efacturaDocument('credit:cs_rev'))!;
      expect(row).toMatchObject({ kind: 'credit', reverses: 'cs_rev' });
      expect(row.xml).toContain(`<cac:InvoiceDocumentReference><cbc:ID>SPN-${made.number}</cbc:ID>`);
      expect(row.xml).toContain('Rambursare');
      await expect(issuer.reverse({ id: 'cs_unknown', series: 'SPN', number: '1' }, 'x')).rejects.toBeInstanceOf(AnafError);
    });

    it('go to ANAF as a person’s report, are asked after until ANAF has decided, and the signed answer is kept', async () => {
      await authorised();
      const issuer = issuerOver(anaf({}).fetcher);
      await issuer.issue(draft({ id: 'cs_b2c' }));
      const signed = await zipOf({ '4001.xml': '<Invoice/>', 'semnatura_4001.xml': '<Signature/>' });
      const { calls: all, fetcher } = anaf({
        '/uploadb2c': ['<header xmlns="mfp:anaf:dgti:spv:respUploadFisier:v1" dateResponse="202611161000" ExecutionStatus="0" index_incarcare="4001"/>'],
        '/stareMesaj': ['<header stare="in prelucrare"/>', '<header stare="ok" id_descarcare="9001"/>'],
        '/descarcare': [signed],
      });
      const sender = issuerOver(fetcher);
      expect(await sender.sendToAnaf({ id: 'cs_b2c', series: 'SPN', number: '1' })).toMatchObject({ sent: true, code: 0 });
      const sentSoFar = () => all.filter(c => !c.url.includes('/validare/'));
      expect(all[0]!.url).toBe('https://api.anaf.ro/prod/FCTEL/rest/validare/FACT1');
      expect(sentSoFar()[0]).toMatchObject({ method: 'POST' });
      expect(sentSoFar()[0]!.url).toMatch(/^https:\/\/api\.anaf\.ro\/test\/FCTEL\/rest\/uploadb2c\?standard=UBL&cif=12345678$/);
      expect(sentSoFar()[0]!.headers.authorization).toMatch(/^Bearer /);
      expect(sentSoFar()[0]!.body).toContain('<Invoice');
      expect(await store().efacturaDocument('cs_b2c')).toMatchObject({ anaf_index: '4001', anaf_state: 'sent' });
      expect(await sender.sendToAnaf({ id: 'cs_b2c', series: 'SPN', number: '1' })).toMatchObject({ sent: true, code: 0 });
      expect(await sender.sendToAnaf({ id: 'cs_b2c', series: 'SPN', number: '1' })).toMatchObject({ sent: true, code: 1 });
      expect(sentSoFar().map(c => c.url.split('?')[0]!.replace('https://api.anaf.ro/test/FCTEL/rest', ''))).toEqual(['/uploadb2c', '/stareMesaj', '/stareMesaj', '/descarcare']);
      const row = (await store().efacturaDocument('cs_b2c'))!;
      expect(row.anaf_state).toBe('ok');
      expect([...readZip(Buffer.from(row.signed!, 'base64')).keys()]).toEqual(['4001.xml', 'semnatura_4001.xml']);
      // Done is done: no more calls.
      expect(await sender.sendToAnaf({ id: 'cs_b2c', series: 'SPN', number: '1' })).toMatchObject({ code: 1 });
      expect(sentSoFar()).toHaveLength(4);
    });

    it('go to ANAF as a company’s invoice, and a credit note as a credit note', async () => {
      await authorised();
      const issuer = issuerOver(anaf({}).fetcher);
      await issuer.issue(draft({ id: 'cs_b2b', buyer: { name: 'Client SRL', email: 'c@spine.test', country: 'RO', city: 'Iasi', region: 'IS', address: 'Str. 1', taxId: 'RO98765432' } }));
      await issuer.reverse({ id: 'cs_b2b', series: 'SPN', number: '1' }, 'Rambursare');
      const accepted = '<header ExecutionStatus="0" index_incarcare="77"/>';
      const { calls, fetcher } = anaf({ '/upload': [accepted, accepted] });
      const sender = issuerOver(fetcher);
      await sender.sendToAnaf({ id: 'cs_b2b', series: 'SPN', number: '1' });
      await sender.sendToAnaf({ id: 'credit:cs_b2b', series: 'SPN', number: '2' });
      const uploads = calls.filter(c => !c.url.includes('/validare/'));
      expect(uploads[0]!.url).toContain('/upload?standard=UBL');
      expect(uploads[0]!.body).toContain('<cbc:CompanyID>98765432</cbc:CompanyID>');
      expect(uploads[1]!.url).toContain('/upload?standard=CN');
      // Each was checked by ANAF first, as the standard it is: FACT1 for an invoice, FCN for a credit note, at the one address ANAF documents.
      expect(calls.filter(c => c.url.includes('/validare/')).map(c => c.url)).toEqual(['https://api.anaf.ro/prod/FCTEL/rest/validare/FACT1', 'https://api.anaf.ro/prod/FCTEL/rest/validare/FCN']);
    });

    it('are not sent when ANAF’s own check refuses them, which says why; a check that cannot be made lets the upload go on', async () => {
      await authorised();
      const issuer = issuerOver(anaf({}).fetcher);
      await issuer.issue(draft({ id: 'cs_check', buyer: { name: 'Client SRL', email: 'c@spine.test', country: 'RO', city: 'Iasi', region: 'IS', address: 'Str. 1', taxId: 'RO98765432' } }));
      const refusing = anaf({ '/validare/': [JSON.stringify({ stare: 'nok', Messages: [{ message: '[BR-RO-010] the buyer’s address is missing' }, { message: 'another' }], trace_id: 't1' })] });
      const refused = await issuerOver(refusing.fetcher).sendToAnaf({ id: 'cs_check', series: 'SPN', number: '1' });
      expect(refused).toEqual({ sent: false, code: 2, text: 'ANAF\'s check refused the file: [BR-RO-010] the buyer’s address is missing; another' });
      expect(refusing.calls.some(c => c.url.includes('/upload'))).toBe(false);
      expect(await store().efacturaDocument('cs_check')).toMatchObject({ anaf_state: 'nok', anaf_message: expect.stringContaining('BR-RO-010'), anaf_index: null });
      // Asked again (the operator mended it, or ANAF's rules did): a check that answers 500, or with something unreadable, or not at all, does not stop the upload.
      for (const [i, answer] of ([{ status: 500, body: 'oops' }, '<html>not json</html>', JSON.stringify({ stare: 'maybe' })] as const).entries()) {
        const again = anaf({ '/validare/': [answer as never], '/upload': ['<header ExecutionStatus="0" index_incarcare="88"/>'] });
        const sent = await issuerOver(again.fetcher).sendToAnaf({ id: 'cs_check', series: 'SPN', number: '1' });
        expect(sent, `answer ${i}`).toMatchObject({ sent: true, code: 0 });
        await store().efacturaUpdateDocument('cs_check', { anaf_state: 'nok', anaf_index: null, anaf_message: null }, T0.toISOString());
      }
    });

    it('are not sent for a buyer abroad: e-Factura is for Romania, and the document stays for the buyer’s history', async () => {
      const { calls, fetcher } = anaf({});
      const issuer = issuerOver(fetcher);
      await issuer.issue(draft({ id: 'cs_fr', buyer: { name: 'Eva Test', email: 'eva@spine.test', country: 'FR', city: 'Paris', address: '1 rue X' } }));
      expect(await issuer.sendToAnaf({ id: 'cs_fr', series: 'SPN', number: '1' })).toMatchObject({ sent: false, code: -1 });
      expect(calls).toHaveLength(0);
      expect((await store().efacturaDocument('cs_fr'))!.anaf_state).toBe('abroad');
    });

    it('are refused with ANAF’s own words, whether at the upload or at its decision, and sent again from what they were made from when the operator asks', async () => {
      await authorised();
      const issuer = issuerOver(anaf({}).fetcher);
      await issuer.issue(draft({ id: 'cs_nok' }));
      const refusal = zipOf({ '5001.xml': '<header><Error errorMessage="[BR-RO-120]-Identificatorul &amp; altul"/></header>', 'semnatura_5001.xml': '<Signature/>' });
      const { calls, fetcher } = anaf({
        '/uploadb2c': ['<header ExecutionStatus="1"><Errors errorMessage="Fisierul nu este conform"/></header>', '<header ExecutionStatus="0" index_incarcare="5001"/>'],
        '/stareMesaj': ['<header stare="nok" id_descarcare="9002"/>'],
        '/descarcare': [await refusal],
      });
      const sender = issuerOver(fetcher);
      expect(await sender.sendToAnaf({ id: 'cs_nok', series: 'SPN', number: '1' })).toEqual({ sent: false, code: 2, text: 'Fisierul nu este conform' });
      expect(await store().efacturaDocument('cs_nok')).toMatchObject({ anaf_state: 'nok', anaf_index: null });
      // The operator asks again: the file is sent as new, and this time ANAF takes it and then refuses it, and says why.
      expect(await sender.sendToAnaf({ id: 'cs_nok', series: 'SPN', number: '1' })).toMatchObject({ code: 0 });
      expect(await sender.sendToAnaf({ id: 'cs_nok', series: 'SPN', number: '1' })).toEqual({ sent: false, code: 2, text: '[BR-RO-120]-Identificatorul & altul' });
      expect(calls.filter(c => c.url.includes('/uploadb2c'))).toHaveLength(2);
    });

    it('wait for the operator where ANAF does not accept the authorisation, and for a minute where it is busy', async () => {
      await authorised();
      const issuer = issuerOver(anaf({}).fetcher);
      await issuer.issue(draft({ id: 'cs_wait' }));
      for (const [status, retry] of [[401, true], [403, true], [429, true], [503, true]] as const) {
        const sender = issuerOver(anaf({ '/uploadb2c': [{ status, body: 'no' }] }).fetcher);
        await expect(sender.sendToAnaf({ id: 'cs_wait', series: 'SPN', number: '1' })).rejects.toMatchObject({ name: 'AnafError', retry });
      }
      const rejected = issuerOver(anaf({ '/uploadb2c': ['<html><head><title>Request Rejected</title></head></html>'] }).fetcher);
      await expect(rejected.sendToAnaf({ id: 'cs_wait', series: 'SPN', number: '1' })).rejects.toMatchObject({ retry: false, message: expect.stringContaining('Request Rejected') });
      await expect(issuerOver(anaf({}).fetcher).sendToAnaf({ id: 'cs_wait', series: 'SPN', number: '1' })).rejects.toBeInstanceOf(AnafError);
    });

    it('have a PDF made here from the stored document with no request to ANAF, and the Ministry’s converter kept for comparison, with a clear word where it is not one', async () => {
      const issuer = issuerOver(anaf({}).fetcher);
      await issuer.issue(draft({ id: 'cs_pdf' }));
      const own = anaf({});
      expect((await issuerOver(own.fetcher).pdf('cs_pdf')).subarray(0, 4).toString('latin1')).toBe('%PDF');
      expect(own.calls).toEqual([]);
      const { calls, fetcher } = anaf({ '/transformare/FACT1': [Buffer.from('%PDF-1.4 test')] });
      expect((await issuerOver(fetcher).pdfByAnaf('cs_pdf')).toString()).toBe('%PDF-1.4 test');
      expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://webservicesp.anaf.ro/prod/FCTEL/rest/transformare/FACT1' });
      expect(calls[0]!.body).toContain('<Invoice');
      await expect(issuerOver(anaf({ '/transformare/FACT1': ['<html>nope</html>'] }).fetcher).pdfByAnaf('cs_pdf')).rejects.toThrow(/did not return a PDF/);
    });
  });

  describe('the billing code\u2019s door to it', () => {
    it('answers every call in the billing code\u2019s own error, with what the queue decides by (retry, status) kept', async () => {
      const { fetcher } = anaf({});
      const open = openEfactura({ mode: 'test', clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'https://spine.test/cb', key: KEY, seller: async () => SELLER, series: 'SPN', zeroVat: { category: 'O' }, publicUrl: 'https://spine.test' }, store(), { fetcher, now: () => T0 });
      // an invoice that does not exist is refused for good: the same class and flag as the issuer's own
      const refused = await open.issuer.reverse({ id: 'cs_none', series: 'SPN', number: '1' }, 'x').catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(InvoiceError);
      expect(refused).toMatchObject({ retry: false, status: null });
    });
  });

  describe('the queue', () => {
    const SALE: Sale = { paidAt: '2026-11-16T09:00:00.000Z', currency: 'EUR', buyer: { name: 'Ion Popescu', email: 'ion@spine.test', country: 'RO', city: 'Cluj-Napoca', region: 'CJ', address: 'Str. Mare 5' }, lines: [{ name: 'Spine Premium', amountMinor: 1190, quantity: 1 }] };
    it('takes a payment to an invoice with Spine’s own issuer, and a refund to its credit note, each sent to ANAF and decided', async () => {
      const authorise = anaf({ '/token': [tokenAnswer(days(90), days(365))] });
      const link = new AnafLink(settings(authorise.fetcher), store());
      await link.complete('c', new URL(await link.authorisationUrl()).searchParams.get('state')!);
      const taken = '<header ExecutionStatus="0" index_incarcare="6001"/>';
      const signed = await zipOf({ '1.xml': '<Invoice/>', 'semnatura_1.xml': '<S/>' });
      const { fetcher } = anaf({
        '/uploadb2c': [taken, '<header ExecutionStatus="0" index_incarcare="6002"/>'],
        '/stareMesaj': ['<header stare="ok" id_descarcare="1"/>', '<header stare="ok" id_descarcare="2"/>'],
        '/descarcare': [signed, signed],
      });
      const issuer = issuerOver(fetcher);
      const config = { enabled: true as const, issuer: 'efactura' as const, vatPercent: 0, efactura: true as const, mail: false as const, direct: {} as never };
      const ctx = { issuer, config, readSale: async () => SALE, now: () => T0 };
      const store_ = getAccountsStore();
      await store_.billing.queueInvoice('cs_queue_e1', null, T0.toISOString());
      expect(await processInvoice('cs_queue_e1', ctx)).toBe('issued');
      expect(await store_.billing.invoice('cs_queue_e1')).toMatchObject({ state: 'issued', series: 'SPN', issuer_ref: 'cs_queue_e1' });
      // ANAF is asked again when its time comes.
      const later = { ...ctx, now: () => new Date(T0.getTime() + 6 * 60_000) };
      expect(await processInvoice('cs_queue_e1', later)).toBe('done');
      expect((await store().efacturaDocument('cs_queue_e1'))!.anaf_state).toBe('ok');

      // The refund: a credit note, sent the same way.
      await reverseRefunded(['cs_queue_e1'], true, 're_1', later);
      expect(await store_.billing.invoice('storno:cs_queue_e1')).toMatchObject({ state: 'issued', issuer_ref: 'credit:cs_queue_e1' });
      expect(await processInvoice('storno:cs_queue_e1', { ...ctx, now: () => new Date(T0.getTime() + 12 * 60_000) })).toBe('done');
      expect(await store().efacturaDocument('credit:cs_queue_e1')).toMatchObject({ kind: 'credit', anaf_state: 'ok' });
    });
  });

  describe('the page and the routes', () => {
    const as = (email: string) => loginAs(app, email, TEST_PASSWORD);

    it('name the saved seller as the company on the pages where billing is on: the footer\u2019s line and the pricing page\u2019s seller', async () => {
      const options = (await app.inject({ method: 'GET', url: '/api/auth/options' })).json();
      expect(options.operator).toMatchObject({ name: 'Omni Edge SRL', ids: ['CIF 12345678'], address: 'Str. Exemplului 1, 010101 Sector 1' });
      expect((await app.inject({ method: 'GET', url: '/api/legal/terms' })).json().markdown).toContain('- Omni Edge SRL');
    });

    it('show the operator whether it is authorised and the newest documents, and nothing to anyone else', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/admin/efactura' })).statusCode).toBe(401);
      const other = await createTestUser('other-efactura@spine.test');
      expect((await app.inject({ method: 'GET', url: '/api/admin/efactura', headers: { cookie: await loginAs(app, other.email, other.password) } })).statusCode).toBe(403);
      const res = await app.inject({ method: 'GET', url: '/api/admin/efactura', headers: { cookie: await as(ADMIN) } });
      expect(res.json()).toMatchObject({ enabled: true, mode: 'test', series: 'SPN', seller: { cif: '12345678' }, redirect_uri: ENV.SPINE_EFACTURA_REDIRECT_URI, documents: expect.any(Array) });
      expect(JSON.stringify(res.json())).not.toMatch(/client-secret|eyJ|sealed/);
    });

    it('start the authorisation for an administrator only, and take ANAF’s browser back without a session, by the state alone', async () => {
      const post = (cookie?: string) => app.inject({ method: 'POST', url: '/api/admin/efactura/authorise', ...(cookie ? { headers: { cookie } } : {}) });
      expect((await post()).statusCode).toBe(401);
      const url = new URL((await post(await as(ADMIN))).json().url);
      expect(url.origin + url.pathname).toBe('https://logincert.anaf.ro/anaf-oauth2/v1/authorize');
      const state = url.searchParams.get('state')!;
      const callback = (query: string) => app.inject({ method: 'GET', url: `/api/admin/efactura/callback?${query}` });
      expect((await callback('code=x&state=guessed')).headers.location).toBe('/admin/invoices?efactura=error');
      expect((await callback('error=access_denied')).headers.location).toBe('/admin/invoices?efactura=error');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(tokenAnswer(new Date(Date.now() + 90 * 86_400_000), new Date(Date.now() + 365 * 86_400_000)))));
      expect((await callback(`code=real&state=${state}`)).headers.location).toBe('/admin/invoices?efactura=ok');
      expect((await callback(`code=real&state=${state}`)).headers.location).toBe('/admin/invoices?efactura=error');
      const status = (await app.inject({ method: 'GET', url: '/api/admin/efactura', headers: { cookie: await as(ADMIN) } })).json();
      expect(status).toMatchObject({ authorised: true, refreshDue: false });
    });

    it('serve an invoice’s PDF at the link the account asked for, for ten minutes, and to no one without it', async () => {
      const { efacturaFromSettings } = await import('../billing/invoicing/queue.js');
      const efactura = efacturaFromSettings()!;
      await efactura.issuer.issue({ id: 'cs_route_pdf', paidAt: '2026-11-16T09:00:00.000Z', currency: 'RON', sendEmail: false, buyer: { name: 'Ion', email: 'i@spine.test', country: 'RO', city: 'Cluj', region: 'CJ', address: 'Str. 1' }, lines: [{ name: 'Plan', amountMinor: 4900, quantity: 1, vatPercent: 0 }] });
      const link = new URL(await efactura.issuer.pdfUrl({ id: 'cs_route_pdf' }));
      expect(link.origin).toBe('https://spine.test');
      const noNetwork = vi.fn(async () => { throw new Error('no network'); });
      vi.stubGlobal('fetch', noNetwork);
      const ok = await app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toBe('application/pdf');
      expect(ok.headers['cache-control']).toContain('no-store');
      expect(ok.body.startsWith('%PDF')).toBe(true);
      expect(noNetwork).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'GET', url: link.pathname })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `${link.pathname}?t=1.forged` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `${link.pathname.replace('cs_route_pdf', 'cs_other')}${link.search}` })).statusCode).toBe(404);
    });
  });

  describe('the helpers', () => {
    it('seal text so that it opens with the key and with nothing else, and read a zip that Java or Node made', async () => {
      const sealed = sealText(KEY, 'secret');
      expect(sealed).not.toContain('secret');
      expect(openText(KEY, sealed)).toBe('secret');
      expect(() => openText(KEY, `${sealed.slice(0, -2)}AA`)).toThrow();
      expect(() => sealText(Buffer.alloc(16), 'x')).toThrow(/32 bytes/);
      expect([...readZip(await zipOf({ 'a.xml': '<a/>'.repeat(100), 'b.xml': 'b' })).values()].map(b => b.length)).toEqual([400, 1]);
      expect(() => readZip(Buffer.from('not a zip at all, not even close to one'))).toThrow(/not a zip/);
    });

    it('sign a link to a PDF that lasts ten minutes and is for one document', () => {
      const token = signedLink(KEY, 'inv_1', T0);
      expect(linkIsValid(KEY, 'inv_1', token, new Date(T0.getTime() + 9 * 60_000))).toBe(true);
      expect(linkIsValid(KEY, 'inv_1', token, new Date(T0.getTime() + 11 * 60_000))).toBe(false);
      expect(linkIsValid(KEY, 'inv_2', token, T0)).toBe(false);
      expect(linkIsValid(Buffer.alloc(32, 9), 'inv_1', token, T0)).toBe(false);
    });
  });

  describe('the settings', () => {
    const problemsWith = (over: Record<string, string | undefined>) => {
      const env = { ...process.env, ...ENV, ...over } as NodeJS.ProcessEnv;
      try { loadInvoicingConfig(loadBillingConfig(env), env); return ''; } catch (err) { return (err as Error).message; }
    };
    it('carry the mention for no VAT ("Scutit de TVA conform art. 310 din Codul fiscal") unless it is turned off or worded otherwise', () => {
      const note = (over: Record<string, string | undefined> = {}) => {
        const env = { ...process.env, ...ENV, ...over } as NodeJS.ProcessEnv;
        const config = loadInvoicingConfig(loadBillingConfig(env), env);
        return config.enabled && config.issuer === 'efactura' ? config.direct.zeroVat.note : 'not efactura';
      };
      expect(note()).toBe('Scutit de TVA conform art. 310 din Codul fiscal');
      expect(note({ SPINE_INVOICING_VAT_NOTE: 'Scutit de TVA' })).toBe('Scutit de TVA');
      expect(note({ SPINE_INVOICING_VAT_NOTE: 'off' })).toBeUndefined();
    });

    it('are read whole, with the sealing key checked before the process starts', () => {
      expect(problemsWith({})).toBe('');
      const config = loadInvoicingConfig(loadBillingConfig(), process.env);
      expect(config).toMatchObject({ enabled: true, issuer: 'efactura', efactura: true, direct: { mode: 'test', series: 'SPN', publicUrl: 'https://spine.test', zeroVat: { category: 'O' } } });
      expect(problemsWith({ SPINE_EFACTURA_KEY: Buffer.alloc(8).toString('base64') })).toContain('32 random bytes');
      expect(problemsWith({ SPINE_EFACTURA_REDIRECT_URI: 'http://spine.test/cb' })).toContain('https');
      expect(problemsWith({ SPINE_EFACTURA_MODE: 'live' })).toContain('test or prod');
      expect(problemsWith({ ANAF_CLIENT_ID: undefined, ANAF_CLIENT_SECRET: undefined })).toMatch(/ANAF_CLIENT_ID[\s\S]*ANAF_CLIENT_SECRET/);
    });
  });
});
