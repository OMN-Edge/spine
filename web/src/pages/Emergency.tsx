import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type EmergencyView } from '../api';
import { DETAIL_LABELS } from '../detailLabels';
import { DETAIL_KINDS, EMPTY_CARD, publicCard, type CardContent, type CardDetail } from 'spine-core/emergency';
import PrintCard, { printCard } from '../components/PrintCard';
import CardQr from '../components/CardQr';
import { buttonClass, inputClass, Notice } from '../components/AuthCard';
import { useI18n } from '../i18n';

/** One item to a line; the card keeps them as a list. */
const lines = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);

/**
 * The owner's emergency card (FR-EMG, SECURITY.md **M-47**): what someone who has to help them quickly should know, written by the owner and
 * nothing else. Turned on, it is a sealed copy that anyone with its address (the QR code) can read without asking; an offline code holds the
 * card itself as plain text. Both say, before they are made, that whoever sees the code reads the card.
 */
export default function Emergency() {
  const { t, tn } = useI18n();
  const [view, setView] = useState<EmergencyView | null>(null);
  const [card, setCard] = useState<CardContent>(EMPTY_CARD);
  const [text, setText] = useState({ allergies: '', conditions: '', medications: '' });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [replacing, setReplacing] = useState(false);

  const show = (v: EmergencyView) => {
    setView(v);
    setCard(v.card);
    setText({ allergies: v.card.allergies.join('\n'), conditions: v.card.conditions.join('\n'), medications: v.card.medications.join('\n') });
  };
  useEffect(() => { api.emergency.get().then(show).catch(() => setError(t('Could not load the card'))); }, [t]);

  const current = (): CardContent => ({ ...card, allergies: lines(text.allergies), conditions: lines(text.conditions), medications: lines(text.medications) });
  const run = async (what: () => Promise<EmergencyView>, failed: string) => {
    setError(''); setSaved(false); setBusy(true);
    try { show(await what()); return true; } catch (err) {
      setError(err instanceof ApiError && err.code === 'empty' ? t('Write something on the card first.') : failed);
      return false;
    } finally { setBusy(false); }
  };
  const save = async () => { if (await run(() => api.emergency.save(current()), t('Could not save the card'))) setSaved(true); };
  const set = <K extends keyof CardContent>(key: K, value: CardContent[K]) => { setSaved(false); setCard(c => ({ ...c, [key]: value })); };
  const setDetail = (n: number, change: Partial<CardDetail>) => set('details', card.details.map((d, i) => i === n ? { ...d, ...change } : d));
  const setContact = (n: number, key: 'name' | 'relation' | 'phone', value: string) => set('contacts', card.contacts.map((c, i) => i === n ? { ...c, [key]: value } : c));

  if (!view) return <p className="text-gray-500">{error || t('Loading…')}</p>;
  const on = !!view.published;

  return (
    <div className="max-w-xl mx-auto">
      <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900 mb-1">{t('Emergency card')}</h1>
      <p className="text-sm text-gray-500 mb-6">{t('A short card for someone who has to help you quickly: what they must know first. You write it yourself, and only what you write is on it.')}</p>

      {view.review_due && (
        <div role="status" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">{t('It has been over a year since this card was checked.')}</p>
          <p className="mt-1">{t('Medicines, allergies and phone numbers change. Look it over, change what is out of date, then say it is still right.')}</p>
          <button disabled={busy} className="mt-2 underline" onClick={() => void run(() => api.emergency.reviewed(), t('Could not save this change'))}>{t('It is still right')}</button>
        </div>
      )}
      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <label className="block text-sm text-gray-700">{t('Name')}<input className={inputClass} value={card.name} maxLength={120} onChange={e => set('name', e.target.value)} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-gray-700">{t('Born (year or date)')}<input className={inputClass} value={card.born} maxLength={10} onChange={e => set('born', e.target.value)} /></label>
          <label className="block text-sm text-gray-700">{t('Blood type')}<input className={inputClass} value={card.blood_type} maxLength={5} onChange={e => set('blood_type', e.target.value)} /></label>
        </div>
        {([['allergies', 'Allergies'], ['medications', 'Medications'], ['conditions', 'Conditions']] as const).map(([key, label]) => (
          <label key={key} className="block text-sm text-gray-700">{t(label)}
            <textarea className={`${inputClass} h-20`} placeholder={t('One to a line')} value={text[key]} onChange={e => { setSaved(false); setText(x => ({ ...x, [key]: e.target.value })); }} />
          </label>
        ))}
        <fieldset>
          <legend className="text-sm text-gray-700 mb-1">{t('Emergency contacts')}</legend>
          {card.contacts.map((c, n) => (
            <div key={n} className="grid grid-cols-3 gap-2 mb-2">
              <input aria-label={t('Contact name')} placeholder={t('Contact name')} className={inputClass} value={c.name} maxLength={80} onChange={e => setContact(n, 'name', e.target.value)} />
              <input aria-label={t('Relation')} placeholder={t('Relation')} className={inputClass} value={c.relation} maxLength={40} onChange={e => setContact(n, 'relation', e.target.value)} />
              <input aria-label={t('Phone')} placeholder={t('Phone')} className={inputClass} value={c.phone} maxLength={40} onChange={e => setContact(n, 'phone', e.target.value)} />
            </div>
          ))}
          {card.contacts.length < 5 && <button type="button" className="text-sm text-brand-600 hover:underline" onClick={() => set('contacts', [...card.contacts, { name: '', relation: '', phone: '' }])}>{t('Add a contact')}</button>}
        </fieldset>
        <fieldset>
          <legend className="text-sm text-gray-700 mb-1">{t('Official details')}</legend>
          <p className="text-xs text-gray-500 mb-2">{t('Numbers that identify you, such as a national identification number or health insurance. They are kept here, sealed with everything else, and are on the card only where you tick the box. Anyone who reads the card reads what is ticked.')}</p>
          {card.details.map((d, n) => (
            <div key={n} className="mb-2 border border-gray-100 rounded-lg p-2 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <select aria-label={t('What it is')} className={inputClass} value={d.kind} onChange={e => setDetail(n, { kind: e.target.value as CardDetail['kind'] })}>
                  {DETAIL_KINDS.map(k => <option key={k} value={k}>{k === 'other' ? t('Something else') : t(DETAIL_LABELS[k])}</option>)}
                </select>
                {d.kind === 'other'
                  ? <input aria-label={t('Label')} placeholder={t('Label')} className={inputClass} value={d.label} maxLength={40} onChange={e => setDetail(n, { label: e.target.value })} />
                  : <span />}
              </div>
              <input aria-label={t('Number or value')} placeholder={t('Number or value')} className={inputClass} value={d.value} maxLength={60} onChange={e => setDetail(n, { value: e.target.value })} />
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={d.on_card} onChange={e => setDetail(n, { on_card: e.target.checked })} />{t('Put it on the card')}</label>
                <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => set('details', card.details.filter((_, i) => i !== n))}>{t('Remove')}</button>
              </div>
            </div>
          ))}
          {card.details.length < 8 && <button type="button" className="text-sm text-brand-600 hover:underline" onClick={() => set('details', [...card.details, { kind: 'national_id', label: '', value: '', on_card: false }])}>{t('Add a detail')}</button>}
        </fieldset>
        <label className="block text-sm text-gray-700">{t('Notes')}<textarea className={`${inputClass} h-20`} maxLength={500} value={card.notes} onChange={e => set('notes', e.target.value)} /></label>
        {error && <Notice kind="error">{error}</Notice>}
        {saved && <Notice kind="ok">{t('Saved')}</Notice>}
        <button disabled={busy} onClick={() => void save()} className={buttonClass}>{t('Save the card')}</button>
      </section>

      <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
        <h2 className="font-medium text-gray-900 mb-1">{on ? t('The card is on') : t('Turn the card on')}</h2>
        <p className="text-sm text-gray-500 mb-3">{t('When it is on, anyone who has the address or scans the code can read the card, without asking you and without signing in. You are told when it is opened. Turn it off and the address stops working; a card already seen may have been copied.')}</p>
        {on && view.published ? (
          <div className="space-y-3">
            <CardQr text={view.published.address} label={t('Code that opens the card')} />
            <p className="text-xs text-gray-500 break-all">{view.published.address}</p>
            {view.reviewed_at && <p className="text-xs text-gray-500">{t('Last checked {when}', { when: new Date(view.reviewed_at).toLocaleDateString() })}</p>}
            <div className="flex gap-4 text-sm">
              <button className="text-brand-600 hover:underline" onClick={printCard}>{t('Print a card-sized copy')}</button>
              <button disabled={busy} className="text-red-600 hover:underline" onClick={() => void run(() => api.emergency.unpublish(), t('Could not turn the card off'))}>{t('Turn the card off')}</button>
            </div>
            <div className="border-t border-gray-100 pt-3 text-sm">
              <p className="font-medium text-gray-800">{t('Lost the card?')}</p>
              <p className="text-gray-500 mt-1">{t('Make a new code: the old one stops opening the card at once, and you print the new one. A code that holds the card itself (the one that works with no signal) cannot be replaced, so do not print that one if you might lose it.')}</p>
              {replacing
                ? <button disabled={busy} className="mt-2 text-red-600 hover:underline" onClick={() => void run(async () => { const v = await api.emergency.replace(); setReplacing(false); return v; }, t('Could not make a new code'))}>{t('Yes, turn the old code off and make a new one')}</button>
                : <button className="mt-2 text-brand-600 hover:underline" onClick={() => setReplacing(true)}>{t('Make a new code')}</button>}
            </div>
          </div>
        ) : (
          <button disabled={busy} className={buttonClass} onClick={() => void run(() => api.emergency.publish(), t('Could not turn the card on'))}>{t('Turn the card on')}</button>
        )}
      </section>

      <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
        <h2 className="font-medium text-gray-900 mb-1">{t('Code that works with no signal')}</h2>
        <p className="text-sm text-gray-500 mb-3">{t('This code holds the card itself, as plain text, so any phone can read it with no signal. Anyone who sees the code reads what is on it, and it cannot be turned off or counted. Print it only if you accept that.')}</p>
        {!offline ? <button className="text-sm text-brand-600 hover:underline" onClick={() => setOffline(true)}>{t('Show the code')}</button> : (
          <div className="space-y-2">
            <CardQr text={view.offline.text} level="L" label={t('Code that holds the card')} />
            {view.offline.omitted > 0 && <Notice kind="error">{tn(view.offline.omitted, '{n} item did not fit in the code and was left out.', '{n} items did not fit in the code and were left out.')}</Notice>}
            <p className="text-xs text-gray-500">{t('It shows what was last saved.')}</p>
            {!on && <button className="text-sm text-brand-600 hover:underline" onClick={printCard}>{t('Print a card-sized copy')}</button>}
          </div>
        )}
      </section>

      <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
        <h2 className="font-medium text-gray-900 mb-2">{t('When the card was opened')}</h2>
        {view.scans.length === 0 ? <p className="text-sm text-gray-500">{t('It has not been opened yet.')}</p> : (
          <ul className="text-sm text-gray-700 divide-y divide-gray-100">
            {view.scans.map(s => <li key={s.id} className="py-1">{new Date(s.at).toLocaleString()}{s.country ? ` · ${s.country}` : ''}</li>)}
          </ul>
        )}
      </section>
      <PrintCard card={publicCard(view.card)} qr={view.published ? { text: view.published.address, online: true } : { text: view.offline.text, online: false }} />
      <p className="mt-6 text-sm"><Link to="/share" className="text-brand-600 hover:underline">{t('Share links')}</Link></p>
    </div>
  );
}
