import { useMemo, useState, type FormEvent } from 'react';
import { BUCHAREST, COUNTRIES, RO_COUNTIES, billingDetailsSchema, type BillingDetails } from 'spine-core/billing/billing-details';
import { api } from '../api';
import { useI18n } from '../i18n';
import { buttonClass, inputClass, Notice } from './AuthCard';

/**
 * Who an invoice is made out to, asked before a purchase where the operator issues the invoices (docs/billing.md). A buyer in Romania also gives a county (and a
 * sector in Bucharest), which e-Factura cannot do without and the payment provider's page does not ask for. The details are kept with the payment provider and
 * only read back here to fill the form again.
 */
type Draft = Partial<Record<keyof BillingDetails, string>>;

/** A first guess at the country: the language the screens are in where it belongs to one country, else the browser's region. The person chooses; nothing is assumed. */
function guessCountry(lang: string): string {
  if (lang === 'ro') return 'RO';
  if (lang === 'fr') return 'FR';
  if (lang === 'de') return 'DE';
  const region = typeof navigator === 'undefined' ? '' : /-([A-Za-z]{2})\b/.exec(navigator.language)?.[1]?.toUpperCase() ?? '';
  return COUNTRIES.includes(region) ? region : '';
}

export default function BillingDetailsForm({ initial, onSaved, onCancel }: { initial: BillingDetails | null; onSaved: () => void; onCancel: () => void }) {
  const { t, lang } = useI18n();
  const [v, setV] = useState<Draft>(initial ?? { country: guessCountry(lang) });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const countries = useMemo(() => {
    let names: Intl.DisplayNames;
    try { names = new Intl.DisplayNames([lang], { type: 'region' }); } catch { names = new Intl.DisplayNames(['en'], { type: 'region' }); }
    return COUNTRIES.map(code => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, lang));
  }, [lang]);
  const set = (key: keyof BillingDetails) => (e: { target: { value: string } }) => setV(d => ({ ...d, [key]: e.target.value }));
  const romania = v.country === 'RO';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    // What is only asked in Romania is not sent from anywhere else, and a field left empty is not sent at all.
    const candidate = Object.fromEntries(Object.entries({ ...v, county: romania ? v.county : undefined, sector: romania && v.county === BUCHAREST ? v.sector : undefined })
      .filter(([, value]) => typeof value === 'string' && value.trim() !== ''));
    const parsed = billingDetailsSchema.safeParse(candidate);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      setError(field === 'county' ? t('Choose a county; an address in Romania needs one.') : field === 'sector' ? t('Choose the sector (1 to 6); an address in Bucharest needs one.') : t('Fill in the name, country, city and street.'));
      return;
    }
    setBusy(true);
    try {
      await api.billing.saveDetails(parsed.data);
      onSaved();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('Could not save the billing details'));
      setBusy(false);
    }
  };

  const label = 'block text-sm text-gray-700 mb-1';
  return (
    <form onSubmit={submit} className="space-y-1">
      <h2 className="font-medium text-gray-900 mb-1">{t('Billing details')}</h2>
      <p className="text-sm text-gray-500 mb-3">{t('Your invoice is made out to this name and address. They are kept with the payment provider, not by Spine.')}</p>
      <label className={label} htmlFor="bd-name">{t('Name (a person or a company)')}</label>
      <input id="bd-name" autoComplete="name" value={v.name ?? ''} onChange={set('name')} className={inputClass} />
      <label className={label} htmlFor="bd-country">{t('Country')}</label>
      <select id="bd-country" autoComplete="country" value={v.country ?? ''} onChange={e => setV(d => ({ ...d, country: e.target.value, county: undefined, sector: undefined }))} className={inputClass}>
        <option value="" disabled>{t('Country')}</option>
        {countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
      {romania && (
        <>
          <label className={label} htmlFor="bd-county">{t('County')}</label>
          <select id="bd-county" value={v.county ?? ''} onChange={e => setV(d => ({ ...d, county: e.target.value, sector: undefined }))} className={inputClass}>
            <option value="" disabled>{t('Choose a county')}</option>
            {RO_COUNTIES.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </>
      )}
      {romania && v.county === BUCHAREST && (
        <>
          <label className={label} htmlFor="bd-sector">{t('Sector')}</label>
          <select id="bd-sector" value={v.sector ?? ''} onChange={set('sector')} className={inputClass}>
            <option value="" disabled>{t('Choose a sector')}</option>
            {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={String(n)}>{n}</option>)}
          </select>
        </>
      )}
      <label className={label} htmlFor="bd-city">{t('City')}</label>
      <input id="bd-city" autoComplete="address-level2" value={v.city ?? ''} onChange={set('city')} className={inputClass} />
      <label className={label} htmlFor="bd-address">{t('Street and number')}</label>
      <input id="bd-address" autoComplete="address-line1" value={v.address ?? ''} onChange={set('address')} className={inputClass} />
      <label className={label} htmlFor="bd-postal">{t('Postal code (optional)')}</label>
      <input id="bd-postal" autoComplete="postal-code" value={v.postalCode ?? ''} onChange={set('postalCode')} className={inputClass} />
      <label className={label} htmlFor="bd-tax">{t('Company tax ID, if you are buying as a company (optional)')}</label>
      <input id="bd-tax" value={v.taxId ?? ''} onChange={set('taxId')} className={inputClass} />
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" disabled={busy} className={buttonClass}>{busy ? t('Saving…') : t('Save and continue')}</button>
      <button type="button" disabled={busy} onClick={onCancel} className="mt-2 text-sm text-brand-600 hover:underline">{t('Cancel')}</button>
    </form>
  );
}
