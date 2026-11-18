import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type EmergencyView } from '../api';
import { DETAIL_LABELS } from '../detailLabels';
import { CARD_LANGUAGES, cardText, DETAIL_KINDS, EMPTY_CARD, publicCard, type CardContent, type CardDetail } from 'spine-core/emergency';
import { BLOOD_TYPES, proposalsFrom, type Proposals } from '../emergency-fill';
import PrintCard, { printCard } from '../components/PrintCard';
import CardQr from '../components/CardQr';
import { buttonClass, inputClass, Notice } from '../components/AuthCard';
import { Combobox } from '../components/Combobox';
import { DateInput } from '../components/DateInput';
import { languageChoice, useI18n } from '../i18n';
import { useFormat } from '../format';

/** One item to a line; the card keeps them as a list. */
const lines = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);

/**
 * The owner's emergency card (FR-EMG, SECURITY.md **M-47**): what someone who has to help them quickly should know, written by the owner and
 * nothing else. Turned on, it is a sealed copy that anyone with its address (the QR code) can read without asking; an offline code holds the
 * card itself as plain text. Both say, before they are made, that whoever sees the code reads the card.
 */
export default function Emergency() {
  const { t, tn } = useI18n();
  const format = useFormat();
  const [view, setView] = useState<EmergencyView | null>(null);
  const [card, setCard] = useState<CardContent>(EMPTY_CARD);
  const [text, setText] = useState({ allergies: '', conditions: '', medications: '' });
  // The second language's words, one to a line like the first's; kept with the card when saved.
  const [second, setSecond] = useState<{ language: string; allergies: string; conditions: string; medications: string; notes: string } | null>(null);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [replacing, setReplacing] = useState(false);

  const show = (v: EmergencyView) => {
    setView(v);
    setCard(v.card);
    setText({ allergies: v.card.allergies.join('\n'), conditions: v.card.conditions.join('\n'), medications: v.card.medications.join('\n') });
    setSecond(v.card.second ? { language: v.card.second.language, allergies: v.card.second.allergies.join('\n'), conditions: v.card.second.conditions.join('\n'), medications: v.card.second.medications.join('\n'), notes: v.card.second.notes } : null);
  };
  useEffect(() => { api.emergency.get().then(show).catch(() => setError(t('Could not load the card'))); }, [t]);

  const current = (): CardContent => ({
    ...card, allergies: lines(text.allergies), conditions: lines(text.conditions), medications: lines(text.medications),
    second: second && second.language ? { language: second.language as CardContent['language'] & ('en' | 'ro' | 'fr' | 'de'), allergies: lines(second.allergies), conditions: lines(second.conditions), medications: lines(second.medications), notes: second.notes } : null,
  });
  const run = async (what: () => Promise<EmergencyView>, failed: string) => {
    setError(''); setSaved(false); setBusy(true);
    try { show(await what()); return true; } catch (err) {
      setError(err instanceof ApiError && err.code === 'empty' ? t('Write something on the card first.') : err instanceof ApiError && err.code === 'old_off' ? t('The old code is turned off, but the new one could not be made. Turn the card on again.') : failed);
      // What the server did before it failed (the old code turned off) is what the page should show.
      void api.emergency.get().then(show).catch(() => undefined);
      return false;
    } finally { setBusy(false); }
  };
  // Asks for the card's words in the language chosen: the card is saved first (it is what is translated), the answer is shown for the owner to correct, and nothing of it is kept until they save.
  const translate = async () => {
    if (!second?.language) return;
    setError(''); setTranslating(true);
    try {
      await api.emergency.save(current());
      const done = await api.emergency.translate(second.language);
      setSecond({ language: done.second.language, allergies: done.second.allergies.join('\n'), conditions: done.second.conditions.join('\n'), medications: done.second.medications.join('\n'), notes: done.second.notes });
      setSaved(false);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'translation_off' ? t('Translation is switched off here: write the second language yourself.') : t('The card could not be translated right now. You can write the second language yourself.'));
    } finally { setTranslating(false); }
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
          <label className="block text-sm text-gray-700">{t('Born (year or date)')}<DateInput className={inputClass} value={card.born} onChange={born => set('born', born)} max={new Date().toISOString().slice(0, 10)} /></label>
          <label className="block text-sm text-gray-700">{t('Blood type')}
            <Combobox ariaLabel={t('Blood type')} value={card.blood_type} onChange={v => set('blood_type', v)} className={inputClass}
              options={[{ value: '', label: t('Not known') }, ...BLOOD_TYPES.map(b => ({ value: b, label: b })), ...(card.blood_type && !(BLOOD_TYPES as readonly string[]).includes(card.blood_type) ? [{ value: card.blood_type, label: card.blood_type }] : [])]} />
          </label>
        </div>
        <FillFromRecords already={{ medications: lines(text.medications), conditions: lines(text.conditions) }} onAdd={added => { setSaved(false); setText(x => ({ ...x, medications: [...lines(x.medications), ...added.medications].join('\n'), conditions: [...lines(x.conditions), ...added.conditions].join('\n') })); }} />
        {([['allergies', 'Allergies'], ['medications', 'Medications'], ['conditions', 'Conditions']] as const).map(([key, label]) => (
          <label key={key} className="block text-sm text-gray-700">{t(label)}
            <textarea className={`${inputClass} h-20`} placeholder={t('One to a line')} value={text[key]} onChange={e => { setSaved(false); setText(x => ({ ...x, [key]: e.target.value })); }} />
          </label>
        ))}
        <fieldset>
          <legend className="text-sm text-gray-700 mb-1">{t('Emergency contacts')}</legend>
          {card.contacts.map((c, n) => (
            <div key={n} className="grid grid-cols-1 sm:grid-cols-3 gap-x-2 mb-2">
              <input aria-label={t('Contact name')} placeholder={t('Contact name')} className={`${inputClass} text-sm`} value={c.name} maxLength={80} onChange={e => setContact(n, 'name', e.target.value)} />
              <input aria-label={t('Relation')} placeholder={t('Relation')} className={`${inputClass} text-sm`} value={c.relation} maxLength={40} onChange={e => setContact(n, 'relation', e.target.value)} />
              <input aria-label={t('Phone')} placeholder={t('Phone')} className={`${inputClass} text-sm`} value={c.phone} maxLength={40} onChange={e => setContact(n, 'phone', e.target.value)} />
            </div>
          ))}
          {card.contacts.length < 5 && <button type="button" className="text-sm text-brand-600 hover:underline" onClick={() => set('contacts', [...card.contacts, { name: '', relation: '', phone: '' }])}>{t('Add a contact')}</button>}
        </fieldset>
        <fieldset>
          <legend className="text-sm text-gray-700 mb-1">{t('Official details')}</legend>
          <p className="text-xs text-gray-500 mb-2">{t('Numbers that identify you, such as a national identification number or health insurance. They are kept here, sealed with everything else, and are on the card only where you tick the box. Anyone who reads the card reads what is ticked.')}</p>
          {card.details.map((d, n) => (
            <div key={n} className="mb-2 border border-gray-100 rounded-lg p-2 space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Combobox ariaLabel={t('What it is')} value={d.kind} onChange={v => setDetail(n, { kind: v as CardDetail['kind'] })} options={DETAIL_KINDS.map(k => ({ value: k, label: k === 'other' ? t('Something else') : t(DETAIL_LABELS[k]) }))} />
                {d.kind === 'other'
                  ? <input aria-label={t('Label')} placeholder={t('Label')} className={`${inputClass} text-sm`} value={d.label} maxLength={40} onChange={e => setDetail(n, { label: e.target.value })} />
                  : <span />}
              </div>
              <input aria-label={t('Number or value')} placeholder={t('Number or value')} className={`${inputClass} text-sm`} value={d.value} maxLength={60} onChange={e => setDetail(n, { value: e.target.value })} />
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={d.on_card} onChange={e => setDetail(n, { on_card: e.target.checked })} />{t('Put it on the card')}</label>
                <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => set('details', card.details.filter((_, i) => i !== n))}>{t('Remove')}</button>
              </div>
            </div>
          ))}
          {card.details.length < 8 && <button type="button" className="text-sm text-brand-600 hover:underline" onClick={() => set('details', [...card.details, { kind: 'national_id', label: '', value: '', on_card: false }])}>{t('Add a detail')}</button>}
        </fieldset>
        <label className="block text-sm text-gray-700">{t('Notes')}<textarea className={`${inputClass} h-20`} maxLength={500} value={card.notes} onChange={e => set('notes', e.target.value)} /></label>
        <fieldset className="rounded-lg border border-gray-200 p-3 space-y-3">
          <legend className="px-1 text-sm text-gray-700">{t('A second language')}</legend>
          <p className="text-xs text-gray-500">{t('So a paramedic who does not read your language can read the card. Your allergies, conditions, medicines and notes are translated once by the model when you ask, shown here for you to correct, and kept as your words. Names and phone numbers are not translated.')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Combobox ariaLabel={t('Second language')} wrapperClassName="relative w-48" value={second?.language ?? ''} onChange={v => { setSaved(false); setSecond(v ? { language: v, allergies: second?.allergies ?? '', conditions: second?.conditions ?? '', medications: second?.medications ?? '', notes: second?.notes ?? '' } : null); }}
              options={[{ value: '', label: t('None') }, ...CARD_LANGUAGES.filter(l => l !== card.language).map(l => ({ value: l, label: languageChoice(l) }))]} />
            {second?.language && <button type="button" disabled={translating || busy} onClick={() => void translate()} className="rounded-full border border-gray-300 px-4 py-1.5 text-sm text-gray-800 hover:bg-gray-50 disabled:opacity-50">{translating ? t('Translating…') : t('Translate the card')}</button>}
          </div>
          {second?.language && (['allergies', 'medications', 'conditions'] as const).map(key => (
            <label key={key} className="block text-sm text-gray-700">{t(key === 'allergies' ? 'Allergies' : key === 'medications' ? 'Medications' : 'Conditions')} ({languageChoice(second.language as 'en')})
              <textarea className={`${inputClass} h-16`} placeholder={t('One to a line')} value={second[key]} onChange={e => { setSaved(false); setSecond(x => (x ? { ...x, [key]: e.target.value } : x)); }} />
            </label>
          ))}
          {second?.language && <label className="block text-sm text-gray-700">{t('Notes')} ({languageChoice(second.language as 'en')})<textarea className={`${inputClass} h-16`} maxLength={500} value={second.notes} onChange={e => { setSaved(false); setSecond(x => (x ? { ...x, notes: e.target.value } : x)); }} /></label>}
        </fieldset>
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
            {view.reviewed_at && <p className="text-xs text-gray-500">{t('Last checked {when}', { when: format.date(view.reviewed_at) })}</p>}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <button className="text-brand-600 hover:underline" onClick={() => printCard('home')}>{t('Print at home (A4)')}</button>
              <button className="text-brand-600 hover:underline" onClick={() => printCard('shop')}>{t('Print for a print shop')}</button>
              <button disabled={busy} className="text-red-600 hover:underline" onClick={() => void run(() => api.emergency.unpublish(), t('Could not turn the card off'))}>{t('Turn the card off')}</button>
            </div>
            <p className="text-xs text-gray-500">{t('At home: one page with the steps and the card to cut out and fold. For a print shop: each side on its own page at the size of a bank card, with no lines, to save as a PDF and send to a shop that makes plastic cards.')}</p>
            <div className="border-t border-gray-100 pt-3 text-sm">
              <p className="font-medium text-gray-800">{t('Lost the card?')}</p>
              <p className="text-gray-500 mt-1">{t('Make a new code: the old one stops opening the card at once, and you print the new one. A code that holds the card itself (the one that works with no signal) cannot be replaced, so do not print that one if you might lose it.')}</p>
              {replacing
                ? <button disabled={busy} className="mt-2 text-red-600 hover:underline" onClick={() => void run(async () => { const v = await api.emergency.replace(); setReplacing(false); return v; }, t('Could not make a new code'))}>{t('Yes, turn the old code off and make a new one')}</button>
                : <button className="mt-2 text-brand-600 hover:underline" onClick={() => setReplacing(true)}>{t('Make a new code')}</button>}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <CardPreview card={publicCard(current())} />
            <button disabled={busy} className={buttonClass} onClick={() => void run(() => api.emergency.publish(), t('Could not turn the card on'))}>{t('Turn the card on')}</button>
          </div>
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
            {!on && <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <button className="text-brand-600 hover:underline" onClick={() => printCard('home')}>{t('Print at home (A4)')}</button>
              <button className="text-brand-600 hover:underline" onClick={() => printCard('shop')}>{t('Print for a print shop')}</button>
            </span>}
            {!on && <p className="text-xs text-gray-500">{t('At home: one page with the steps and the card to cut out and fold. For a print shop: each side on its own page at the size of a bank card, with no lines, to save as a PDF and send to a shop that makes plastic cards.')}</p>}
          </div>
        )}
      </section>

      <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
        <h2 className="font-medium text-gray-900 mb-2">{t('When the card was opened')}</h2>
        {view.scans.length === 0 ? <p className="text-sm text-gray-500">{t('It has not been opened yet.')}</p> : (
          <ul className="text-sm text-gray-700 divide-y divide-gray-100">
            {view.scans.map(s => <li key={s.id} className="py-1">{format.dateTime(s.at)}{s.country ? ` · ${s.country}` : ''}</li>)}
          </ul>
        )}
      </section>
      <PrintCard card={publicCard(view.card)} qr={view.published ? { text: view.published.address, online: true } : { text: view.offline.text, online: false }} />
      <p className="mt-6 text-sm"><Link to="/share" className="text-brand-600 hover:underline">{t('Share links')}</Link></p>
    </div>
  );
}


/** What anyone who opens the card will read, as the card says it, before it is turned on: the written text, with the details the owner chose to put on it and none they did not. */
function CardPreview({ card }: { card: CardContent }) {
  const { t } = useI18n();
  const { text } = cardText(card, 4000);
  return (
    <details className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
      <summary className="cursor-pointer text-brand-600">{t('Preview what they will read')}</summary>
      <pre className="mt-2 whitespace-pre-wrap font-sans text-gray-800">{text}</pre>
      <p className="mt-2 text-xs text-gray-500">{t('This is only a preview of what is written now. Nothing is turned on.')}</p>
    </details>
  );
}

/**
 * Offers what the records say, to start from (T-20): the medicines on prescriptions of the last twelve months and the names given to confirmed episodes, each unticked. Nothing is
 * filled in; the owner ticks what is right and adds it to the lists below, where it can be changed like anything they typed.
 */
function FillFromRecords({ already, onAdd }: { already: { medications: string[]; conditions: string[] }; onAdd: (added: Proposals) => void }) {
  const { t } = useI18n();
  const [found, setFound] = useState<Proposals | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const look = async () => {
    setBusy(true); setFailed(false); setTicked(new Set());
    try {
      const prescriptions = await api.documents.listAll({ doc_type: 'prescription' });
      const detailed = await Promise.all(prescriptions.slice(0, 40).map(d => api.documents.get(d.id).catch(() => d)));
      const episodes = await api.episodes.list('confirmed');
      setFound(proposalsFrom(detailed, episodes, already));
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  const toggle = (line: string) => setTicked(s => { const next = new Set(s); if (next.has(line)) next.delete(line); else next.add(line); return next; });
  const add = () => {
    if (!found) return;
    onAdd({ medications: found.medications.filter(l => ticked.has(l)), conditions: found.conditions.filter(l => ticked.has(l)) });
    setFound({ medications: found.medications.filter(l => !ticked.has(l)), conditions: found.conditions.filter(l => !ticked.has(l)) });
    setTicked(new Set());
  };
  const none = found && found.medications.length + found.conditions.length === 0;
  return (
    <div className="rounded-lg border border-dashed border-gray-300 p-3">
      <button type="button" disabled={busy} onClick={() => void look()} className="text-sm text-brand-600 hover:underline disabled:opacity-50">{t('Fill from my records')}</button>
      <p className="text-xs text-gray-500 mt-1">{t('Shows the medicines on your prescriptions of the last year and the episodes you named. Nothing is added until you tick it.')}</p>
      {failed && <p className="text-xs text-red-600 mt-2" role="alert">{t('Could not look through your records.')}</p>}
      {none && <p className="text-xs text-gray-600 mt-2" role="status">{t('Nothing to offer from your records.')}</p>}
      {found && !none && (
        <div className="mt-3 space-y-3">
          {([[t('Medications'), found.medications], [t('Conditions'), found.conditions]] as const).filter(([, list]) => list.length > 0).map(([name, list]) => (
            <fieldset key={name}>
              <legend className="text-xs font-medium text-gray-600">{name}</legend>
              {list.map(line => (
                <label key={line} className="flex items-start gap-2 text-sm text-gray-800">
                  <input type="checkbox" checked={ticked.has(line)} onChange={() => toggle(line)} className="mt-1" />
                  <span className="break-words">{line}</span>
                </label>
              ))}
            </fieldset>
          ))}
          <button type="button" disabled={ticked.size === 0} onClick={add} className="rounded-full border border-gray-300 px-4 py-1.5 text-sm text-gray-800 hover:bg-gray-50 disabled:opacity-50">{t('Add the ticked ones')}</button>
        </div>
      )}
    </div>
  );
}
