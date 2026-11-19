import { useEffect, useState } from 'react';
import { api, type InvoiceVat } from '../api';
import { Notice } from './AuthCard';
import { useI18n } from '../i18n';

/**
 * Whether the company is registered for VAT (the server's `billing/invoicing/vat.ts`, which says what each invoice carries because of it): the switch the operator turns on the day it is, the day invoices carry VAT from, and
 * whether the company has joined the One Stop Shop (only with Spine's own e-Factura link: an invoicing service takes only Romania's rates). An administrator changes it; the marketing role reads it.
 */
export default function AdminVat() {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<{ vat: InvoiceVat; seller_has_vat_id: boolean; romania_rate: number; oss_available: boolean; can_edit: boolean } | null>(null);
  const [form, setForm] = useState<InvoiceVat>({ registered: false, from: null, oss: false });
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    api.admin.vat().then(r => { if (r.issuer) { setLoaded(r); setForm(r.vat); } }).catch(() => setLoaded(null));
  }, []);
  if (!loaded) return null;
  const { can_edit: canEdit } = loaded;
  const save = async () => {
    setMessage(null);
    try {
      const r = await api.admin.saveVat(form);
      setForm(r.vat);
      setMessage({ text: t('Saved.'), error: false });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : t('Could not save'), error: true });
    }
  };
  const box = 'mt-1 rounded border-ink/30 disabled:opacity-60';
  return (
    <section>
      <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{t('VAT on invoices')}</h2>
      <p className="mt-1 text-sm text-ink/60">{t('Whether the company is registered for VAT decides what each invoice carries. Not registered: no VAT, with the mention of art. 310 (and “not taxable in Romania” outside the EU). Registered: Romania’s VAT for people in Romania, and, once the company has joined the One Stop Shop, the VAT of their own country for people in other EU countries; none outside the EU.')}</p>
      {!canEdit && <p className="mt-2 text-sm text-ink/60">{t('Only an administrator can change these.')}</p>}
      <form className="mt-5 rounded-2xl border border-ink/10 bg-surface p-5" onSubmit={e => { e.preventDefault(); if (canEdit) void save(); }}>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className={box} disabled={!canEdit} checked={form.registered} onChange={e => setForm(f => ({ ...f, registered: e.target.checked, oss: e.target.checked ? f.oss : false }))} />
          <span>{t('The company is registered for VAT')}</span>
        </label>
        {form.registered && (
          <div className="mt-4 space-y-4 pl-7">
            <label className="block text-sm">
              <span className="text-ink/70">{t('Invoices dated from this day carry VAT')}</span>
              <input type="date" value={form.from ?? ''} disabled={!canEdit} onChange={e => setForm(f => ({ ...f, from: e.target.value || null }))}
                className="mt-1 block rounded-xl border border-ink/20 bg-surface px-3 py-2 outline-none focus:border-accent disabled:opacity-60" />
            </label>
            {loaded.oss_available ? (
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" className={box} disabled={!canEdit} checked={form.oss} onChange={e => setForm(f => ({ ...f, oss: e.target.checked }))} />
                <span>{t('The company has joined the One Stop Shop (OSS): charge people in other EU countries the VAT of their own country')}</span>
              </label>
            ) : <p className="text-sm text-ink/60">{t('An invoicing service takes only Romania’s rates, so people in other EU countries are charged Romania’s. The One Stop Shop needs Spine’s own e-Factura link.')}</p>}
            <p className="text-sm text-ink/60">{t('Romania’s rate is {rate}%. The other countries’ rates are in the code, and an invoice keeps the rate it was made with.', { rate: loaded.romania_rate })}</p>
            {!loaded.seller_has_vat_id && <p className="text-sm text-amber-700">{t('Save the company’s VAT id with the seller first: an invoice with VAT carries it.')}</p>}
          </div>
        )}
        {canEdit && (
          <div className="mt-5 flex items-center gap-3">
            <button type="submit" className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-paper hover:bg-accent/90">{t('Save')}</button>
            {message && <p role="status" className={`text-sm ${message.error ? 'text-red-700' : 'text-green-700'}`}>{message.text}</p>}
          </div>
        )}
        {!canEdit && message && <Notice kind="error">{message.text}</Notice>}
      </form>
    </section>
  );
}
