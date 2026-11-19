import type { AccountsStore } from 'spine-core/store/types.js';
import { logger } from 'spine-core/logger.js';
import { getMailer } from '../mail/index.js';
import { costKey, type Family } from './cost.js';
import { settingOf } from '../operator-settings.js';

/**
 * The monthly AI budget (the marketing plan: "a monthly AI budget alert from day one"). The monthly AI budget (the admin page's setting, else `SPINE_AI_BUDGET_EUR`, `operator-settings.ts`) is what the operator is willing to spend on
 * AI in a month; at half, four fifths and all of it the operator is told once for the month, in the log and, where `SPINE_ALERT_EMAIL` names an address
 * and there is a mailer, by mail: a sum and a percentage, nothing of any account. It is the instance's total of the estimates the relay keeps by account
 * (`plans/cost.ts`), so it is a warning in time, not an invoice. Without the setting nothing is watched. Safe to run more than once: each step is
 * counted by the day under its name and said only when no day of the month has it.
 */
const STEPS = [50, 80, 100] as const;
const FAMILIES: Family[] = ['reading', 'chat', 'translation'];

/** The estimated AI cost of the whole instance in a month, in euros. */
export async function monthlyCost(store: AccountsStore, month: string): Promise<number> {
  let micro = 0;
  for (const user of await store.users.list()) micro += await store.usage.aiUsedMany(user.id, FAMILIES.map(f => costKey(f, month)));
  return micro / 1e6;
}


/** Says which steps of the budget the month has reached and had not yet been told, and tells them. */
export async function watchBudget(store: AccountsStore, now: Date = new Date()): Promise<number[]> {
  const budget = await settingOf(store, 'ai.budget');
  if (budget === null) return [];
  const month = now.toISOString().slice(0, 7);
  const spent = await monthlyCost(store, month);
  const told = new Set((await store.metrics.totals(`${month}-01`)).filter(t => t.total > 0).map(t => t.name));
  const said: number[] = [];
  for (const step of STEPS) {
    const name = `budget_alert_${step}`;
    if (spent < (budget * step) / 100 || told.has(name)) continue;
    await store.metrics.bump(name, now.toISOString().slice(0, 10));
    said.push(step);
    logger.warn('the monthly AI budget is being used', { event: 'ai_budget', step, estimated_eur: spent.toFixed(2), budget_eur: budget, month });
    const to = process.env.SPINE_ALERT_EMAIL;
    const mailer = getMailer();
    if (to && mailer.enabled) {
      await mailer.send({ to, subject: `Spine: ${step}% of the monthly AI budget`, text: `The estimated AI cost of ${month} is ${spent.toFixed(2)} EUR, ${Math.round((spent / budget) * 100)}% of the budget of ${budget} EUR.\n\nThis is the relay's estimate by the token, not an invoice. Nothing of what any account holds is in this message.\n` }).catch(() => undefined);
    }
  }
  return said;
}
