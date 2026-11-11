import type { AccountsStore } from 'spine-core/store/types.js';
import { CHAT_MESSAGE, TRANSLATED_PAGE, meterKey, type Meter } from 'spine-core/billing/plans.js';
import { logger } from 'spine-core/logger.js';
import { getMailer } from '../mail/index.js';
import { fairUseOf, watchOf } from './fair-use.js';
import { linkPosition } from './links.js';
import { costKey, type Family } from './cost.js';
import { windowMonths } from './window.js';
import type { Standing } from './seat.js';

/**
 * What the operator is told, and when (SECURITY.md **M-45**): an account whose AI use costs more than a set amount in a month, and one that reaches a set
 * fraction of any hidden fair-use ceiling, so an abuse is seen as it starts and not when the bill comes. Each is said once for its month (or, for a
 * yearly ceiling, its window), in the log as a warning and, where `SPINE_ALERT_EMAIL` names an address and there is a mailer, by mail: the account's id
 * and what was reached, never a word of what the account holds. Looked at for an account at most once in five minutes, however many calls it makes.
 */
const EVERY_MS = 5 * 60 * 1000;
const looked = new Map<string, number>();
export const resetWatch = (): void => looked.clear();

interface Reading { label: string; used: number; limit: number; window: string }

export async function watchAccount(store: AccountsStore, userId: string, standing: Standing, now: Date): Promise<number> {
  const last = looked.get(userId) ?? 0;
  if (now.getTime() - last < EVERY_MS) return 0;
  looked.set(userId, now.getTime());
  const e = standing.entitlements;
  const fair = fairUseOf(e.plan);
  const { fractionOfCeiling, aiEurosPerMonth } = watchOf();
  const month = now.toISOString().slice(0, 7);
  const pooled = !!e.memberCap;
  const holder = pooled ? standing.holder : userId;
  const used = (user: string, key: string) => store.usage.aiUsed(user, key);
  const year = windowMonths(standing.subscription, now);

  const meterUsed = (meter: Meter) => used(holder, meterKey(meter, e, now, pooled));
  const yearly = (meter: 'messages' | 'translated') => store.usage.aiUsedMany(holder, year.map(m => meterKey(meter, e, new Date(`${m}-15T00:00:00Z`), pooled)));
  const links = await linkPosition(userId, now, standing);
  const readings: Reading[] = [
    { label: 'chat, this month', used: await meterUsed('chat'), limit: fair.monthly.messages * CHAT_MESSAGE, window: month },
    { label: 'translation, this month', used: await meterUsed('translation'), limit: fair.monthly.translatedPages * TRANSLATED_PAGE, window: month },
    { label: 'questions, this year', used: await yearly('messages'), limit: fair.yearly.messages, window: `year-${year[0]}` },
    { label: 'translated pages, this year', used: await yearly('translated'), limit: fair.yearly.translatedPages, window: `year-${year[0]}` },
    ...(links ? [
      { label: 'link opens, this month', used: links.views, limit: links.ceiling.views, window: month },
      { label: 'link traffic, this month', used: links.bytes, limit: links.ceiling.bytes, window: month },
      { label: 'link traffic, this year', used: links.yearBytes, limit: links.ceiling.yearBytes, window: `year-${year[0]}` },
    ] : []),
  ];

  const families: Family[] = ['reading', 'chat', 'translation'];
  const euros = (await Promise.all(families.map(f => used(userId, costKey(f, month))))).reduce((a, b) => a + b, 0) / 1e6;

  const said: string[] = [];
  const say = async (kind: string, window: string, detail: Record<string, unknown>) => {
    const marker = `alerted:${window}:${kind}`;
    if ((await used(userId, marker)) > 0) return;
    await store.usage.aiAdd(userId, marker, 1);
    said.push(kind);
    logger.warn('an account is near a fair-use ceiling or its AI cost is high', { event: 'fair_use_watch', account: userId, plan: e.plan, kind, ...detail });
    const to = process.env.SPINE_ALERT_EMAIL;
    const mailer = getMailer();
    if (to && mailer.enabled) {
      await mailer.send({ to, subject: 'Spine: an account needs a look', text: `Account ${userId} (plan ${e.plan}): ${kind}.\n\n${Object.entries(detail).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nNothing of what the account holds is in this message.\n` }).catch(() => undefined);
    }
  };
  if (euros >= aiEurosPerMonth) await say('AI cost this month', month, { estimated_eur: euros.toFixed(2) });
  for (const r of readings) {
    if (r.limit > 0 && Number.isFinite(r.limit) && r.used >= r.limit * fractionOfCeiling) await say(`${r.label}, ${Math.round(fractionOfCeiling * 100)}% of its ceiling`, r.window, { used: r.used, ceiling: r.limit });
  }
  return said.length;
}
