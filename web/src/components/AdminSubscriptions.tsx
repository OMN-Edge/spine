import { useEffect, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { useFormat } from '../format';
import Pager, { usePage } from './Pager';
import { msg } from '../i18n';

type Row = Awaited<ReturnType<typeof api.admin.subscriptions>>['subscriptions'][number];

/** The plan, the biller and the state of a subscription in words, not as the codes the server holds them in. */
const PLAN_NAMES: Record<string, string> = { essential: msg('Essential'), premium: msg('Premium'), family: msg('Family'), free: msg('Free'), trial: msg('Free trial') };
const BILLERS: Record<string, string> = { operator: msg('You (granted)'), stripe: msg('Stripe'), paddle: msg('Paddle') };
const STATES: Record<string, string> = { active: msg('Active'), trialing: msg('Trial'), past_due: msg('Payment late'), canceled: msg('Cancelled'), paused: msg('Paused'), incomplete: msg('Not completed'), unpaid: msg('Unpaid') };

/**
 * What each account with a subscription has, for an address in SPINE_ADMIN_EMAILS: the plan and its interval, who bills it (the payment provider, or the operator for a
 * granted plan), the provider's word for its state and when what is paid for ends or renews. Nothing of what an account holds; the server refuses anyone else, which reads as nothing.
 */
export default function AdminSubscriptions() {
  const { t } = useI18n();
  const format = useFormat();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [paging, setPaging] = useState({ total: 0, limit: 25 });
  const [error, setError] = useState(false);
  const [page, setPage] = usePage();
  useEffect(() => { api.admin.subscriptions(page).then(r => { setRows(r.subscriptions); setPaging({ total: r.total, limit: r.limit }); }).catch(() => setError(true)); }, [page]);

  if (error) return <p className="text-red-700">{t('Could not load the subscriptions.')}</p>;
  if (rows === null) return null;
  const day = (iso: string | null) => (iso ? format.date(iso) : '–');
  const plan = (r: Row) => `${t(PLAN_NAMES[r.plan] ?? r.plan)}${r.interval === 'year' ? ` (${t('yearly')})` : r.interval === 'month' ? ` (${t('monthly')})` : ''}${r.founding ? ` · ${t('founding')}` : ''}`;
  const biller = (r: Row) => t(BILLERS[r.provider] ?? r.provider);
  // A plan the operator granted has no payment behind it: it says until when it was given.
  const state = (r: Row) => (r.provider === 'operator' ? t('Granted until {date}', { date: day(r.until) }) : `${t(STATES[r.status] ?? r.status)}${r.ends ? ` · ${t('ends then')}` : ''}`);
  return (
    <section>
      <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{t('Subscriptions')}</h2>
      <div className="mt-5 rounded-2xl border border-ink/10 bg-surface p-5">
      <p className="text-sm text-ink/60 mb-4">{paging.total === 0 ? t('No account has a subscription.') : t('{total} in all.', { total: paging.total })}</p>
      {rows.length > 0 && (
        <>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <thead className="text-left text-ink/60"><tr className="border-b border-ink/10"><th className="py-2 pr-4 font-normal">{t('Account')}</th><th className="py-2 pr-4 font-normal">{t('Plan')}</th><th className="py-2 pr-4 font-normal">{t('Billed by')}</th><th className="py-2 pr-4 font-normal">{t('State')}</th><th className="py-2 font-normal">{t('Paid until')}</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.email}-${i}`} className="border-b border-ink/10 align-top last:border-0">
                    <td className="py-2 pr-4 break-all">{r.email ?? '—'}</td>
                    <td className="py-2 pr-4">{plan(r)}</td>
                    <td className="py-2 pr-4">{biller(r)}</td>
                    <td className="py-2 pr-4">{state(r)}</td>
                    <td className="py-2">{day(r.until)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* A phone's width has no room for five columns: each account is two lines instead. */}
          <ul className="divide-y divide-ink/10 sm:hidden">
            {rows.map((r, i) => (
              <li key={`${r.email}-${i}`} className="py-3 text-sm">
                <p className="break-all">{r.email ?? '—'}</p>
                <p className="text-ink/60">{plan(r)} · {biller(r)}</p>
                <p className="text-ink/60">{state(r)}{r.provider === 'operator' ? '' : ` · ${t('Paid until')} ${day(r.until)}`}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      <Pager page={page} total={paging.total} limit={paging.limit} onPage={setPage} />
    </div>
    </section>
  );
}
