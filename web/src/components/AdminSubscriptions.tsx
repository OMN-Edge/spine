import { useEffect, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';

type Row = Awaited<ReturnType<typeof api.admin.subscriptions>>['subscriptions'][number];

/**
 * What each account with a subscription has, for an address in SPINE_ADMIN_EMAILS: the plan and its interval, who bills it (the payment provider, or the operator for a
 * granted plan), the provider's word for its state and when what is paid for ends or renews. Nothing of what an account holds; the server refuses anyone else, which reads as nothing.
 */
export default function AdminSubscriptions() {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { api.admin.subscriptions().then(r => setRows(r.subscriptions)).catch(() => setError(true)); }, []);

  if (error) return <p className="text-red-700">{t('Could not load the subscriptions.')}</p>;
  if (rows === null) return null;
  const running = rows.filter(r => r.status === 'active' || r.status === 'trialing' || r.status === 'past_due').length;
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '–');
  return (
    <section>
      <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{t('Subscriptions')}</h2>
      <div className="mt-5 rounded-2xl border border-ink/10 bg-surface p-5">
      <p className="text-sm text-ink/60 mb-4">{rows.length === 0 ? t('No account has a subscription.') : t('{running} running, {total} in all.', { running, total: rows.length })}</p>
      {rows.length > 0 && (
        <>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <thead className="text-left text-ink/60"><tr className="border-b border-ink/10"><th className="py-2 pr-4 font-normal">{t('Account')}</th><th className="py-2 pr-4 font-normal">{t('Plan')}</th><th className="py-2 pr-4 font-normal">{t('Billed by')}</th><th className="py-2 pr-4 font-normal">{t('State')}</th><th className="py-2 font-normal">{t('Paid until')}</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.email}-${i}`} className="border-b border-ink/10 align-top last:border-0">
                    <td className="py-2 pr-4 break-all">{r.email ?? '—'}</td>
                    <td className="py-2 pr-4">{r.plan}{r.interval ? ` (${r.interval})` : ''}{r.founding ? ` · ${t('founding')}` : ''}</td>
                    <td className="py-2 pr-4">{r.provider}</td>
                    <td className="py-2 pr-4">{r.status}{r.ends ? ` · ${t('ends then')}` : ''}</td>
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
                <p className="text-ink/60">{r.plan}{r.interval ? ` (${r.interval})` : ''}{r.founding ? ` · ${t('founding')}` : ''} · {r.provider}</p>
                <p className="text-ink/60">{r.status}{r.ends ? ` · ${t('ends then')}` : ''} · {t('Paid until')} {day(r.until)}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
    </section>
  );
}
