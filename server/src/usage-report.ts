import type { AccountsStore } from 'spine-core/store/types.js';
import { CHAT_MESSAGE, TRANSLATED_PAGE, linkKey, meterKey } from 'spine-core/billing/plans.js';
import { standingOf } from './billing/seat.js';
import { fairUseOf } from './billing/fair-use.js';
import { windowMonths } from './billing/window.js';
import { costKey, tokenKey, type Family } from './billing/cost.js';

/**
 * What each account really used, for the operator (SECURITY.md **M-45**): the estimated cost of its AI use by kind of work, questions, translated pages, link
 * opens and bytes, storage, and how near it is to each hidden ceiling, so the plans' prices can be checked against real use and an abuse is found. Numbers
 * only, from the counters; nothing of what an account holds. `npm run cli -- usage`.
 */
export interface UsageRow {
  email: string;
  plan: string;
  euros: number;
  messages: number;
  translatedPages: number;
  pagesRead: number;
  linkOpens: number;
  linkBytes: number;
  storageBytes: number;
  chatTokens: number;
  translationTokens: number;
  /** The highest share of any hidden ceiling the account has used, 0 to 1 or more. */
  nearest: number;
}

const FAMILIES: Family[] = ['reading', 'chat', 'translation'];

export async function usageReport(store: AccountsStore, month: string, now: Date = new Date()): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];
  const when = new Date(`${month}-15T00:00:00Z`);
  for (const user of await store.users.list()) {
    const standing = await standingOf(store, user.id, now);
    if (!standing) continue;
    const e = standing.entitlements;
    const fair = fairUseOf(e.plan);
    const pooled = !!e.memberCap;
    const holder = pooled ? standing.holder : user.id;
    const own = (key: string) => store.usage.aiUsed(user.id, key);
    const costs = await Promise.all(FAMILIES.map(f => own(costKey(f, month))));
    const [messages, translated, chatCost, translationCost, views, bytes, chatTokens, translationTokens, storage] = await Promise.all([
      own(meterKey('messages', e, when)), own(meterKey('translated', e, when)),
      store.usage.aiUsed(holder, meterKey('chat', e, when, pooled)), store.usage.aiUsed(holder, meterKey('translation', e, when, pooled)),
      store.usage.aiUsed(holder, linkKey('views', when, standing.seat !== 'none')), store.usage.aiUsed(holder, linkKey('egress', when, standing.seat !== 'none')),
      own(tokenKey('chat', month)), own(tokenKey('translation', month)), store.vault.usage(user.id),
    ]);
    const year = windowMonths(standing.subscription, now);
    const yearly = async (m: 'messages' | 'translated') => store.usage.aiUsedMany(holder, year.map(x => meterKey(m, e, new Date(`${x}-15T00:00:00Z`), pooled)));
    const yearBytes = await store.usage.aiUsedMany(holder, year.map(x => linkKey('egress', new Date(`${x}-15T00:00:00Z`), standing.seat !== 'none')));
    const share = (used: number, ceiling: number) => (ceiling > 0 && Number.isFinite(ceiling) ? used / ceiling : 0);
    rows.push({
      email: user.email, plan: e.plan, euros: costs.reduce((a, b) => a + b, 0) / 1e6, messages, translatedPages: translated,
      pagesRead: await own(meterKey('pages', e, when)), linkOpens: views, linkBytes: bytes, storageBytes: storage.bytes, chatTokens, translationTokens,
      nearest: Math.max(
        share(chatCost, fair.monthly.messages * CHAT_MESSAGE), share(translationCost, fair.monthly.translatedPages * TRANSLATED_PAGE),
        share(views, fair.monthly.linkViews), share(bytes, fair.monthly.linkBytes),
        share(await yearly('messages'), fair.yearly.messages), share(await yearly('translated'), fair.yearly.translatedPages), share(yearBytes, fair.yearly.linkBytes),
      ),
    });
  }
  return rows.sort((a, b) => b.euros - a.euros);
}

/** The report as lines, and what the plans were priced on, worked out from what was really used: tokens per question, pages per account, bytes per open. */
export function formatReport(rows: UsageRow[], month: string, top: number): string[] {
  const mb = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MB`;
  const lines = [`usage in ${month}, the ${Math.min(top, rows.length)} costliest of ${rows.length} accounts (estimates; nothing of what an account holds)`, ''];
  lines.push(['email', 'plan', 'AI €', 'questions', 'pages translated', 'pages read', 'link opens', 'link traffic', 'storage', 'nearest ceiling'].join('\t'));
  for (const r of rows.slice(0, top)) lines.push([r.email, r.plan, r.euros.toFixed(2), r.messages, r.translatedPages, r.pagesRead, r.linkOpens, mb(r.linkBytes), mb(r.storageBytes), `${Math.round(r.nearest * 100)}%`].join('\t'));
  const sum = (f: (r: UsageRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const asked = sum(r => r.messages);
  const opens = sum(r => r.linkOpens);
  lines.push('', 'what the prices are to be checked against:');
  lines.push(`  chat tokens per question: ${asked ? Math.round(sum(r => r.chatTokens) / asked) : 'no questions yet'}`);
  lines.push(`  translated pages per account that translated: ${rows.filter(r => r.translatedPages > 0).length ? (sum(r => r.translatedPages) / rows.filter(r => r.translatedPages > 0).length).toFixed(1) : 'none yet'}`);
  lines.push(`  link bytes per open: ${opens ? mb(sum(r => r.linkBytes) / opens) : 'no opens yet'}`);
  lines.push(`  AI € per account (all ${rows.length}): ${rows.length ? (sum(r => r.euros) / rows.length).toFixed(2) : '0.00'}`);
  return lines;
}
