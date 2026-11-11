import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { COUNTS, IMPORT_PAGES, PAGE, PAST_DUE_GRACE_DAYS, PLANS, TASK_METER, TRANSLATED_PAGE, meterKey, SEAT_COOLDOWN_DAYS, SEAT_INVITES_WAITING, SEAT_INVITE_DAYS, entitlementsOf, planOf, subscriptionEntitles, taskCost, trialEnd, usagePeriod } from '../billing/plans.js';
import type { SubscriptionRecord } from '../store/types.js';

const DAY = 86_400_000;
const sub = (over: Partial<SubscriptionRecord>): SubscriptionRecord => ({
  user_id: 'u', provider: 'paddle', customer_id: 'ctm', subscription_id: 'sub', interval: 'year', plan: 'premium', status: 'active', founding: false,
  current_period_end: null, cancel_scheduled: false, updated_at: '2026-01-01T00:00:00.000Z', ...over,
});
const now = new Date('2026-06-15T12:00:00.000Z');
const created = (daysAgo: number) => ({ created_at: new Date(now.getTime() - daysAgo * DAY).toISOString() });

describe('which plan an account has', () => {
  it('is the trial for six months from the account’s day, then the free plan', () => {
    expect(planOf(created(0), null, now)).toBe('trial');
    expect(planOf(created(150), null, now)).toBe('trial');
    expect(planOf(created(200), null, now)).toBe('free');
    expect(trialEnd('2026-01-31T00:00:00.000Z').slice(0, 10)).toBe('2026-07-31');
  });

  it('is Premium while a subscription runs, over the trial or the free plan', () => {
    expect(planOf(created(400), sub({ current_period_end: new Date(now.getTime() + 30 * DAY).toISOString() }), now)).toBe('premium');
    expect(planOf(created(10), sub({}), now)).toBe('premium');
  });

  it('keeps what was paid for after a cancellation, to the end of it', () => {
    const ending = (days: number) => sub({ status: 'canceled', current_period_end: new Date(now.getTime() + days * DAY).toISOString() });
    expect(subscriptionEntitles(ending(5), now)).toBe(true);
    expect(subscriptionEntitles(ending(-1), now)).toBe(false);
    expect(subscriptionEntitles(sub({ status: 'canceled', current_period_end: null }), now)).toBe(false);
  });

  it('gives a late payment a few days and no more', () => {
    const lateBy = (days: number) => sub({ status: 'past_due', current_period_end: new Date(now.getTime() - days * DAY).toISOString() });
    expect(subscriptionEntitles(lateBy(PAST_DUE_GRACE_DAYS - 1), now)).toBe(true);
    expect(subscriptionEntitles(lateBy(PAST_DUE_GRACE_DAYS + 1), now)).toBe(false);
  });

  it('does not trust an active subscription whose end passed more than a day ago', () => {
    expect(subscriptionEntitles(sub({ current_period_end: new Date(now.getTime() - 3 * DAY).toISOString() }), now)).toBe(false);
    expect(subscriptionEntitles(sub({ current_period_end: new Date(now.getTime() - 3600e3).toISOString() }), now)).toBe(true);
  });
});

describe('what a plan includes', () => {
  it('counts the trial once and the other plans by month', () => {
    const trial = entitlementsOf(created(1), null, now);
    expect(trial).toMatchObject({ plan: 'trial', allowance: { pages: 150, import: 0, messages: Infinity, translated: Infinity }, vaultBytes: 5 * 1024 ** 3, liveShares: null, linkViews: Infinity, linkBytes: Infinity, documents: null, translation: true, approvalMode: true });
    expect(usagePeriod(trial, now)).toBe('trial');
    const free = entitlementsOf(created(300), null, now);
    expect(free).toMatchObject({ plan: 'free', allowance: { pages: 10, import: 0, messages: 0, translated: 0 }, vaultBytes: 1024 ** 3, liveShares: 1, documents: 50, linkViews: 20, linkBytes: 1024 ** 3, chat: false });
    expect(usagePeriod(free, now)).toBe('2026-06');
  });
});

describe('the family plan', () => {
  it('is Premium for six people, who may be children, with accounts of their own, and twice the reading', () => {
    const family = entitlementsOf(created(400), sub({ plan: 'family', current_period_end: new Date(now.getTime() + 30 * DAY).toISOString() }), now);
    expect(family).toMatchObject({ plan: 'family', profiles: 6, delegation: true, translation: true, chat: true, vaultBytes: 25 * 1024 ** 3, liveShares: null });
    // The pool is twice Premium's, and each account is held to Premium's.
    expect(family.allowance).toMatchObject({ pages: 60, import: 2 * IMPORT_PAGES, messages: Infinity, translated: Infinity });
    expect(family.memberCap).toMatchObject({ pages: 30, import: IMPORT_PAGES, messages: Infinity, translated: Infinity });
    // Only the free plan limits links, views and traffic.
    expect(family).toMatchObject({ linkViews: Infinity, linkBytes: Infinity });
    const premium = entitlementsOf(created(400), sub({ current_period_end: new Date(now.getTime() + 30 * DAY).toISOString() }), now);
    expect(premium).toMatchObject({ plan: 'premium', profiles: 1, delegation: false, memberCap: null, vaultBytes: 5 * 1024 ** 3, liveShares: null, linkViews: Infinity });
    // Ending a family subscription goes the way every one does.
    expect(planOf(created(400), sub({ plan: 'family', status: 'canceled', current_period_end: new Date(now.getTime() - DAY).toISOString() }), now)).toBe('free');
  });

  // Seats are accounts, people are profiles: the plan holds six of each, and only a plan whose seats are more than one can be shared.
  it('has six seats and six people in all, and the plans that are not shared have one seat', () => {
    expect(PLANS.family).toMatchObject({ seats: 6, profiles: 6 });
    for (const plan of ['trial', 'free', 'premium'] as const) expect(PLANS[plan].seats, plan).toBe(1);
    expect(entitlementsOf(created(400), sub({ plan: 'family', current_period_end: new Date(now.getTime() + 30 * DAY).toISOString() }), now).seats).toBe(6);
  });

  it('holds an invitation for a week, a wait of a month after a seat is given up, and ten invitations waiting', () => {
    expect([SEAT_INVITE_DAYS, SEAT_COOLDOWN_DAYS, SEAT_INVITES_WAITING]).toEqual([7, 30, 10]);
  });
});

describe('the meters', () => {
  it('count pages, questions, translated pages and the archive import, each its own count, and use is not limited', () => {
    expect(COUNTS).toEqual(['pages', 'messages', 'translated', 'import']);
    expect(TASK_METER).toMatchObject({ extraction: 'reading', embed: 'reading', linking: 'reading', chat: 'chat', agent: 'chat', translation: 'translation' });
    // Only adding has an allowance: pages and the import. Using is counted, with none.
    for (const plan of ['trial', 'premium', 'family'] as const) expect([plan, PLANS[plan].allowance.messages, PLANS[plan].allowance.translated]).toEqual([plan, Infinity, Infinity]);
    expect(PLANS.free.allowance).toMatchObject({ messages: 0, translated: 0 });
  });

  it('keep the hidden cost ceiling of reading under the key it always had, and every other meter by the month, a plan’s pool apart from an account’s own', () => {
    const trial = entitlementsOf(created(1), null, now);
    const free = entitlementsOf(created(300), null, now);
    expect(meterKey('reading', trial, now)).toBe('trial');
    expect(meterKey('reading', free, now)).toBe('2026-06');
    // The trial's pages are one total; its questions and translation are by the month like Premium's.
    expect(meterKey('pages', trial, now)).toBe('trial:pages');
    expect(meterKey('pages', free, now)).toBe('2026-06:pages');
    expect(meterKey('messages', trial, now)).toBe('2026-06:messages');
    expect(meterKey('translated', free, now, true)).toBe('pool:2026-06:translated');
    // The import allowance is once, not by the month: its key has no month, so nothing forgets it.
    expect(meterKey('import', free, now)).toBe('once:import');
    expect(meterKey('import', free, now, true)).toBe('pool:once:import');
  });

  it('give Premium the pages of the plan table, no ceiling of any kind in what a browser is sent, and Free no questions and no translation', () => {
    expect(PLANS.premium.allowance).toMatchObject({ pages: 30, import: IMPORT_PAGES, messages: Infinity, translated: Infinity, reading: Infinity, chat: Infinity, translation: Infinity });
    expect(PLANS.free).toMatchObject({ chat: false, translation: false });
    expect(PLANS.free.allowance).toMatchObject({ pages: 10, messages: 0, translated: 0 });
    // The hidden fair-use ceilings are the server's configuration (`server/src/billing/fair-use.ts`); none is in what the browser bundles.
    expect(readFileSync(new URL('../billing/plans.ts', import.meta.url), 'utf8')).not.toMatch(/CEILING|FAIR_USE|BACKSTOP/);
  });
});

describe('what a call costs', () => {
  it('grows with the request for reading and translating, and is flat for a page', () => {
    expect(taskCost('extraction', 0)).toBe(100);
    expect(taskCost('extraction', 8 * 1024)).toBe(1100);
    expect(taskCost('page', 500_000)).toBe(PAGE);
    expect(taskCost('translation', 2048)).toBe(330);
    // A chat message is a few calls of a few kilobytes each: about the cost the allowances count a message at.
    expect(taskCost('agent', 8 * 1024)).toBe(256);
    expect(taskCost('embed', 100)).toBeGreaterThan(0);
  });
});
