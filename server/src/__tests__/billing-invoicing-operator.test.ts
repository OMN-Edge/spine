import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getAccountsStore } from 'spine-core/store/index.js';
import { buildTestApp } from './helpers/app.js';

const alerts: Array<{ subject: string; lines: string[] }> = [];
vi.mock('../billing/invoicing/alert.js', () => ({ alertOperator: async (subject: string, lines: string[]) => { alerts.push({ subject, lines }); } }));

const { processInvoice, retryInvoice, settleInvoice } = await import('../billing/invoicing/queue.js');
const { euMinorOf, euSalesTotals, watchEuThreshold, EU_THRESHOLD_MINOR } = await import('spine-billing/invoicing/threshold.js');
const { InvoiceError } = await import('spine-billing/invoicing/issuer.js');
type Ctx = import('../billing/invoicing/queue.js').InvoicingContext;
type Sale = import('../billing/provider.js').Sale;

/** What the operator is told of and can do about invoices, and the EU consumer sales threshold the invoices count toward. */
const sale = (over: Partial<Sale['buyer']> = {}, amountMinor = 4900, currency = 'EUR'): Sale => ({ paidAt: '2026-11-15T10:00:00.000Z', currency, buyer: { name: 'Eva Test', email: 'eva@spine.test', country: 'FR', ...over }, lines: [{ name: 'Spine Premium', amountMinor, quantity: 1 }] });
const CONFIG = { enabled: true as const, issuer: 'billyou' as const, vatPercent: 0, efactura: false, mail: false, billyou: { apiKey: 'k', seriesId: 's', zeroVat: null } };
const T0 = '2026-11-15T12:00:00.000Z';
const issuer = (answers: Array<unknown>) => ({
  id: 'fake', repeatSafe: true,
  async issue() { const a = answers.shift(); if (a instanceof Error) throw a; return a as never; },
  async reverse() { return null; },
  async pdfUrl() { return 'https://pdf.example/x.pdf'; },
  async sendToAnaf() { return { sent: true, code: 1, text: '' }; },
});
const ctx = (answers: unknown[], s: Sale, over: Partial<Ctx> = {}): Ctx => ({ issuer: issuer(answers) as never, config: CONFIG, readSale: async () => s, now: () => new Date(T0), ...over });
let n = 0;

describe('the invoices the operator looks after', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-operator-'));
  beforeAll(async () => { process.env.DATA_DIR = dir; app = await buildTestApp(); });
  afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { alerts.length = 0; });
  const store = () => getAccountsStore();
  const queued = async (at = T0) => { const ref = `cs_op_${++n}`; await store().billing.queueInvoice(ref, null, at); return ref; };

  it('count a sale to a consumer in another EU country, a person with no tax id, and nothing else', async () => {
    expect(await euMinorOf(sale())).toBe(4900);
    expect(await euMinorOf(sale({ country: 'RO' }))).toBeNull();
    expect(await euMinorOf(sale({ country: 'US' }))).toBeNull();
    expect(await euMinorOf(sale({ taxId: 'FR123456789' }))).toBeNull();
    // Another currency is taken to EUR at the bank's rates, and not counted where they cannot be had.
    expect(await euMinorOf(sale({}, 10000, 'RON'), async c => (c === 'EUR' ? 5 : 1))).toBe(2000);
    expect(await euMinorOf(sale({}, 10000, 'RON'), async () => { throw new Error('no rate'); })).toBeNull();
  });

  it('record what an invoice counts for when it is made, and take a refund’s storno off', async () => {
    const ref = await queued();
    await processInvoice(ref, ctx([{ id: 'inv_1', series: 'SPN', number: '1', link: null }], sale()));
    expect(await store().billing.invoice(ref)).toMatchObject({ state: 'done', eu_minor: 4900 });
    const ro = await queued();
    await processInvoice(ro, ctx([{ id: 'inv_2', series: 'SPN', number: '2', link: null }], sale({ country: 'RO' })));
    expect((await store().billing.invoice(ro))!.eu_minor).toBeNull();
    expect(await store().billing.euSalesMinor(2026)).toBeGreaterThanOrEqual(4900);
  });

  it('tell the operator once at 70% and 90% of the threshold and when it is passed, and say how far the year is', async () => {
    const year = 2031;
    const at = (percent: number) => ({ now: new Date(`${year}-06-15T00:00:00Z`), minor: Math.round(EU_THRESHOLD_MINOR * percent / 100) });
    const add = async (minor: number) => { const ref = await queued(`${year}-03-01T00:00:00.000Z`); await store().billing.updateInvoice(ref, { state: 'done', eu_minor: minor }, T0); };
    const now = new Date(`${year}-06-15T00:00:00Z`);
    expect(await watchEuThreshold(store(), now)).toBe(0);
    await add(at(50).minor);
    expect(await watchEuThreshold(store(), now)).toBe(0);
    await add(at(25).minor);
    expect(await watchEuThreshold(store(), now)).toBe(1);
    expect(alerts.at(-1)!.lines.join()).toContain('70%');
    expect(await watchEuThreshold(store(), now)).toBe(0);
    await add(at(20).minor);
    expect(await watchEuThreshold(store(), now)).toBe(1);
    expect(alerts.at(-1)!.lines.join()).toContain('90%');
    await add(at(10).minor);
    expect(await watchEuThreshold(store(), now)).toBe(1);
    expect(alerts.at(-1)!.lines.join()).toContain('passed');
    expect(await watchEuThreshold(store(), now)).toBe(0);
    expect(await euSalesTotals(store(), now)).toMatchObject({ year, thisYear: at(105).minor, limit: EU_THRESHOLD_MINOR });
  });

  it('tell the operator when an invoice is refused, with the reason and no buyer, and remember where it had got to', async () => {
    const ref = await queued();
    expect(await processInvoice(ref, ctx([new InvoiceError('Billyou answered 400 REGISTRY_INVALID_TAX_ID: Invalid tax ID', false, 400)], sale()))).toBe('failed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.subject).toBe('an invoice needs a look');
    expect(alerts[0]!.lines.join('\n')).toContain(ref);
    expect(alerts[0]!.lines.join('\n')).toContain('REGISTRY_INVALID_TAX_ID');
    expect(alerts[0]!.lines.join('\n')).not.toContain('eva@spine.test');
    expect(await store().billing.invoice(ref)).toMatchObject({ state: 'failed', resume: 'pending' });
  });

  it('let the operator retry one that stopped, back where it had got to, and have it go through', async () => {
    const ref = await queued();
    await processInvoice(ref, ctx([new InvoiceError('refused', false, 400)], sale()));
    expect(await retryInvoice(ref, T0)).toEqual({ ok: true });
    expect(await store().billing.invoice(ref)).toMatchObject({ state: 'pending', attempts: 0, last_error: null });
    expect(await processInvoice(ref, ctx([{ id: 'inv_9', series: 'SPN', number: '9', link: null }], sale()))).toBe('done');
    expect(await retryInvoice(ref, T0)).toMatchObject({ ok: false, error: expect.stringContaining('not stopped') });
    expect(await retryInvoice('cs_none', T0)).toMatchObject({ ok: false });
  });

  it('send an invoice that failed at e-Factura back to e-Factura, and not to be made again', async () => {
    const ref = await queued();
    const withAnaf = { ...CONFIG, efactura: true };
    const anaf = (code: number) => ({ ...issuer([{ id: 'inv_3', series: 'SPN', number: '3', link: null }]), async sendToAnaf() { return { sent: false, code, text: 'no street' }; } });
    expect(await processInvoice(ref, { ...ctx([], sale()), issuer: anaf(2) as never, config: withAnaf })).toBe('failed');
    expect(await store().billing.invoice(ref)).toMatchObject({ state: 'failed', resume: 'issued', issuer_ref: 'inv_3' });
    expect(await retryInvoice(ref, T0)).toEqual({ ok: true });
    expect((await store().billing.invoice(ref))!.state).toBe('issued');
  });

  it('let the operator settle one by hand, and refuse to retry a refund there is no invoice to reverse for', async () => {
    const ref = await queued();
    await processInvoice(ref, ctx([new InvoiceError('refused', false, 400)], sale()));
    expect(await settleInvoice(ref, T0)).toEqual({ ok: true });
    expect(await store().billing.invoice(ref)).toMatchObject({ state: 'done', last_error: 'settled by the operator' });
    const storno = `storno:cs_op_x${++n}:re_1`;
    await store().billing.queueInvoice(storno, null, T0);
    await store().billing.updateInvoice(storno, { state: 'check', last_error: 'part of the payment was refunded' }, T0);
    expect(await retryInvoice(storno, T0)).toMatchObject({ ok: false, error: expect.stringContaining('by hand') });
    expect(await settleInvoice(storno, T0)).toEqual({ ok: true });
  });

  it('list what stopped, newest first, and count the invoices in each state', async () => {
    const ref = await queued();
    // Stopped later than any other here, so it is the newest.
    await processInvoice(ref, ctx([new InvoiceError('refused', false, 400)], sale(), { now: () => new Date('2026-12-31T00:00:00Z') }));
    const stopped = await store().billing.invoicesStopped(50);
    expect(stopped[0]!.ref).toBe(ref);
    expect(stopped.every(r => r.state === 'failed' || r.state === 'check')).toBe(true);
    const counts = await store().billing.invoiceCounts();
    expect(Object.keys(counts).sort()).toEqual(['check', 'done', 'failed', 'issued', 'pending']);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
  });
});
