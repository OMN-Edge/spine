import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LanguageSwitcher, useI18n } from '../i18n';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { openPart } from '../core/share/keys';
import { normaliseCard, cardIsEmpty, type CardContent } from 'spine-core/emergency';

const keyName = (id: string) => `spine-card-key:${id}`;

/** The key in the address after the `#`, read once and taken out of the address bar; kept for this tab so a reload still opens it. */
function keyFor(id: string): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (/^[A-Za-z0-9_-]{43}$/.test(hash)) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    try { sessionStorage.setItem(keyName(id), hash); } catch { /* a private window: the code is scanned again */ }
    return hash;
  }
  try { return sessionStorage.getItem(keyName(id)); } catch { return null; }
}

/** Only what a phone can dial: digits, a leading plus and the usual separators. */
const dialable = (phone: string) => (/^\+?[\d\s().-]{3,40}$/.test(phone) ? `tel:${phone.replace(/[^\d+]/g, '')}` : null);

/**
 * What someone sees who scans the owner's emergency card (FR-EMG, SECURITY.md **M-47**): the card, opened in this browser with the key in the
 * address, with no account and no question asked. It says who wrote it, tells the reader what Spine is, in their language, and lets the
 * server know it was opened (a count and a country, for the owner). Nothing here is medical advice.
 */
export default function CardView({ id }: { id: string }) {
  const { t } = useI18n();
  const [card, setCard] = useState<CardContent | null>(null);
  const [state, setState] = useState<'loading' | 'gone' | 'locked'>('loading');

  useEffect(() => {
    let live = true;
    void (async () => {
      const key = keyFor(id);
      if (!key) return live && setState('locked');
      try {
        const res = await fetch(`/api/shared/${encodeURIComponent(id)}/bundle`);
        if (!res.ok) return live && setState('gone');
        const plain = await openPart(key, id, 'card', new Uint8Array(await res.arrayBuffer()));
        if (!live) return;
        setCard(normaliseCard(JSON.parse(new TextDecoder().decode(plain))));
        // Said once the card is open; the owner is told when and from which country, never from which address.
        void fetch(`/api/shared/${encodeURIComponent(id)}/opened`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
      } catch {
        if (live) setState('locked');
      }
    })();
    return () => { live = false; };
  }, [id]);

  const section = (label: string, items: string[]) => items.length === 0 ? null : (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</h2>
      <ul className="mt-1 text-gray-900 space-y-0.5">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </section>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-md mx-auto px-4 py-6">
        <div className="flex justify-end gap-2 mb-4"><LanguageSwitcher /><ThemeSwitcher /></div>
        {state !== 'loading' && !card && (
          <div className="bg-white border border-gray-200 rounded-xl p-6 text-center">
            <p className="text-gray-900 font-medium mb-1">{t('This card is not available.')}</p>
            <p className="text-sm text-gray-500">{state === 'locked' ? t('Scan the code on the card again, or ask its owner.') : t('Its owner may have turned it off.')}</p>
          </div>
        )}
        {state === 'loading' && !card && <p className="text-center text-gray-400">{t('Loading…')}</p>}
        {card && (
          <article className="bg-white border-2 border-red-500 rounded-xl p-5 space-y-4">
            <header>
              <p className="text-xs font-semibold uppercase tracking-wide text-red-600">{t('Emergency card')}</p>
              <h1 className="text-2xl text-gray-900">{card.name || t('Name not given')}</h1>
              <p className="text-sm text-gray-600">{[card.born && `${t('Born')} ${card.born}`, card.blood_type && `${t('Blood type')} ${card.blood_type}`].filter(Boolean).join(' · ')}</p>
            </header>
            {cardIsEmpty(card) && <p className="text-gray-500">{t('Nothing is written on this card.')}</p>}
            {section(t('Allergies'), card.allergies)}
            {section(t('Medications'), card.medications)}
            {section(t('Conditions'), card.conditions)}
            {card.contacts.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t('Emergency contacts')}</h2>
                <ul className="mt-1 space-y-1">
                  {card.contacts.map((c, i) => {
                    const href = dialable(c.phone);
                    return <li key={i} className="text-gray-900">{c.name}{c.relation && ` (${c.relation})`}{c.phone && <> · {href ? <a href={href} className="text-brand-600 underline">{c.phone}</a> : c.phone}</>}</li>;
                  })}
                </ul>
              </section>
            )}
            {card.notes && <section><h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t('Notes')}</h2><p className="mt-1 text-gray-900 whitespace-pre-wrap">{card.notes}</p></section>}
            <p className="text-xs text-gray-500 border-t border-gray-100 pt-3">{t('The owner of this card wrote it. Check what it says with them, or with a doctor, before you rely on it.')}</p>
          </article>
        )}
        <aside className="mt-6 text-xs text-gray-500 text-center">
          <p>{t('Spine keeps a person’s medical records so that only they can open them, and lets them show a doctor exactly what they choose. This card is part of it.')}</p>
          <p className="mt-2"><Link to="/?ref=card" className="underline">{t('Learn about Spine')}</Link></p>
        </aside>
      </div>
    </div>
  );
}
