import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Notice } from './AuthCard';
import { useI18n } from '../i18n';
import { useFormat } from '../format';
import Pager, { usePage } from './Pager';

type View = Awaited<ReturnType<typeof api.admin.efactura>>;

/**
 * Spine's own link to ANAF's e-Factura (docs/efactura.md), where the operator issues the invoices itself: whether it is authorised, until when, a button that goes to ANAF's sign-in (which asks
 * for the qualified certificate: the token plugged in, or its software running), and the newest documents with what ANAF decided. ANAF sends the browser back to `/admin/invoices?efactura=ok` or `=error`.
 * Nothing renders where the operator does not use it.
 */
export default function AdminEfactura() {
  const { t } = useI18n();
  const format = useFormat();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [tested, setTested] = useState<{ ok: boolean; certificateSeen: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const back = new URLSearchParams(window.location.search).get('efactura');
  const [page, setPage] = usePage('documents');
  const load = useCallback(() => { api.admin.efactura(page).then(setView).catch(() => setError(t('Could not load the e-Factura link.'))); }, [t, page]);
  useEffect(load, [load]);

  const authorise = async () => {
    setError('');
    try { window.location.assign((await api.admin.authoriseEfactura()).url); } catch (err) { setError(err instanceof Error ? err.message : t('Could not start the authorisation')); }
  };
  const test = async () => {
    setError(''); setTested(null); setTesting(true);
    try { setTested(await api.admin.testEfactura()); } catch (err) { setError(err instanceof Error ? err.message : t('Could not test the connection')); } finally { setTesting(false); }
  };
  if (!error && (!view || !view.enabled)) return null;
  const day = (iso: string | null) => (iso ? format.date(iso) : '');
  const word = (state: string | null): string => {
    switch (state) {
      case 'ok': return t('Taken by ANAF');
      case 'sent': return t('Waiting for ANAF');
      case 'nok': return t('Refused by ANAF');
      case 'abroad': return t('Not sent: the buyer is abroad');
      default: return t('Not sent yet');
    }
  };
  return (
    <section>
      <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{t('e-Factura')}</h2>
      <div className="mt-5 rounded-2xl border border-ink/10 bg-surface p-5">
      {error && <Notice kind="error">{error}</Notice>}
      {back === 'ok' && <Notice kind="ok">{t('Authorised with ANAF.')}</Notice>}
      {back === 'error' && <Notice kind="error">{t('The authorisation with ANAF did not work. Try again.')}</Notice>}
      {view?.enabled && (
        <>
          {view.mode === 'test' && <p className="text-sm text-amber-700 mb-2">{t('ANAF’s test platform is in use: nothing sent is a real invoice.')}</p>}
          <p className="text-sm text-ink/80 mb-3">
            {view.authorised
              ? t('Authorised with ANAF. The access lasts until {access}, the authorisation until {refresh}.', { access: day(view.accessExpiresAt), refresh: day(view.refreshExpiresAt) })
              : t('Not authorised with ANAF yet. Plug in the certificate (or start its software) and sign in.')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void authorise()} className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-paper hover:bg-accent/90">{t('Sign in to ANAF with the certificate')}</button>
            {view.authorised && <button type="button" disabled={testing} onClick={() => void test()} className="rounded-full border border-ink/20 px-4 py-1.5 text-sm text-ink/80 hover:bg-ink/5 disabled:opacity-50">{t('Test the connection')}</button>}
          </div>
          {tested && <Notice kind={tested.ok ? 'ok' : 'error'}>{tested.ok ? (tested.certificateSeen ? t('ANAF accepted the token and saw the certificate. Nothing was sent to e-Factura.') : t('ANAF accepted the token. Nothing was sent to e-Factura.')) : tested.message}</Notice>}
          <p className="text-xs text-ink/60 mt-3">{t('Series {series}, seller {name} ({cif}).', { series: view.series, name: view.seller.name, cif: view.seller.cif })}</p>
          {view.documents.length > 0 && (
            <>
              <h3 className="text-sm font-medium text-ink mt-4 mb-1">{t('Newest invoices')}</h3>
              <ul className="divide-y divide-ink/10">
                {view.documents.map(d => (
                  <li key={d.id} className="py-2">
                    <div className="text-sm text-ink">{d.number}{d.kind === 'credit' ? ` · ${t('Credit note')}` : ''} · {d.date} · {word(d.state)}</div>
                    {d.message && <div className="text-xs text-ink/65 break-words">{d.message}</div>}
                  </li>
                ))}
              </ul>
              <Pager page={page} total={view.total} limit={view.limit} onPage={setPage} />
            </>
          )}
        </>
      )}
    </div>
    </section>
  );
}
