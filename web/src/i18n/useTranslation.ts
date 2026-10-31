import { useEffect, useState } from 'react';
import type { TranslatedDocument } from '../api';
import { LANGUAGES, useI18n } from './index';

/** A language's name for a person: its own name where the interface knows it, else the code. */
export const languageName = (code: string | null | undefined): string =>
  LANGUAGES.find(l => l.code === code)?.name ?? (code ? code.toUpperCase() : '');

/** A country's name in the interface language, from its ISO code ("RO" is "Romania"); null when there is none. */
export const countryName = (code: string | null | undefined, lang: string): string | null => {
  if (!code) return null;
  try { return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? code; } catch { return code; }
};

/**
 * A document in the reader's language, in two steps: the title, summary, notes and specialties first (`head`, one short
 * model call), then the fields and results (`full`). `translation` is null until it is ready (or when none applies);
 * what to show meanwhile is the original, so the page is never empty and never waits.
 *
 * `status: same` means the document is already in the reader's language, and `off` that translating is switched
 * off on this server: neither changes anything on screen, so `active` is false for both.
 */
export function useTranslation(
  key: string | null,
  load: (lang: string, part: 'head' | 'full') => Promise<TranslatedDocument>,
  /** What is already kept, if anything, without making one: given, the page shows that it is waiting only when there is nothing kept. */
  kept?: (lang: string) => Promise<TranslatedDocument | null>,
) {
  const { lang } = useI18n();
  const [translation, setTranslation] = useState<TranslatedDocument | null>(null);
  const [state, setState] = useState<'idle' | 'working' | 'failed' | 'partial'>('idle');
  const [showOriginal, setShowOriginal] = useState(false);

  useEffect(() => {
    setTranslation(null);
    setShowOriginal(false);
    if (!key) { setState('idle'); return; }
    let live = true;
    // The short parts first, so the page is in the reader's language after one quick call; the fields and results
    // replace them when the rest is ready. A failure of the second leaves the first on screen.
    const make = () => {
      setState('working');
      let delivered = false;
      load(lang, 'head')
        .then(result => { if (live) { delivered = true; setTranslation(current => (current?.part === 'full' ? current : result)); } })
        .catch(() => {});
      load(lang, 'full')
        .then(result => { if (live) { setTranslation(result); setState('idle'); } })
        .catch(() => { if (live) setState(delivered ? 'partial' : 'failed'); });
    };
    if (!kept) { make(); return () => { live = false; }; }
    setState('idle');
    kept(lang)
      .then(found => { if (!live) return; if (found) setTranslation(found); else make(); })
      .catch(() => { if (live) make(); });
    return () => { live = false; };
    // `load` is a new function each render; what identifies the request is the document and the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, lang]);

  const active = !!translation && translation.status !== 'same' && translation.status !== 'off';
  return {
    translation,
    /** The translation is what to show now. */
    showing: active && !showOriginal,
    /** A translation exists to show or hide. */
    active,
    translating: state === 'working',
    failed: state === 'failed',
    /** The title and summary were translated but the fields and results could not be. */
    partial: state === 'partial',
    showOriginal,
    setShowOriginal,
  };
}
