import { useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { useFormat } from '../format';
import { Notice } from './AuthCard';

export type InvoiceRow = { ref: string; number: string; at: string; credit_note: boolean };

/**
 * The account's invoices and credit notes, each with its number and day and a Download. A PDF opens in a window made at the press (a link got after a wait is taken for a pop-up),
 * then pointed at the link the service gave, which is asked for when pressed because it does not last. The same list is on the plan card (the newest few) and on the page of all of them.
 */
export default function InvoiceList({ invoices }: { invoices: InvoiceRow[] }) {
  const { t } = useI18n();
  const format = useFormat();
  const [error, setError] = useState('');
  const open = async (ref: string) => {
    setError('');
    const opened = window.open('', '_blank');
    if (opened) opened.opener = null;
    try {
      const { url } = await api.billing.invoicePdf(ref);
      if (opened) opened.location.href = url; else window.location.assign(url);
    } catch (err) {
      opened?.close();
      setError(err instanceof Error ? err.message : t('Could not open the invoice'));
    }
  };
  return (
    <>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="divide-y divide-gray-100 text-sm">
        {invoices.map(i => (
          <li key={i.ref} className="py-1.5 flex items-center gap-3">
            <span className="flex-1 text-gray-700">{i.number}{i.credit_note ? ` · ${t('Credit note')}` : ''} · {format.date(i.at)}</span>
            <button type="button" onClick={() => void open(i.ref)} className="text-brand-600 hover:underline">{t('Download')}</button>
          </li>
        ))}
      </ul>
    </>
  );
}
