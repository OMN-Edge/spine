import { describe, it, expect } from 'vitest';
import { InvoiceError, type InvoiceDraft } from 'spine-billing/invoicing/issuer.js';
import { billyouIssuer, invoiceBody, type BillyouSettings } from 'spine-billing/invoicing/billyou.js';
import { scripted } from './helpers/scripted-fetch.js';

/** The Billyou adapter: what it asks from what a payment says, and what it does with the answers. The shapes are those a sandbox account answered on 2026-11-15. */
const draft: InvoiceDraft = {
  id: 'pi_3Test',
  paidAt: '2026-11-15T10:20:30.000Z',
  currency: 'eur',
  buyer: { name: 'Eva Test', email: 'eva@spine.test', country: 'fr', city: 'Paris', region: 'Ile-de-France' },
  lines: [{ name: 'Spine Premium, yearly', amountMinor: 5929, quantity: 1, vatPercent: 21 }],
  sendEmail: true,
};
const settings = (fetcher: typeof fetch, over: Partial<BillyouSettings> = {}): BillyouSettings => ({ apiKey: 'not-a-real-key', seriesId: 's_1', exchangeRate: async () => 4.9772, fetcher, ...over });
const NO_CLIENTS = { body: { success: true, data: [] } };
const MADE_CLIENT = { body: { success: true, data: { _id: 'c_1' } } };
const MADE_INVOICE = { body: { success: true, data: { invoiceId: 'i_1', serialNumber: 'SPN-00042', isDraft: false } } };
const NO_PAYMENTS = { body: { success: true, data: { data: [] } } };
const RECORDED = { body: { success: true, data: { paymentStatus: 'paid' } } };
const MAILED = { body: { success: true, data: { shareLink: 'https://app.billyou.test/i/abc' } } };

describe('the invoice Billyou is asked for', () => {
  it('takes the VAT out of what the buyer paid, since Billyou’s unit price is without it, and keeps the total at the cent that was paid', () => {
    const body = invoiceBody(settings(fetch), draft, 'c_1', 4.9772) as Record<string, any>;
    expect(body).toMatchObject({ clientId: 'c_1', seriesId: 's_1', issueDate: '2026-11-15', currency: 'EUR', exchangeRate: 4.9772, notes: 'Plata pi_3Test' });
    expect(body.services[0]).toMatchObject({ description: 'Spine Premium, yearly', quantity: 1, unitPrice: 49, vatRate: 21, unitOfMeasure: 'buc' });
    const two = invoiceBody(settings(fetch), { ...draft, lines: [{ name: 'Top-up', amountMinor: 3999, quantity: 2, vatPercent: 0 }] }, 'c_1') as Record<string, any>;
    expect(two.services[0]).toMatchObject({ unitPrice: 19.995, quantity: 2, vatRate: 0 });
    expect(two).not.toHaveProperty('exchangeRate');
  });

  it('classes a 0% line the way the operator said, and only a 0% line', () => {
    const settled = settings(fetch, { zeroVat: { taxCategory: 'O' } });
    const none = invoiceBody(settled, { ...draft, lines: [{ name: 'Top-up', amountMinor: 1000, quantity: 1, vatPercent: 0 }] }, 'c_1', 1) as Record<string, any>;
    expect(none.services[0].taxCategory).toBe('O');
    expect((invoiceBody(settled, draft, 'c_1', 1) as Record<string, any>).services[0]).not.toHaveProperty('taxCategory');
  });

  it('cuts a name at the hundred characters ANAF allows', () => {
    const long = invoiceBody(settings(fetch), { ...draft, lines: [{ ...draft.lines[0]!, name: 'x'.repeat(150) }] }, 'c_1', 1) as Record<string, any>;
    expect(long.services[0].description).toHaveLength(100);
  });
});

describe('the Billyou issuer', () => {
  it('finds no client, makes one for the buyer (tax id "-" for a person abroad), issues under the payment’s id, and says which invoice it made', async () => {
    const { calls, fetcher } = scripted([NO_CLIENTS, MADE_CLIENT, MADE_INVOICE, NO_PAYMENTS, RECORDED, MAILED]);
    const issuer = billyouIssuer(settings(fetcher));
    expect(await issuer.issue(draft)).toEqual({ id: 'i_1', series: 'SPN', number: '00042', link: 'https://app.billyou.test/i/abc' });
    expect(calls.map(c => `${c.init.method} ${c.url.replace('https://app.billyou.ro/api', '')}`)).toEqual(['GET /clients?search=eva%40spine.test', 'POST /clients', 'POST /invoices', 'GET /invoices/i_1/payments', 'POST /invoices/i_1/payments', 'POST /invoices/i_1/email']);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ name: 'Eva Test', taxId: '-', address: { city: 'Paris', county: 'Ile-de-France', country: 'FR' }, contactEmails: ['eva@spine.test'] });
    const headers = calls[2]!.init.headers as Record<string, string>;
    expect(headers).toMatchObject({ 'x-api-key': 'not-a-real-key', 'idempotency-key': 'pi_3Test' });
    expect(JSON.parse(String(calls[5]!.init.body))).toMatchObject({ to: 'eva@spine.test', addToContacts: true });
    expect(issuer.repeatSafe).toBe(true);
  });

  it('uses the client that already has the same email, name and tax id, and not the others a search brings back', async () => {
    const hit = (extra: object) => ({ _id: 'c_7', name: 'eva test', taxId: '-', contactEmails: [{ email: 'EVA@spine.test' }], ...extra });
    const same = scripted([{ body: { success: true, data: [{ _id: 'c_0', name: 'Ana Test', taxId: '1', contactEmails: [] }, hit({})] } }, MADE_INVOICE, NO_PAYMENTS, RECORDED]);
    await billyouIssuer(settings(same.fetcher)).issue({ ...draft, sendEmail: false });
    expect(same.calls).toHaveLength(4);
    expect(JSON.parse(String(same.calls[1]!.init.body)).clientId).toBe('c_7');
    const other = scripted([{ body: { success: true, data: [hit({ taxId: 'DE123' })] } }, MADE_CLIENT, MADE_INVOICE, NO_PAYMENTS, RECORDED]);
    await billyouIssuer(settings(other.fetcher)).issue({ ...draft, sendEmail: false });
    expect(other.calls[1]!.init.method).toBe('POST');
  });

  it('uses the client that holds a company’s tax id although its name and contact differ, since Billyou refuses a second client under one tax id', async () => {
    const held = scripted([{ body: { success: true, data: [{ _id: 'c_9', name: 'Beispiel GmbH', taxId: 'DE 987654321', contactEmails: [{ email: 'old@spine.test' }] }] } }, MADE_INVOICE, NO_PAYMENTS, RECORDED]);
    await billyouIssuer(settings(held.fetcher)).issue({ ...draft, sendEmail: false, buyer: { ...draft.buyer, name: 'Beispiel Gesellschaft', country: 'de', taxId: 'de987654321' } });
    expect(held.calls).toHaveLength(4);
    expect(JSON.parse(String(held.calls[1]!.init.body)).clientId).toBe('c_9');
  });

  it('gives a company’s tax id to the client, and asks for no mail where none was asked for', async () => {
    const { calls, fetcher } = scripted([NO_CLIENTS, MADE_CLIENT, MADE_INVOICE, NO_PAYMENTS, RECORDED]);
    await billyouIssuer(settings(fetcher)).issue({ ...draft, sendEmail: false, buyer: { ...draft.buyer, taxId: 'DE123456789' } });
    expect(JSON.parse(String(calls[1]!.init.body)).taxId).toBe('DE123456789');
    expect(calls).toHaveLength(5);
  });

  it('gives a Romanian person who gave no CNP thirteen zeros as the tax id, which Billyou takes, and leaves a tax id that was given alone', async () => {
    const ro = scripted([NO_CLIENTS, MADE_CLIENT, MADE_INVOICE, NO_PAYMENTS, RECORDED]);
    await billyouIssuer(settings(ro.fetcher)).issue({ ...draft, sendEmail: false, buyer: { ...draft.buyer, country: 'ro', region: 'Cluj' } });
    expect(JSON.parse(String(ro.calls[1]!.init.body))).toMatchObject({ taxId: '0000000000000', address: { country: 'RO', county: 'Cluj' } });
    const company = scripted([NO_CLIENTS, MADE_CLIENT, MADE_INVOICE, NO_PAYMENTS, RECORDED]);
    await billyouIssuer(settings(company.fetcher)).issue({ ...draft, sendEmail: false, buyer: { ...draft.buyer, country: 'ro', taxId: 'RO123' } });
    expect(JSON.parse(String(company.calls[1]!.init.body)).taxId).toBe('RO123');
  });

  it('records what the buyer paid on the invoice, in the currency paid, under the payment’s reference, and not twice', async () => {
    const { calls, fetcher } = scripted([NO_CLIENTS, MADE_CLIENT, MADE_INVOICE, NO_PAYMENTS, RECORDED]);
    await billyouIssuer(settings(fetcher)).issue({ ...draft, sendEmail: false });
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({ amount: 59.29, paymentDate: '2026-11-15T10:20:30.000Z', paymentMethod: 'card', currency: 'EUR', exchangeRate: 4.9772, reference: 'pi_3Test' });
    // The attempt is repeated after the payment was recorded but the answer was lost: the invoice is the same one (the key) and its payment is found by the reference.
    const again = scripted([NO_CLIENTS, MADE_CLIENT, MADE_INVOICE, { body: { success: true, data: { data: [{ reference: 'pi_3Test' }] } } }]);
    await billyouIssuer(settings(again.fetcher)).issue({ ...draft, sendEmail: false });
    expect(again.calls.map(c => c.init.method)).toEqual(['GET', 'POST', 'POST', 'GET']);
  });

  it('is told to repeat the attempt when the payment could not be recorded, rather than leaving an invoice that shows as unpaid', async () => {
    const err = await billyouIssuer(settings(scripted([NO_CLIENTS, MADE_CLIENT, MADE_INVOICE, NO_PAYMENTS, { status: 503, body: { success: false } }]).fetcher)).issue({ ...draft, sendEmail: false }).catch(e => e);
    expect(err).toBeInstanceOf(InvoiceError);
    expect(err).toMatchObject({ retry: true, status: 503 });
  });

  it('dates an invoice and its payment no later than now, since Billyou refuses a date after today', async () => {
    const { calls, fetcher } = scripted([NO_CLIENTS, MADE_CLIENT, MADE_INVOICE, NO_PAYMENTS, RECORDED]);
    const before = Date.now();
    await billyouIssuer(settings(fetcher)).issue({ ...draft, sendEmail: false, paidAt: '2099-01-01T00:00:00.000Z' });
    const issueDate = JSON.parse(String(calls[2]!.init.body)).issueDate as string;
    expect(Date.parse(issueDate)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(issueDate)).toBeGreaterThan(before - 2 * 86_400_000);
    expect(Date.parse(JSON.parse(String(calls[4]!.init.body)).paymentDate)).toBeLessThanOrEqual(Date.now());
  });

  it('keeps the invoice when its mail fails, with no link', async () => {
    const issued = await billyouIssuer(settings(scripted([NO_CLIENTS, MADE_CLIENT, MADE_INVOICE, NO_PAYMENTS, RECORDED, { status: 500, body: {} }]).fetcher)).issue(draft);
    expect(issued).toMatchObject({ id: 'i_1', link: null });
  });

  it('refuses an invoice in another currency than RON when it has no rate for the day, rather than guessing one', async () => {
    const err = await billyouIssuer(settings(scripted([]).fetcher, { exchangeRate: undefined })).issue(draft).catch(e => e);
    expect(err).toBeInstanceOf(InvoiceError);
    expect(err).toMatchObject({ retry: false });
  });

  it('says a refused draft is not to be tried again, and a limit, a fault of Billyou’s or no answer is', async () => {
    const refused = await billyouIssuer(settings(scripted([NO_CLIENTS, { status: 400, body: { success: false, errorCode: 'REGISTRY_INVALID_TAX_ID', message: 'Invalid Romanian tax ID' } }]).fetcher)).issue(draft).catch(e => e);
    expect(refused).toMatchObject({ retry: false, status: 400 });
    expect(refused.message).toContain('REGISTRY_INVALID_TAX_ID');
    for (const status of [429, 503]) {
      const err = await billyouIssuer(settings(scripted([{ status, body: { success: false, errorCode: 'RATE_LIMIT_EXCEEDED' } }]).fetcher)).issue(draft).catch(e => e);
      expect(err, String(status)).toMatchObject({ retry: true, status });
    }
    const down = await billyouIssuer(settings(scripted([new Error('ECONNRESET')]).fetcher)).issue(draft).catch(e => e);
    expect(down).toMatchObject({ retry: true, status: null });
  });

  it('refuses an answer with no invoice, rather than recording one', async () => {
    const err = await billyouIssuer(settings(scripted([NO_CLIENTS, MADE_CLIENT, { body: { success: true, data: {} } }]).fetcher)).issue(draft).catch(e => e);
    expect(err).toMatchObject({ retry: false });
  });

  it('waits, and does not give up, when the connection to ANAF has ended, since the operator renews it and the invoice then goes through', async () => {
    const err = await billyouIssuer(settings(scripted([{ status: 401, body: { success: false, errorCode: 'SPV_TOKEN_UNAUTHORIZED', message: 'SPV authorization missing or expired' } }]).fetcher)).sendToAnaf({ id: 'i_1', series: 'SPN', number: '00042' }).catch(e => e);
    expect(err).toBeInstanceOf(InvoiceError);
    expect(err).toMatchObject({ retry: true, status: 401 });
    expect(err.message).toContain('SPV_TOKEN_UNAUTHORIZED');
    // Any other 401 (a key that is wrong) is not going to pass.
    const wrong = await billyouIssuer(settings(scripted([{ status: 401, body: { success: false, errorCode: 'UNAUTHORIZED' } }]).fetcher)).issue(draft).catch(e => e);
    expect(wrong).toMatchObject({ retry: false });
  });

  it('gives the address of an invoice’s PDF, which does not last, and refuses an answer with none', async () => {
    const { calls, fetcher } = scripted([{ body: { success: true, data: { downloadUrl: 'https://files.example/a.pdf?sig=1', expiresIn: 600, filename: 'factura.pdf' } } }]);
    expect(await billyouIssuer(settings(fetcher)).pdfUrl({ id: 'i_1' })).toBe('https://files.example/a.pdf?sig=1');
    expect(calls[0]!.url).toBe('https://app.billyou.ro/api/invoices/i_1/pdf');
    for (const data of [{}, { downloadUrl: 'http://insecure.example/a.pdf' }]) {
      const err = await billyouIssuer(settings(scripted([{ body: { success: true, data } }]).fetcher)).pdfUrl({ id: 'i_1' }).catch(e => e);
      expect(err).toMatchObject({ retry: false });
    }
  });

  it('reverses an invoice with a storno, and says it is done where Billyou says it was reversed already', async () => {
    const { calls, fetcher } = scripted([{ status: 201, body: { success: true, data: { invoiceId: 'i_storno', serialNumber: 'SPN-00043', originalInvoiceId: 'i_1', isDraft: false } } }]);
    expect(await billyouIssuer(settings(fetcher)).reverse({ id: 'i_1', series: 'SPN', number: '00042' }, 'Rambursare')).toEqual({ id: 'i_storno', series: 'SPN', number: '00043', link: null });
    expect(calls[0]!.url).toBe('https://app.billyou.ro/api/invoices/i_1/storno');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ reason: 'Rambursare' });
    const twice = scripted([{ status: 409, body: { success: false, message: 'This invoice has already been reversed.' } }]);
    expect(await billyouIssuer(settings(twice.fetcher)).reverse({ id: 'i_1', series: 'SPN', number: '00042' }, 'x')).toBeNull();
    const down = await billyouIssuer(settings(scripted([{ status: 503, body: {} }]).fetcher)).reverse({ id: 'i_1', series: 'SPN', number: '00042' }, 'x').catch(e => e);
    expect(down).toMatchObject({ retry: true, status: 503 });
  });

  const INVOICE = { id: 'i_1', series: 'SPN', number: '00042' };
  const NOT_SUBMITTED = { status: 404, body: { success: false, errorCode: 'SUBMISSION_NOT_FOUND', message: 'Submission not found' } };
  const submission = (data: object) => ({ body: { success: true, data } });

  it('reads the submission before it submits, submits an invoice nothing was submitted for, and says what the sandbox’s mock answers at once', async () => {
    const { calls, fetcher } = scripted([NOT_SUBMITTED, submission({ status: 'rejected', validationErrors: [{ message: 'no street' }] })]);
    expect(await billyouIssuer(settings(fetcher)).sendToAnaf(INVOICE)).toEqual({ sent: false, code: 2, text: 'no street' });
    expect(calls.map(c => `${c.init.method} ${c.url.replace('https://app.billyou.ro/api', '')}`)).toEqual(['GET /efactura/submissions/i_1', 'POST /invoices/i_1/efactura/submissions']);
  });

  it('says ANAF is still deciding while it is, and does not submit a second time', async () => {
    for (const status of ['pending', 'processing', 'uploaded']) {
      const { calls, fetcher } = scripted([submission({ status })]);
      expect(await billyouIssuer(settings(fetcher)).sendToAnaf(INVOICE), status).toMatchObject({ sent: true, code: 0 });
      expect(calls, status).toHaveLength(1);
    }
    expect(await billyouIssuer(settings(scripted([NOT_SUBMITTED, submission({ status: 'processing' })]).fetcher)).sendToAnaf(INVOICE)).toMatchObject({ code: 0 });
  });

  it('says accepted when ANAF validated it, and refused, with ANAF’s reason and the fix, when it rejected it', async () => {
    expect(await billyouIssuer(settings(scripted([submission({ status: 'validated', uploadIndex: '5025641742' })]).fetcher)).sendToAnaf(INVOICE)).toMatchObject({ sent: true, code: 1 });
    const rejected = await billyouIssuer(settings(scripted([submission({ status: 'rejected', error: { message: 'E: [BR-RO-100] sector', details: { translatedErrors: [{ titleEn: 'Sector missing', fixEn: 'Add the sector' }] } } })]).fetcher)).sendToAnaf(INVOICE);
    expect(rejected).toEqual({ sent: false, code: 2, text: 'E: [BR-RO-100] sector; Add the sector' });
  });

  it('asks for the upload again where ANAF had a fault, and waits where only a day or the operator can mend it', async () => {
    const failed = (errorCode: string) => submission({ status: 'failed', error: { message: 'x', details: { errorCode } } });
    const again = scripted([failed('ANAF_TEMPORARY_ERROR'), { status: 202, body: { success: true, data: { status: 'processing' } } }]);
    expect(await billyouIssuer(settings(again.fetcher)).sendToAnaf(INVOICE)).toMatchObject({ sent: true, code: 0 });
    expect(again.calls[1]!.url).toBe('https://app.billyou.ro/api/efactura/submissions/i_1/retry');
    for (const code of ['ANAF_DAILY_LIMIT', 'SPV_TOKEN_UNAUTHORIZED', 'ANAF_NO_SPV_RIGHTS']) {
      const err = await billyouIssuer(settings(scripted([failed(code)]).fetcher)).sendToAnaf(INVOICE).catch(e => e);
      expect(err, code).toBeInstanceOf(InvoiceError);
      expect(err, code).toMatchObject({ retry: true });
    }
    expect(await billyouIssuer(settings(scripted([failed('ANAF_DUPLICATE_UPLOAD')]).fetcher)).sendToAnaf(INVOICE)).toMatchObject({ sent: true, code: 1 });
    expect(await billyouIssuer(settings(scripted([failed('INVOICE_CANCELED')]).fetcher)).sendToAnaf(INVOICE)).toMatchObject({ sent: false, code: 2, text: expect.stringContaining('INVOICE_CANCELED') });
  });

  it('does not call a buyer abroad a failure, and refuses what it cannot tell', async () => {
    expect(await billyouIssuer(settings(scripted([NOT_SUBMITTED, { status: 400, body: { success: false, errorCode: 'NON_ROMANIAN_CLIENT', message: 'Only Romanian' } }]).fetcher)).sendToAnaf(INVOICE)).toMatchObject({ sent: false, code: -1 });
    await expect(billyouIssuer(settings(scripted([{ status: 403, body: { success: false, errorCode: 'FORBIDDEN', message: 'no' } }]).fetcher)).sendToAnaf(INVOICE)).rejects.toMatchObject({ retry: false });
  });
});
