import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getAccountsStore } from 'spine-core/store/index.js';
import { draftOf, MAX_ATTEMPTS, processInvoice, reverseRefunded, type InvoicingContext } from '../billing/invoicing/queue.js';
import { InvoiceError, type InvoiceDraft, type InvoiceIssuer, type IssuedInvoice } from 'spine-billing/invoicing/issuer.js';
import type { Sale } from '../billing/provider.js';
import { buildTestApp } from './helpers/app.js';

/** The queue of invoices the operator owes (`billing/invoicing/queue.ts`): what is done with a payment, and what a failure of the service does and does not lose. */
const SALE: Sale = { paidAt: '2026-11-15T10:00:00.000Z', currency: 'EUR', buyer: { name: 'Eva Test', email: 'eva@spine.test', country: 'FR' }, lines: [{ name: 'Spine Premium', amountMinor: 4900, quantity: 1 }] };
const CONFIG = { enabled: true as const, issuer: 'billyou' as const, vatPercent: 21, efactura: false, mail: true, billyou: { apiKey: 'k', seriesId: 's', zeroVat: null } };

interface Fake { issuer: InvoiceIssuer; drafts: InvoiceDraft[]; sent: number; reversed: string[] }
/** An issuer that answers from a script: each call to `issue` takes the next answer, an `Error` being thrown. */
function fake(answers: Array<IssuedInvoice | Error>, over: { repeatSafe?: boolean; anaf?: Array<{ sent: boolean; code: number; text: string } | Error>; reverse?: Array<IssuedInvoice | null | Error> } = {}): Fake {
  const out: Fake = { drafts: [], sent: 0, reversed: [], issuer: undefined as never };
  out.issuer = {
    id: 'fake', repeatSafe: over.repeatSafe ?? true,
    async issue(draft) { out.drafts.push(draft); const next = answers.shift(); if (!next) throw new Error('unexpected call'); if (next instanceof Error) throw next; return next; },
    async pdfUrl() { return 'https://pdf.example/x.pdf'; },
    async reverse(invoice) { out.reversed.push(invoice.id); const next = over.reverse?.shift(); if (next === undefined) throw new Error('unexpected reverse'); if (next instanceof Error) throw next; return next; },
    async sendToAnaf() { out.sent++; const next = over.anaf?.shift() ?? { sent: true, code: 1, text: '' }; if (next instanceof Error) throw next; return next; },
  };
  return out;
}
const MADE: IssuedInvoice = { id: 'inv_1', series: 'SPN', number: '00001', link: null };
const ctx = (f: Fake, at: string, over: Partial<InvoicingContext> = {}, config: Partial<typeof CONFIG> = {}): InvoicingContext => ({ issuer: f.issuer, config: { ...CONFIG, ...config }, readSale: async () => SALE, now: () => new Date(at), ...over });
const T0 = '2026-11-15T12:00:00.000Z';
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
let n = 0;
const queued = async (at = T0) => { const ref = `cs_queue_${++n}`; expect(await getAccountsStore().billing.queueInvoice(ref, null, at)).toBe(true); return ref; };

describe('the queue of invoices', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-invoices-'));
  beforeAll(async () => { process.env.DATA_DIR = dir; app = await buildTestApp(); });
  afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const row = (ref: string) => getAccountsStore().billing.invoice(ref);

  it('takes a payment once, whatever the account, however many times it is told', async () => {
    const store = getAccountsStore();
    expect(await store.billing.queueInvoice('cs_twice', 'user-gone', T0)).toBe(true);
    expect(await store.billing.queueInvoice('cs_twice', 'user-gone', plus(T0, 1000))).toBe(false);
    expect(await row('cs_twice')).toMatchObject({ state: 'pending', attempts: 0, user_id: 'user-gone', issuer_ref: null });
  });

  it('issues the invoice from the sale and the operator’s VAT, under the payment’s reference, and records only its number', async () => {
    const f = fake([MADE]);
    const ref = await queued();
    expect(await processInvoice(ref, ctx(f, T0))).toBe('done');
    expect(f.drafts).toEqual([{ ...draftOf(ref, SALE, CONFIG), id: ref }]);
    expect(f.drafts[0]).toMatchObject({ id: ref, currency: 'EUR', sendEmail: true, lines: [{ name: 'Spine Premium', amountMinor: 4900, quantity: 1, vatPercent: 21 }] });
    expect(await row(ref)).toMatchObject({ state: 'done', issuer_ref: 'inv_1', series: 'SPN', number: '00001', last_error: null });
    expect(Object.keys((await row(ref))!).join()).not.toMatch(/name|email|address|amount/);
    // Done is done: asked again, nothing is issued.
    expect(await processInvoice(ref, ctx(f, plus(T0, 60_000)))).toBe('done');
    expect(f.drafts).toHaveLength(1);
  });

  it('sends it to e-Factura when the operator asked, and says so when ANAF refuses it', async () => {
    const ok = fake([MADE], { anaf: [{ sent: true, code: 1, text: 'validated' }] });
    const a = await queued();
    expect(await processInvoice(a, ctx(ok, T0, {}, { efactura: true }))).toBe('done');
    expect(ok.sent).toBe(1);

    const refused = fake([MADE], { anaf: [{ sent: false, code: 2, text: 'no street' }] });
    const b = await queued();
    expect(await processInvoice(b, ctx(refused, T0, {}, { efactura: true }))).toBe('failed');
    expect(await row(b)).toMatchObject({ state: 'failed', issuer_ref: 'inv_1', last_error: 'e-Factura refused it: no street' });

    const abroad = fake([MADE], { anaf: [{ sent: false, code: -1, text: 'not required: the buyer is not Romanian' }] });
    const c = await queued();
    expect(await processInvoice(c, ctx(abroad, T0, {}, { efactura: true }))).toBe('done');
    expect((await row(c))!.last_error).toContain('not required');
  });

  it('keeps asking ANAF while it is deciding, every few minutes, without making the invoice again, and is done when it says yes', async () => {
    const f = fake([MADE], { anaf: [{ sent: true, code: 0, text: 'processing' }, { sent: true, code: 0, text: 'processing' }, { sent: true, code: 1, text: '' }] });
    const ref = await queued();
    const c = (at: string) => ctx(f, at, {}, { efactura: true });
    expect(await processInvoice(ref, c(T0))).toBe('issued');
    const first = (await row(ref))!;
    expect(Date.parse(first.next_attempt_at) - Date.parse(T0)).toBe(5 * 60_000);
    // Too early: ANAF is not asked.
    expect(await processInvoice(ref, c(plus(T0, 60_000)))).toBe('issued');
    expect(f.sent).toBe(1);
    expect(await processInvoice(ref, c(plus(T0, 5 * 60_000)))).toBe('issued');
    expect(await processInvoice(ref, c(plus(T0, 10 * 60_000)))).toBe('done');
    expect(f.drafts).toHaveLength(1);
    expect(f.sent).toBe(3);
  });

  it('leaves it to the operator when ANAF is still deciding after a day', async () => {
    const f = fake([MADE], { anaf: Array.from({ length: 300 }, () => ({ sent: true, code: 0, text: 'processing' })) });
    const ref = await queued();
    let at = T0;
    let state: string | null = 'pending';
    for (let i = 0; i < 300 && (state === 'pending' || state === 'issued'); i++) { state = await processInvoice(ref, ctx(f, at, {}, { efactura: true })); at = plus(at, 5 * 60_000); }
    expect(state).toBe('check');
    expect((await row(ref))!.last_error).toContain('still deciding');
  });

  it('does not issue the invoice again when only the e-Factura step has to be tried again', async () => {
    const f = fake([MADE], { anaf: [new InvoiceError('ANAF is down', true, 503), { sent: true, code: 1, text: '' }] });
    const ref = await queued();
    expect(await processInvoice(ref, ctx(f, T0, {}, { efactura: true }))).toBe('issued');
    expect(await row(ref)).toMatchObject({ state: 'issued', attempts: 1, issuer_ref: 'inv_1' });
    expect(await processInvoice(ref, ctx(f, plus(T0, 3 * 60_000), {}, { efactura: true }))).toBe('done');
    expect(f.drafts).toHaveLength(1);
    expect(f.sent).toBe(2);
  });

  it('tries again later after a failure that may pass, with longer waits, and not before its time', async () => {
    const f = fake([new InvoiceError('limit', true, 429), new InvoiceError('limit', true, 429), MADE]);
    const ref = await queued();
    expect(await processInvoice(ref, ctx(f, T0))).toBe('pending');
    const first = (await row(ref))!;
    expect(first).toMatchObject({ attempts: 1, last_error: 'limit' });
    expect(Date.parse(first.next_attempt_at) - Date.parse(T0)).toBe(2 * 60_000);
    // Too early: nothing is asked of the service.
    expect(await processInvoice(ref, ctx(f, plus(T0, 60_000)))).toBe('pending');
    expect(f.drafts).toHaveLength(1);
    expect(await processInvoice(ref, ctx(f, plus(T0, 2 * 60_000)))).toBe('pending');
    expect(Date.parse((await row(ref))!.next_attempt_at) - Date.parse(plus(T0, 2 * 60_000))).toBe(4 * 60_000);
    expect(await processInvoice(ref, ctx(f, plus(T0, 6 * 60_000)))).toBe('done');
  });

  it('lists what is due, oldest first, and not what waits or is over', async () => {
    const store = getAccountsStore();
    const early = await queued('2026-11-15T11:00:00.000Z');
    const later = await queued('2026-11-15T11:30:00.000Z');
    const waiting = await queued(plus(T0, 3_600_000));
    const due = (await store.billing.invoicesDue(T0, 100)).map(r => r.ref);
    expect(due.indexOf(early)).toBeLessThan(due.indexOf(later));
    expect(due).not.toContain(waiting);
    expect(await store.billing.invoicesDue(T0, 1)).toHaveLength(1);
  });

  it('leaves a refused invoice to the operator, at once, and says why', async () => {
    const f = fake([new InvoiceError('Billyou answered 400 REGISTRY_INVALID_TAX_ID: Invalid Romanian tax ID', false, 400)]);
    const ref = await queued();
    expect(await processInvoice(ref, ctx(f, T0))).toBe('failed');
    expect(await row(ref)).toMatchObject({ state: 'failed', attempts: 1, last_error: expect.stringContaining('REGISTRY_INVALID_TAX_ID') });
    expect((await getAccountsStore().billing.invoicesDue(plus(T0, 99 * 3_600_000), 1000)).map(r => r.ref)).not.toContain(ref);
  });

  it('does not repeat an attempt that had no answer at a service that cannot tell a repeat from a new invoice, and does at one that can', async () => {
    const unsure = fake([new InvoiceError('could not be reached', true, null)], { repeatSafe: false });
    const a = await queued();
    expect(await processInvoice(a, ctx(unsure, T0))).toBe('check');
    expect(await processInvoice(a, ctx(unsure, plus(T0, 99 * 3_600_000)))).toBe('check');
    expect(unsure.drafts).toHaveLength(1);
    // A limit says the service did nothing, so a repeat is safe there too.
    const limited = fake([new InvoiceError('limit', true, 429), MADE], { repeatSafe: false });
    const b = await queued();
    expect(await processInvoice(b, ctx(limited, T0))).toBe('pending');
    // A service that replays the first invoice for a repeated payment may be asked again after no answer.
    const safe = fake([new InvoiceError('could not be reached', true, null)], { repeatSafe: true });
    const c = await queued();
    expect(await processInvoice(c, ctx(safe, T0))).toBe('pending');
  });

  it('gives up after the tenth try and says so', async () => {
    const f = fake(Array.from({ length: MAX_ATTEMPTS }, () => new InvoiceError('down', true, 503)));
    const ref = await queued();
    let at = T0;
    let state: string | null = 'pending';
    for (let i = 0; i < MAX_ATTEMPTS && state === 'pending'; i++) {
      state = await processInvoice(ref, ctx(f, at));
      at = plus(at, 7 * 3_600_000);
    }
    expect(state).toBe('failed');
    expect(f.drafts).toHaveLength(MAX_ATTEMPTS);
    expect((await row(ref))!.last_error).toContain(`tried ${MAX_ATTEMPTS} times`);
  });

  it('tries again when the payment provider cannot be read, and issues nothing', async () => {
    const f = fake([MADE]);
    const ref = await queued();
    expect(await processInvoice(ref, ctx(f, T0, { readSale: async () => { throw new Error('the payment provider answered 500'); } }))).toBe('pending');
    expect(f.drafts).toHaveLength(0);
    expect(await row(ref)).toMatchObject({ attempts: 1, last_error: 'the payment provider answered 500' });
  });

  it('knows no payment it was not told of', async () => {
    expect(await processInvoice('cs_unknown', ctx(fake([]), T0))).toBeNull();
  });

  it('reverses the invoice made for a payment with a storno, queued under its own reference with the original’s refs, and records the storno’s number', async () => {
    const original = fake([MADE]);
    const ref = await queued();
    await processInvoice(ref, ctx(original, T0));
    const f = fake([], { reverse: [{ id: 'storno_1', series: 'SPN', number: '00002', link: null }] });
    const storno = `storno:${ref}`;
    const store = getAccountsStore();
    await store.billing.queueInvoice(storno, null, T0);
    await store.billing.updateInvoice(storno, { issuer_ref: 'inv_1', series: 'SPN', number: '00001' }, T0);
    expect(await processInvoice(storno, ctx(f, T0))).toBe('done');
    expect(f.reversed).toEqual(['inv_1']);
    expect(await row(storno)).toMatchObject({ state: 'done', issuer_ref: 'storno_1', number: '00002' });
  });

  it('is done where the service says it was reversed already, and sends a storno to e-Factura when the operator asked', async () => {
    const store = getAccountsStore();
    const again = `storno:cs_again_${++n}`;
    await store.billing.queueInvoice(again, null, T0);
    await store.billing.updateInvoice(again, { issuer_ref: 'inv_1', series: 'SPN', number: '00001' }, T0);
    expect(await processInvoice(again, ctx(fake([], { reverse: [null] }), T0))).toBe('done');
    expect((await row(again))!.last_error).toContain('already');

    const sent = fake([], { reverse: [{ id: 'storno_2', series: 'SPN', number: '00003', link: null }], anaf: [{ sent: true, code: 1, text: '' }] });
    const key = `storno:cs_anaf_${++n}`;
    await store.billing.queueInvoice(key, null, T0);
    await store.billing.updateInvoice(key, { issuer_ref: 'inv_9', series: 'SPN', number: '00009' }, T0);
    expect(await processInvoice(key, ctx(sent, T0, {}, { efactura: true }))).toBe('done');
    expect(sent.sent).toBe(1);
  });

  it('leaves a refund of part of a payment, and of a payment whose invoice is not made, to the operator, with the reason, and a payment never queued alone', async () => {
    const store = getAccountsStore();
    const made = await queued();
    await store.billing.updateInvoice(made, { state: 'done', issuer_ref: 'inv_1', series: 'SPN', number: '00001' }, T0);
    await reverseRefunded([made], false, 're_part', ctx(fake([]), T0));
    expect(await row(`storno:${made}:re_part`)).toMatchObject({ state: 'check', last_error: expect.stringContaining('part of the payment') });
    const notMade = await queued();
    await reverseRefunded([notMade], true, 're_early', ctx(fake([]), T0));
    expect(await row(`storno:${notMade}:re_early`)).toMatchObject({ state: 'check', last_error: expect.stringContaining('before its invoice was made') });
    const reversible = await queued();
    await store.billing.updateInvoice(reversible, { state: 'done', issuer_ref: 'inv_5', series: 'SPN', number: '00005' }, T0);
    const g = fake([], { reverse: [{ id: 'storno_5', series: 'SPN', number: '00006', link: null }] });
    await reverseRefunded(['cs_unknown', reversible], true, 're_full', ctx(g, T0));
    expect(g.reversed).toEqual(['inv_5']);
    expect(await row(`storno:${reversible}`)).toMatchObject({ state: 'done', issuer_ref: 'storno_5', number: '00006' });
    await reverseRefunded(['cs_never_queued'], true, 're_none', ctx(fake([]), T0));
    expect(await row('storno:cs_never_queued')).toBeNull();
    // Told again: the same row, not a second.
    await reverseRefunded([made], false, 're_part', ctx(fake([]), T0));
    expect((await store.billing.invoicesDue('2999-01-01T00:00:00Z', 1000)).filter(r => r.ref.startsWith(`storno:${made}`))).toHaveLength(0);
  });
});
