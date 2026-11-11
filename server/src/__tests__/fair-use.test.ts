import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getAccountsStore } from 'spine-core/store/index.js';
import { linkKey } from 'spine-core/billing/plans.js';
import { logger } from 'spine-core/logger.js';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { createRelayGate, FAIR_USE_MESSAGE } from '../billing/gate.js';
import { fairUseOf, resetFairUse } from '../billing/fair-use.js';
import { watchAccount, resetWatch } from '../billing/watch.js';
import { standingOf } from '../billing/seat.js';
import { windowMonths } from '../billing/window.js';
import { costKey, tokenKey } from '../billing/cost.js';
import { usageReport, formatReport } from '../usage-report.js';
import { resetMailer, type MailMessage } from '../mail/index.js';

const LONG_AGO = '2020-01-01T00:00:00.000Z';
const BILLING = {
  SPINE_BILLING: 'on', PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: 'pdl_test_key', PADDLE_WEBHOOK_SECRET: 'whsec_test', SPINE_CHECKOUT_URL: 'https://pay.spine.example/',
  SPINE_PADDLE_PRICE_YEAR: 'pri_year', SPINE_PADDLE_PRICE_MONTH: 'pri_month', SPINE_PADDLE_PRICE_FOUNDING: 'pri_founding',
};
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const GB = 1024 ** 3;

/** The hidden fair-use ceilings: SECURITY.md M-45, docs/scenarios.md 13.2f. They are the operator's configuration and are never shown. */
describe('the hidden fair-use ceilings', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const saved = { ...process.env };
  const store = () => getAccountsStore();
  const file = path.join(os.tmpdir(), `spine-fair-use-${process.pid}.json`);
  let n = 0;

  beforeAll(async () => { app = await buildTestApp(); });
  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(file, { force: true });
    resetFairUse();
    resetWatch();
    resetMailer(null);
    vi.restoreAllMocks();
  });
  const config = (value: unknown) => {
    process.env.SPINE_FAIR_USE_FILE = file;
    process.env.SPINE_FAIR_USE_CHECK_MS = '0';
    fs.writeFileSync(file, JSON.stringify(value));
    // A rewrite inside the clock's tick keeps the same time: the change is told by a time ahead.
    const t = new Date(Date.now() + 1000 * ++n);
    fs.utimesSync(file, t, t);
  };
  const account = async (plan: 'premium' | 'family' | null = 'premium', interval: 'month' | 'year' = 'year', periodEnd: string | null = null) => {
    const user = await createTestUser(`ceiling-${++n}@spine.test`, { createdAt: LONG_AGO });
    if (plan) await store().billing.put({ user_id: user.id, provider: 'operator', customer_id: null, subscription_id: null, interval, plan, status: 'active', founding: false, current_period_end: periodEnd, cancel_scheduled: false, updated_at: LONG_AGO });
    return user;
  };
  const at = (iso: string) => createRelayGate(() => store(), () => new Date(iso));
  const add = (user: string, key: string, amount: number) => store().usage.aiAdd(user, key, amount);

  describe('what they are, and where they are kept', () => {
    it('are the ceilings of the brief: monthly as a burst guard, yearly for questions, translated pages and link traffic, and Family at twice Premium’s', () => {
      const p = fairUseOf('premium');
      expect(p.monthly).toMatchObject({ messages: 600, translatedPages: 800, linkViews: 5000, linkBytes: 50 * GB });
      expect(p.yearly).toEqual({ messages: 2400, translatedPages: 3000, linkBytes: 100 * GB });
      const f = fairUseOf('family');
      expect(f.monthly).toMatchObject({ messages: 1200, translatedPages: 1600, linkViews: 10000, linkBytes: 100 * GB });
      expect(f.yearly).toEqual({ messages: 4800, translatedPages: 6000, linkBytes: 200 * GB });
      expect(fairUseOf('trial')).toEqual(p);
      // Link opens are monthly only.
      expect(Object.keys(p.yearly)).not.toContain('linkViews');
    });

    it('are changed in a file, with no release and no restart, for one plan and one value at a time', () => {
      expect(fairUseOf('premium').yearly.messages).toBe(2400);
      config({ premium: { yearly: { messages: 5 }, monthly: { linkViews: 7 } }, family: { yearly: { translatedPages: 11 } } });
      expect(fairUseOf('premium').yearly.messages).toBe(5);
      expect(fairUseOf('premium').monthly.linkViews).toBe(7);
      expect(fairUseOf('premium').yearly.translatedPages).toBe(3000);
      expect(fairUseOf('family').yearly).toMatchObject({ translatedPages: 11, messages: 4800 });
      config({ premium: { yearly: { messages: 9 } } });
      expect(fairUseOf('premium').yearly.messages).toBe(9);
      expect(fairUseOf('premium').monthly.linkViews).toBe(5000);
      fs.rmSync(file);
      expect(fairUseOf('premium').yearly.messages).toBe(2400);
    });

    it('keep the built-in value for one the file gets wrong, and for a file that is not JSON', () => {
      config({ premium: { yearly: { messages: -1, translatedPages: 'many', nonsense: 4 }, monthly: { messages: 700 } } });
      expect(fairUseOf('premium').yearly).toEqual({ messages: 2400, translatedPages: 3000, linkBytes: 100 * GB });
      expect(fairUseOf('premium').monthly.messages).toBe(700);
      process.env.SPINE_FAIR_USE_FILE = file;
      fs.writeFileSync(file, '{ not json');
      const t = new Date(Date.now() + 5000); fs.utimesSync(file, t, t);
      expect(fairUseOf('premium').monthly.messages).toBe(600);
    });
  });

  describe('when one is reached', () => {
    it('refuses that one action with a neutral message and no number, and every other action still works', async () => {
      const user = await account();
      const now = '2027-06-15T12:00:00Z';
      await add(user.id, '2027-06:messages', fairUseOf('premium').yearly.messages);
      const refused = await at(now).admit(user.id, 'agent', { work: 'question-new-0001' });
      expect(refused).toEqual({ status: 402, error: FAIR_USE_MESSAGE, code: 'fair_use' });
      expect(refused!.error).not.toMatch(/\d/);
      // Other kinds of work, and adding, still work.
      for (const task of ['translation', 'extraction', 'page', 'embed', 'linking'] as const) expect(await at(now).admit(user.id, task, { work: `w-${task}-000001`, pages: 1 }), task).toBeNull();
      // A question already begun is finished, not cut in two.
      await store().usage.see(user.id, 'w:question-begun-01:2027-06-15T12', now);
      expect(await at(now).admit(user.id, 'agent', { work: 'question-begun-01' })).toBeNull();
    });

    it('counts an id a device reuses again each hour, so reusing one does not make every question free', async () => {
      const user = await account();
      const g = (iso: string) => at(iso);
      await g('2027-06-15T12:00:00Z').settle(user.id, 'agent', 1000, { work: 'reused-id-0000001' });
      await g('2027-06-15T12:30:00Z').settle(user.id, 'agent', 1000, { work: 'reused-id-0000001' });
      expect(await store().usage.aiUsed(user.id, '2027-06:messages')).toBe(1);
      await g('2027-06-15T13:05:00Z').settle(user.id, 'agent', 1000, { work: 'reused-id-0000001' });
      expect(await store().usage.aiUsed(user.id, '2027-06:messages')).toBe(2);
    });

    it('refuses translation past the yearly pages, and nothing else', async () => {
      const user = await account();
      const now = '2027-06-15T12:00:00Z';
      await add(user.id, '2027-05:translated', fairUseOf('premium').yearly.translatedPages);
      expect(await at(now).admit(user.id, 'translation', { work: 'translation-new-01', pages: 3 })).toMatchObject({ code: 'fair_use', error: FAIR_USE_MESSAGE });
      expect(await at(now).admit(user.id, 'agent', { work: 'question-fine-0001' })).toBeNull();
      expect(await at(now).admit(user.id, 'extraction', { pages: 2 })).toBeNull();
    });

    it('refuses at the monthly burst guard too, in the same words, without waiting for the year', async () => {
      const user = await account();
      const now = '2027-06-15T12:00:00Z';
      await add(user.id, '2027-06:chat', fairUseOf('premium').monthly.messages * 800);
      expect(await at(now).admit(user.id, 'chat')).toMatchObject({ code: 'fair_use', error: FAIR_USE_MESSAGE });
      // The next month starts again.
      expect(await at('2027-07-01T00:00:00Z').admit(user.id, 'chat')).toBeNull();
    });

    it('follows the file at once: a lowered ceiling refuses what the old one let through, with nothing deployed', async () => {
      const user = await account();
      const now = '2027-06-15T12:00:00Z';
      await add(user.id, '2027-06:messages', 100);
      expect(await at(now).admit(user.id, 'agent', { work: 'question-cfg-00001' })).toBeNull();
      config({ premium: { yearly: { messages: 100 } } });
      expect(await at(now).admit(user.id, 'agent', { work: 'question-cfg-00002' })).toMatchObject({ code: 'fair_use' });
      config({ premium: { yearly: { messages: 100000 } } });
      expect(await at(now).admit(user.id, 'agent', { work: 'question-cfg-00003' })).toBeNull();
    });
  });

  describe('the twelve months they count over', () => {
    it('are the last twelve months for a monthly subscription: the eleventh month back counts, the twelfth does not', async () => {
      const inside = await account('premium', 'month');
      const outside = await account('premium', 'month');
      const now = '2027-06-15T12:00:00Z';
      const ceiling = fairUseOf('premium').yearly.messages;
      await add(inside.id, '2026-07:messages', ceiling);
      await add(outside.id, '2026-06:messages', ceiling);
      expect(await at(now).admit(inside.id, 'agent', { work: 'question-win-00001' })).toMatchObject({ code: 'fair_use' });
      expect(await at(now).admit(outside.id, 'agent', { work: 'question-win-00002' })).toBeNull();
      // And it rolls: a month later the first of them has gone out of the window.
      expect(await at('2027-08-15T12:00:00Z').admit(inside.id, 'agent', { work: 'question-win-00003' })).toBeNull();
    });

    it('are the billing year for an annual one, from the month the year began, and a new year starts again at its renewal', async () => {
      const user = await account('premium', 'year', '2027-09-20T00:00:00Z');
      const ceiling = fairUseOf('premium').yearly.messages;
      const sub = await store().billing.get(user.id);
      expect(windowMonths(sub, new Date('2027-06-15T00:00:00Z'))[0]).toBe('2026-09');
      expect(windowMonths(sub, new Date('2027-06-15T00:00:00Z')).at(-1)).toBe('2027-06');
      // Used before the year began: not counted. Used in its first month: counted.
      await add(user.id, '2026-08:messages', ceiling);
      expect(await at('2027-06-15T12:00:00Z').admit(user.id, 'agent', { work: 'question-bil-00001' })).toBeNull();
      await add(user.id, '2026-09:messages', ceiling);
      expect(await at('2027-06-15T12:00:00Z').admit(user.id, 'agent', { work: 'question-bil-00002' })).toMatchObject({ code: 'fair_use' });
      // It renews: the new year began in September 2027, and what was used in the one before no longer counts.
      await store().billing.put({ ...sub!, current_period_end: '2028-09-20T00:00:00Z' });
      expect(windowMonths(await store().billing.get(user.id), new Date('2027-10-05T00:00:00Z'))[0]).toBe('2027-09');
      expect(await at('2027-10-05T12:00:00Z').admit(user.id, 'agent', { work: 'question-bil-00003' })).toBeNull();
    });

    it('are the last twelve months for an operator’s grant, which has no billing year, and for a lapsed record', () => {
      const granted = { provider: 'operator', interval: null, current_period_end: null } as never;
      expect(windowMonths(granted, new Date('2027-06-15T00:00:00Z'))).toHaveLength(12);
      const lapsed = { provider: 'paddle', interval: 'year', current_period_end: '2027-01-01T00:00:00Z' } as never;
      expect(windowMonths(lapsed, new Date('2027-06-15T00:00:00Z'))[0]).toBe('2026-07');
    });

    it('keep thirteen months of counts, so the twelve behind them are there, and forget older ones', async () => {
      const user = await account();
      await add(user.id, '2025-11:messages', 7);
      await add(user.id, '2025-12:messages', 5);
      await add(user.id, '2026-12:messages', 1); // the cutoff is thirteen months before what is added: November 2025 is the oldest kept
      expect(await store().usage.aiUsedMany(user.id, ['2025-11:messages', '2025-12:messages', '2026-12:messages'])).toBe(13);
      await add(user.id, '2027-01:messages', 1); // now December 2025 is the oldest kept
      expect(await store().usage.aiUsed(user.id, '2025-11:messages')).toBe(0);
      expect(await store().usage.aiUsed(user.id, '2025-12:messages')).toBe(5);
    });
  });

  describe('for a household', () => {
    it('are counted over the whole pool, whichever member asks', async () => {
      const payer = await account('family');
      const a = await createTestUser(`ceiling-a-${++n}@spine.test`, { createdAt: LONG_AGO });
      const b = await createTestUser(`ceiling-b-${++n}@spine.test`, { createdAt: LONG_AGO });
      for (const member of [a, b]) {
        const id = `i${n}${member.id.slice(0, 8)}`.padEnd(22, 'x').slice(0, 22);
        await store().family.invite(payer.id, { id, secretHash: sha256(id), now: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString() });
        expect(await store().family.join(member.id, id, sha256(id), new Date().toISOString(), { seats: 6, cooldownDays: 30 })).toEqual({ organizer_id: payer.id });
      }
      const now = '2027-06-15T12:00:00Z';
      const half = fairUseOf('family').yearly.messages / 2;
      // Each member asks half the household’s year: neither is over alone, together they are.
      await add(a.id, '2027-06:messages', half); await add(payer.id, 'pool:2027-06:messages', half);
      expect(await at(now).admit(b.id, 'agent', { work: 'question-hh-000001' })).toBeNull();
      await add(b.id, '2027-06:messages', half); await add(payer.id, 'pool:2027-06:messages', half);
      for (const who of [a, b, payer]) expect(await at(now).admit(who.id, 'agent', { work: `question-hh-${who.id.slice(0, 6)}` }), who.id).toMatchObject({ code: 'fair_use' });
    });
  });

  describe('what links send', () => {
    const BODY = { 'content-type': 'application/octet-stream', 'x-spine-pass-check': 'c'.repeat(43), 'x-spine-expires': new Date(Date.now() + 86400e3).toISOString() };
    const share = async (cookie: string, id: string) => expect((await app.inject({ method: 'PUT', url: `/api/shared/${id}`, payload: Buffer.from('sealed'), headers: { cookie, ...BODY } })).statusCode).toBe(201);
    const open = (id: string) => app.inject({ method: 'GET', url: `/api/shared/${id}/bundle` });

    it('are refused past the monthly traffic or opens, and past the yearly traffic, in words that name nothing', async () => {
      Object.assign(process.env, BILLING);
      const user = await account();
      const cookie = await loginAs(app, user.email, user.password);
      await share(cookie, 'ceilingceilingceiling01');
      expect((await open('ceilingceilingceiling01')).statusCode).toBe(200);
      const now = new Date();
      const month = now.toISOString().slice(0, 7);
      await add(user.id, linkKey('egress', now), fairUseOf('premium').monthly.linkBytes);
      const refused = await open('ceilingceilingceiling01');
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toEqual({ error: 'this link is not available just now', code: 'fair_use' });
      expect(JSON.stringify(refused.json())).not.toMatch(/\d/);
      // Under the monthly guard, the year counts too: months of earlier traffic add up past the yearly ceiling.
      await store().usage.aiAdd(user.id, linkKey('egress', now), 0);
      process.env.SPINE_FAIR_USE_FILE = file; process.env.SPINE_FAIR_USE_CHECK_MS = '0';
      config({ premium: { monthly: { linkBytes: 1000 * GB } } });
      expect((await open('ceilingceilingceiling01')).statusCode).toBe(200);
      const earlier = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 15));
      await add(user.id, linkKey('egress', earlier), fairUseOf('premium').yearly.linkBytes);
      expect((await open('ceilingceilingceiling01')).statusCode).toBe(429);
      void month;
    });

    it('stay the plan’s own limit on the free plan, said as it always was, and the free plan has no hidden ceiling', async () => {
      Object.assign(process.env, BILLING);
      const user = await account(null);
      const cookie = await loginAs(app, user.email, user.password);
      await share(cookie, 'ceilingceilingceiling02');
      await add(user.id, linkKey('views', new Date()), 20);
      const refused = await open('ceilingceilingceiling02');
      expect(refused.statusCode).toBe(429);
      expect(refused.json().code).toBe('link_limit');
    });
  });

  describe('what is never shown', () => {
    it('is in no response of the account’s, no error and no screen the plan’s page draws', async () => {
      Object.assign(process.env, BILLING);
      const user = await account();
      const cookie = await loginAs(app, user.email, user.password);
      for (const url of ['/api/billing', '/api/family', '/api/pricing']) {
        const body = (await app.inject({ method: 'GET', url, headers: { cookie } })).body;
        expect(body, url).not.toMatch(/fair|ceiling|abuse|yearly/i);
        for (const number of ['2400', '3000', '5000', '600', '800', '107374182400']) expect(body, `${url} ${number}`).not.toContain(number);
      }
      const root = path.resolve(import.meta.dirname, '../../..');
      const pricing = fs.readFileSync(path.join(root, 'web/src/pages/Pricing.tsx'), 'utf8');
      // What the page says to a reader, in its t('…') strings: no ceiling's number (the class names of a page have numbers of their own).
      const said = [...pricing.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map(m => m[1]).join(' ');
      expect(said).not.toMatch(/\b(2,?400|3,?000|5,?000|600|800)\b/);
      expect(pricing).not.toMatch(/unlimited/i);
    });
  });

  describe('what the operator is told', () => {
    it('is what each kind of work cost, as numbers by the month, an estimate from what was sent and what came back', async () => {
      const user = await account();
      const now = '2027-06-15T12:00:00Z';
      await at(now).settle(user.id, 'agent', 24_000, { work: 'question-cost-0001', outBytes: 2_000 });
      await at(now).settle(user.id, 'translation', 8_000, { work: 'translation-cost-01', pages: 2, outBytes: 8_000 });
      const chatMicro = await store().usage.aiUsed(user.id, costKey('chat', '2027-06'));
      expect(chatMicro).toBeGreaterThan(0);
      expect(await store().usage.aiUsed(user.id, tokenKey('chat', '2027-06'))).toBe(6000 + 450);
      expect(await store().usage.aiUsed(user.id, tokenKey('translation', '2027-06'))).toBeGreaterThan(0);
      expect(await store().usage.aiUsed(user.id, costKey('reading', '2027-06'))).toBe(0);
    });

    it('is told once when an account’s AI cost passes the amount set for a month, in the log and, where an address is set, by mail with no content', async () => {
      const warn = vi.spyOn(logger, 'warn');
      const mails: MailMessage[] = [];
      resetMailer({ enabled: true, send: async m => { mails.push(m); } });
      process.env.SPINE_ALERT_EMAIL = 'operator@spine.test';
      config({ watch: { aiEurosPerMonth: 0.001 } });
      const user = await account();
      const now = new Date('2027-06-15T12:00:00Z');
      await at(now.toISOString()).settle(user.id, 'agent', 400_000, { work: 'question-cost-0002', outBytes: 20_000 });
      const standing = (await standingOf(store(), user.id, now))!;
      // The settling looks at the account itself, in the background: give it its turn.
      await new Promise(r => setTimeout(r, 100));
      expect(warn.mock.calls.filter(c => (c[1] as { event?: string })?.event === 'fair_use_watch' && (c[1] as { kind?: string }).kind === 'AI cost this month')).toHaveLength(1);
      expect(mails.some(m => m.to === 'operator@spine.test' && /AI cost this month/.test(m.text))).toBe(true);
      expect(mails.every(m => !/@spine\.test/.test(m.text.replace('operator@spine.test', '')))).toBe(true);
      // Said once for the month, however often it is looked at.
      resetWatch();
      expect(await watchAccount(store(), user.id, standing, new Date('2027-06-16T12:00:00Z'))).toBe(0);
    });

    it('is told when an account reaches a share of any ceiling, and not before', async () => {
      const warn = vi.spyOn(logger, 'warn');
      const user = await account();
      const now = new Date('2027-06-15T12:00:00Z');
      const standing = (await standingOf(store(), user.id, now))!;
      await add(user.id, '2027-06:messages', Math.floor(fairUseOf('premium').yearly.messages * 0.5));
      expect(await watchAccount(store(), user.id, standing, now)).toBe(0);
      resetWatch();
      await add(user.id, '2027-05:messages', Math.ceil(fairUseOf('premium').yearly.messages * 0.4));
      expect(await watchAccount(store(), user.id, standing, now)).toBeGreaterThan(0);
      expect(warn.mock.calls.some(c => (c[1] as { kind?: string })?.kind?.startsWith('questions, this year'))).toBe(true);
    });

    it('is a report of what each account used, the costliest first, with the averages the prices are to be checked against', async () => {
      const user = await account();
      const now = new Date('2027-06-15T12:00:00Z');
      await at(now.toISOString()).settle(user.id, 'agent', 20_000, { work: 'question-rep-00001', outBytes: 3_000 });
      const rows = await usageReport(store(), '2027-06', now);
      const mine = rows.find(r => r.email === user.email)!;
      expect(mine).toMatchObject({ plan: 'premium', messages: 1 });
      expect(mine.euros).toBeGreaterThan(0);
      expect(rows.map(r => r.euros)).toEqual([...rows.map(r => r.euros)].sort((a, b) => b - a));
      const lines = formatReport(rows, '2027-06', 5);
      expect(lines.join('\n')).toMatch(/chat tokens per question: \d+/);
      expect(lines.join('\n')).toMatch(/link bytes per open/);
    });
  });
});
