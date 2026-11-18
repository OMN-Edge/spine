import { useEffect, useState } from 'react';
import { api, type InvoiceSeller } from '../api';
import { useI18n } from '../i18n';

/**
 * Who the invoices are made out by, on the admin page (the server's `billing/invoicing/seller.ts` checks it): what Spine's own PDF of an invoice a service issued shows, as it was when the invoice was made.
 * An administrator edits it, the marketing role reads it. Spine's own e-Factura link takes the seller from the environment and says so here.
 */
const EMPTY: InvoiceSeller = { name: '', cif: '', street: '', city: '', county: '', postalCode: '' };
const EMPTY_ACCOUNT = { iban: '', bank: '', bic: '', currency: '' };

export default function AdminSeller() {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<{ seller: InvoiceSeller | null; issuer: string | null; can_edit: boolean } | null>(null);
  const [form, setForm] = useState<InvoiceSeller>(EMPTY);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    api.admin.seller().then(r => { setLoaded(r); setForm(r.seller ?? EMPTY); }).catch(() => setLoaded(null));
  }, []);
  if (!loaded) return null;
  const { can_edit: canEdit } = loaded;
  const accounts = form.accounts && form.accounts.length > 0 ? form.accounts : [EMPTY_ACCOUNT];
  const set = (key: keyof InvoiceSeller, value: string) => setForm(f => ({ ...f, [key]: value }));
  const setAccount = (i: number, key: keyof typeof EMPTY_ACCOUNT, value: string) => setForm(f => ({ ...f, accounts: accounts.map((a, n) => (n === i ? { ...a, [key]: value } : a)) }));
  const save = async () => {
    setMessage(null);
    try {
      const r = await api.admin.saveSeller({ ...form, accounts: accounts.filter(a => a.iban.trim() !== '') });
      setForm(r.seller ?? EMPTY);
      setLoaded({ ...loaded, seller: r.seller });
      setMessage({ text: t('Saved.'), error: false });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : t('Could not save'), error: true });
    }
  };
  const field = (key: keyof InvoiceSeller, label: string, opts: { wide?: boolean; hint?: string } = {}) => (
    <label className={`block text-sm ${opts.wide ? 'md:col-span-2' : ''}`}>
      <span className="text-ink/70">{label}</span>
      <input value={(form[key] as string | undefined) ?? ''} onChange={e => set(key, e.target.value)} disabled={!canEdit} placeholder={opts.hint}
        className="mt-1 w-full rounded-xl border border-ink/20 bg-surface px-3 py-2 outline-none focus:border-accent disabled:opacity-60" />
    </label>
  );
  return (
    <section>
      <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{t('Seller on invoices')}</h2>
      <p className="mt-1 text-sm text-ink/60">{t('Who the invoices are made out by. Spine’s own PDF of an invoice shows this, as it was when the invoice was made.')}</p>
      {loaded.issuer === 'efactura' && <p className="mt-2 text-sm text-ink/60">{t('Invoices made by Spine’s own e-Factura link take the seller from the environment (SPINE_SELLER_*); this applies to invoices a service issues.')}</p>}
      {!loaded.seller && loaded.issuer === 'billyou' && <p className="mt-2 text-sm text-amber-700">{t('No seller saved yet: until there is one, an invoice is read in the service’s own PDF.')}</p>}
      {!canEdit && <p className="mt-2 text-sm text-ink/60">{t('Only an administrator can change these.')}</p>}
      <form className="mt-5 rounded-2xl border border-ink/10 bg-surface p-5" onSubmit={e => { e.preventDefault(); if (canEdit) void save(); }}>
        <div className="grid gap-3 md:grid-cols-2">
          {field('name', t('Company name'), { wide: true })}
          {field('cif', t('Tax number (CIF)'), { hint: '12345678' })}
          {field('registerNo', t('Trade register no.'), { hint: 'J40/1234/2020' })}
          {field('vatId', t('VAT id, if a VAT payer'), { hint: 'RO12345678' })}
          {field('email', t('Email'))}
          {field('street', t('Street'), { wide: true })}
          {field('city', t('City'))}
          {field('county', t('County code'), { hint: 'CJ' })}
          {field('sector', t('Sector (Bucharest)'))}
          {field('postalCode', t('Postal code'))}
          {field('phone', t('Phone'))}
        </div>
        <h3 className="mt-6 text-sm font-medium">{t('Bank accounts')}</h3>
        <ul className="mt-2 space-y-3">
          {accounts.map((a, i) => (
            <li key={i} className="grid gap-3 md:grid-cols-[2fr_1.5fr_1fr_5rem]">
              {(['iban', 'bank', 'bic', 'currency'] as const).map(key => (
                <label key={key} className="block text-sm">
                  <span className="text-ink/70">{key === 'iban' ? 'IBAN' : key === 'bank' ? t('Bank') : key === 'bic' ? 'BIC' : t('Currency')}</span>
                  <input value={a[key] ?? ''} onChange={e => setAccount(i, key, e.target.value)} disabled={!canEdit}
                    className="mt-1 w-full rounded-xl border border-ink/20 bg-surface px-3 py-2 outline-none focus:border-accent disabled:opacity-60" />
                </label>
              ))}
            </li>
          ))}
        </ul>
        {canEdit && accounts.length < 6 && <button type="button" onClick={() => setForm(f => ({ ...f, accounts: [...accounts, EMPTY_ACCOUNT] }))} className="mt-3 text-sm text-accent hover:underline">{t('Add an account')}</button>}
        {canEdit && (
          <div className="mt-5 flex items-center gap-3">
            <button type="submit" className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-paper hover:bg-accent/90">{t('Save')}</button>
            {message && <p role="status" className={`text-sm ${message.error ? 'text-red-700' : 'text-green-700'}`}>{message.text}</p>}
          </div>
        )}
      </form>
    </section>
  );
}
