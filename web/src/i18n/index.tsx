import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import ro from './ro.json';
import fr from './fr.json';
import de from './de.json';

/**
 * The interface in four languages. The source of every string is its English text, written where it is used:
 * `t('Share links')`. A language file maps an English string to its translation, and a string it does not have
 * is shown in English rather than as a key, so a missing translation is a plain English word and not a hole.
 * `i18n-coverage.test.ts` (in the server's tests, which are the project's only runner) fails when a string used
 * in the source is missing from any language file.
 *
 *   t('Uploaded {date}', { date })                    a string, with values filled in
 *   tn(n, '{n} document', '{n} documents')            the form that fits the number (Romanian has three)
 *   tx('Open {link} now', { link: <Link /> })         a sentence with an element inside it
 *   msg('Timeline')                                    a string kept in a list, shown with t(label)
 */

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ro', name: 'Română' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
] as const;
export type LanguageCode = (typeof LANGUAGES)[number]['code'];

const DICTIONARIES: Record<Exclude<LanguageCode, 'en'>, Record<string, string>> = { ro, fr, de };
const STORAGE_KEY = 'spine.lang';

export const isLanguage = (value: unknown): value is LanguageCode => LANGUAGES.some(l => l.code === value);

/** The language to start in: the one remembered in this browser, else the browser's own, else English. */
export function initialLanguage(preferred?: string | null): LanguageCode {
  if (isLanguage(preferred)) return preferred;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch { /* private window: the browser's language will do */ }
  const browser = (typeof navigator !== 'undefined' ? navigator.language : 'en').slice(0, 2).toLowerCase();
  return isLanguage(browser) ? browser : 'en';
}

/** Marks an English string that is stored now and shown later (in a table of labels): `t(label)` finds its translation. */
export const msg = (english: string) => english;

const fill = (text: string, values?: Record<string, string | number>) =>
  values ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole)) : text;

export interface I18n {
  lang: LanguageCode;
  setLang: (lang: LanguageCode) => void;
  /** Start in this language unless the reader has chosen one in this browser; not remembered as their choice. */
  preferLang: (lang: string | null | undefined) => void;
  t: (english: string, values?: Record<string, string | number>) => string;
  tn: (n: number, one: string, other: string, values?: Record<string, string | number>) => string;
  tx: (english: string, values: Record<string, ReactNode>) => ReactNode;
}

const make = (lang: LanguageCode, setLang: (lang: LanguageCode) => void, preferLang: I18n['preferLang'] = () => {}): I18n => {
  const dictionary = lang === 'en' ? {} : DICTIONARIES[lang];
  const t: I18n['t'] = (english, values) => fill(dictionary[english] ?? english, values);
  const rules = new Intl.PluralRules(lang);
  return {
    lang,
    setLang,
    preferLang,
    t,
    // The forms of a plural are kept as "one|few|other" under the key "one-english|other-english"; a language with
    // no "few" has two, and one with a "few" (Romanian) has three.
    tn: (n, one, other, values) => {
      const forms = (dictionary[`${one}|${other}`] ?? `${one}|${other}`).split('|');
      const category = rules.select(n);
      const form = category === 'one' ? forms[0] : category === 'few' && forms.length > 2 ? forms[1] : forms[forms.length - 1];
      return fill(form, { n, ...values });
    },
    tx: (english, values) => {
      const text = dictionary[english] ?? english;
      return text.split(/(\{\w+\})/g).map((part, i) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        return name && name in values ? <span key={i} style={{ display: 'contents' }}>{values[name]}</span> : part;
      });
    },
  };
};

const Context = createContext<I18n>(make('en', () => {}));
export const useI18n = () => useContext(Context);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<LanguageCode>(() => initialLanguage());

  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  const setLang = useCallback((next: LanguageCode) => {
    setLangState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* it still changes for this visit */ }
  }, []);

  // A page's own language, such as the one a share link was made in, applies unless the reader has chosen one here.
  const preferLang = useCallback((preferred: string | null | undefined) => {
    if (!isLanguage(preferred)) return;
    let chosen: string | null = null;
    try { chosen = localStorage.getItem(STORAGE_KEY); } catch { /* none */ }
    if (!isLanguage(chosen)) setLangState(preferred);
  }, []);

  const value = useMemo(() => make(lang, setLang, preferLang), [lang, setLang, preferLang]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The language picker: a small select in the page's corner. */
export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { lang, setLang, t } = useI18n();
  return (
    <select
      value={lang} aria-label={t('Language')} onChange={e => setLang(e.target.value as LanguageCode)}
      className={`rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 ${className}`}
    >
      {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
    </select>
  );
}
