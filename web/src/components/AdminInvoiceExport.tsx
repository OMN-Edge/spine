import { useEffect, useState } from 'react';
import { api } from '../api';
import { Notice } from './AuthCard';
import { useI18n } from '../i18n';
import { useFormat } from '../format';

/** The twelve months before this one and this one, newest first, as `YYYY-MM`: what an accountant asks for is a month that has ended, which is the first. */
export function recentMonths(today: Date = new Date(), count = 13): string[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

/**
 * The month's invoices and credit notes in one document for the accountant, as a spreadsheet file or a PDF to sign (the server's `billing/invoicing/journal.ts`, which says what it lists
 * and why it is lawful). Offered to an administrator only, since it names every buyer of the month. It opens on the month that has just ended.
 */
export default function AdminInvoiceExport() {
  const { t } = useI18n();
  const format = useFormat();
  const [admin, setAdmin] = useState(false);
  const months = recentMonths();
  const [month, setMonth] = useState(months[1]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.admin.role().then(r => setAdmin(r.role === 'admin')).catch(() => setAdmin(false)); }, []);
  if (!admin) return null;

  const download = async (kind: 'csv' | 'pdf') => {
    setBusy(true); setError('');
    try {
      const blob = await api.admin.invoiceExport(month, kind);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `centralizator-facturi-${month}.${kind}`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not make the summary'));
    } finally { setBusy(false); }
  };
  const button = 'rounded-full border border-ink/20 px-4 py-1.5 text-sm text-ink/80 hover:bg-ink/5 disabled:opacity-50';
  return (
    <section>
      <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{t('Monthly summary for the accountant')}</h2>
      <p className="mt-1 text-sm text-ink/60">{t('The month’s invoices and credit notes in one document, for the accountant’s books (OMFP 2634/2015, annex 1, point 20). The invoices stay the supporting documents. Only invoices Spine holds a copy of are listed.')}</p>
      <div className="mt-5 rounded-2xl border border-ink/10 bg-surface p-5">
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="text-ink/70">{t('Month')}</span>
            <select value={month} onChange={e => setMonth(e.target.value)} className="mt-1 block rounded-xl border border-ink/20 bg-surface px-3 py-2 outline-none focus:border-accent">
              {months.map(m => <option key={m} value={m}>{format.month(m)}</option>)}
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => void download('csv')} className={button}>{t('Download the spreadsheet (CSV)')}</button>
          <button type="button" disabled={busy} onClick={() => void download('pdf')} className={button}>{t('Download the PDF to sign')}</button>
        </div>
      </div>
    </section>
  );
}
