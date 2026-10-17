import { useEffect, useState } from 'react';
import type { TranslatedDocument } from '../api';
import { LANGUAGES, useI18n } from './index';

/** A language's name for a person: its own name where the interface knows it, else the code. */
export const languageName = (code: string | null | undefined): string =>
  LANGUAGES.find(l => l.code === code)?.name ?? (code ? code.toUpperCase() : '');

/**
 * A document in the reader's language, in two steps: the title, summary, notes and specialties first (`head`, one short
 * model call), then the fields and results (`full`). `translation` is null until it is ready (or when none applies);
 * what to show meanwhile is the original, so the page is never empty and never waits.
 *
 * `status: same` means the document is already in the reader's language, and `off` that translating is switched
 * off on this server: neither changes anything on screen, so `active` is false for both.
 */
export function useTranslation(key: string | null, load: (lang: string, part: 'head' | 'full') => Promise<TranslatedDocument>) {
  const { lang } = useI18n();
  const [translation, setTranslation] = useState<TranslatedDocument | null>(null);
  const [state, setState] = useState<'idle' | 'working' | 'failed'>('idle');
  const [showOriginal, setShowOriginal] = useState(false);

  useEffect(() => {
    setTranslation(null);
    setShowOriginal(false);
    if (!key) { setState('idle'); return; }
    let live = true;
    setState('working');
    // The short parts first, so the page is in the reader's language after one quick call; the fields and results
    // replace them when the rest is ready. A failure of the second leaves the first on screen.
    let delivered = false;
    load(lang, 'head')
      .then(result => { if (live) { delivered = true; setTranslation(current => (current?.part === 'full' ? current : result)); } })
      .catch(() => {});
    load(lang, 'full')
      .then(result => { if (live) { setTranslation(result); setState('idle'); } })
      .catch(() => { if (live) setState(delivered ? 'idle' : 'failed'); });
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
    showOriginal,
    setShowOriginal,
  };
}
