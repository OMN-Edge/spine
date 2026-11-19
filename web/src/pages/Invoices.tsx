import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import InvoiceList, { type InvoiceRow } from '../components/InvoiceList';
import Pager, { usePage } from '../components/Pager';
import { useI18n } from '../i18n';

/** Every invoice and credit note of the account, newest first, twenty to a page, each year under its own heading. */
export default function Invoices() {
  const { t } = useI18n();
  const [page, setPage] = usePage();
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [paging, setPaging] = useState({ total: 0, limit: 20 });
  const [failed, setFailed] = useState(false);
  useEffect(() => { api.billing.invoices(page, 20).then(r => { setRows(r.invoices); setPaging({ total: r.total, limit: r.limit }); }).catch(() => setFailed(true)); }, [page]);
  const years = [...new Set((rows ?? []).map(r => new Date(r.at).getFullYear()))];
  return (
    <div className="max-w-md mx-auto w-full">
      <Link to="/account" className="text-sm text-brand-600 hover:underline">{t('Back to your account')}</Link>
      <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900 mt-3 mb-1">{t('Invoices')}</h1>
      {failed && <p className="text-sm text-red-700">{t('Could not load the invoices.')}</p>}
      {rows && rows.length === 0 && <p className="text-sm text-gray-500">{t('You have no invoices yet.')}</p>}
      {rows && rows.length > 0 && <p className="text-sm text-gray-500 mb-4">{t('{total} in all.', { total: paging.total })}</p>}
      {years.map(year => (
        <section key={year} className="bg-white border border-gray-200 rounded-xl p-5 mb-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">{year}</h2>
          <InvoiceList invoices={(rows ?? []).filter(r => new Date(r.at).getFullYear() === year)} />
        </section>
      ))}
      <Pager page={page} total={paging.total} limit={paging.limit} onPage={setPage} />
    </div>
  );
}
