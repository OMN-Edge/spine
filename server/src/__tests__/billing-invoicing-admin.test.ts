import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccountsStore } from 'spine-core/store/index.js';
import { runCli, type CliIo } from '../cli.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';

/** The invoices that stopped, on the admin page and in the CLI: what is shown, who may mend one, and what mending does. */
const ADMIN = 'admin-invoices@spine.test';
const MARKETING = 'marketing-invoices@spine.test';
const T0 = '2026-11-15T12:00:00.000Z';
const io = (): CliIo & { out_: string[]; err_: string[] } => { const out_: string[] = []; const err_: string[] = []; return { out_, err_, out: l => out_.push(l), err: l => err_.push(l), readPassword: async () => '' }; };

describe('the invoices on the admin page and in the CLI', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const store = () => getAccountsStore();
  beforeAll(async () => {
    app = await buildTestApp({ accounts: { registration: 'approval' }, admin: { admins: () => new Set([ADMIN]), readers: () => new Set([ADMIN, MARKETING]) } });
    await createTestUser(ADMIN);
    await createTestUser(MARKETING);
    // One refused, with the service's words and its numbers; one refund left for the operator.
    await store().billing.queueInvoice('cs_stopped_1', null, T0);
    await store().billing.updateInvoice('cs_stopped_1', { state: 'failed', attempts: 1, last_error: 'Billyou answered 400 REGISTRY_INVALID_TAX_ID', resume: 'pending' }, T0);
    await store().billing.queueInvoice('storno:cs_x:re_1', null, T0);
    await store().billing.updateInvoice('storno:cs_x:re_1', { state: 'check', last_error: 'part of the payment was refunded' }, T0);
  });
  afterAll(async () => { await app.close(); });
  const as = async (email: string) => loginAs(app, email, (await import('./helpers/seed.js')).TEST_PASSWORD);

  it('are read by the administrator and the marketing role, and by no one else, as references and the service’s words', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/invoices' })).statusCode).toBe(401);
    const other = await createTestUser('other-invoices@spine.test');
    expect((await app.inject({ method: 'GET', url: '/api/admin/invoices', headers: { cookie: await loginAs(app, other.email, other.password) } })).statusCode).toBe(403);
    const res = await app.inject({ method: 'GET', url: '/api/admin/invoices', headers: { cookie: await as(MARKETING) } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts).toMatchObject({ failed: expect.any(Number), check: expect.any(Number) });
    expect(body.stopped.find((r: { ref: string }) => r.ref === 'cs_stopped_1')).toMatchObject({ state: 'failed', reason: expect.stringContaining('REGISTRY_INVALID_TAX_ID'), can_retry: true });
    expect(body.stopped.find((r: { ref: string }) => r.ref === 'storno:cs_x:re_1')).toMatchObject({ state: 'check', can_retry: false });
    expect(body.eu).toMatchObject({ year: expect.any(Number), limit: 10000 });
    expect(JSON.stringify(body)).not.toMatch(/@|name|address/i);
  });

  it('are mended by an administrator only: retried, or settled by hand, and the refusal says why', async () => {
    const post = (cookie: string, payload: object) => app.inject({ method: 'POST', url: '/api/admin/invoices', headers: { cookie }, payload });
    const marketing = await as(MARKETING);
    const admin = await as(ADMIN);
    expect((await post(marketing, { ref: 'cs_stopped_1', action: 'retry' })).statusCode).toBe(403);
    expect((await post(admin, { ref: 'cs_stopped_1', action: 'delete' })).statusCode).toBe(400);
    expect((await post(admin, { action: 'retry' })).statusCode).toBe(400);
    expect((await post(admin, { ref: 'cs_none', action: 'retry' })).statusCode).toBe(409);
    expect((await post(admin, { ref: 'storno:cs_x:re_1', action: 'retry' })).json().error).toContain('by hand');
    expect((await post(admin, { ref: 'cs_stopped_1', action: 'retry' })).statusCode).toBe(200);
    expect(await store().billing.invoice('cs_stopped_1')).toMatchObject({ state: 'pending', attempts: 0 });
    expect((await post(admin, { ref: 'cs_stopped_1', action: 'retry' })).statusCode).toBe(409);
    expect((await post(admin, { ref: 'storno:cs_x:re_1', action: 'settle' })).statusCode).toBe(200);
    expect(await store().billing.invoice('storno:cs_x:re_1')).toMatchObject({ state: 'done', last_error: 'settled by the operator' });
  });

  it('are listed by the CLI with their reasons, and retried or settled by it', async () => {
    await store().billing.queueInvoice('cs_cli_1', null, T0);
    await store().billing.updateInvoice('cs_cli_1', { state: 'failed', attempts: 3, last_error: 'ANAF refused it', series: 'SPN', number: '7', issuer_ref: 'inv_7', resume: 'issued' }, T0);
    const list = io();
    expect(await runCli(['invoices'], list)).toBe(0);
    const text = list.out_.join('\n');
    expect(text).toMatch(/pending \d+\tissued \d+\tdone \d+\tfailed \d+\tcheck \d+/);
    expect(text).toContain('cs_cli_1\tfailed\ttried 3\tSPN-7\tANAF refused it');
    expect(text).toMatch(/EU consumer sales outside Romania: .* EUR in \d{4}/);
    const retry = io();
    expect(await runCli(['invoices', 'retry', 'cs_cli_1'], retry)).toBe(0);
    expect(await store().billing.invoice('cs_cli_1')).toMatchObject({ state: 'issued' });
    expect(await runCli(['invoices', 'retry', 'cs_cli_1'], io())).toBe(1);
    expect(await runCli(['invoices', 'retry'], io())).toBe(2);
    expect(await runCli(['invoices', 'bogus'], io())).toBe(2);
    await store().billing.updateInvoice('cs_cli_1', { state: 'failed' }, T0);
    expect(await runCli(['invoices', 'settle', 'cs_cli_1'], io())).toBe(0);
    expect(await store().billing.invoice('cs_cli_1')).toMatchObject({ state: 'done' });
  });
});
