import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import ro from './ro.json';
import fr from './fr.json';
import de from './de.json';
import { INTERFACE_LANGUAGES, LANGUAGE_NAMES, SUPPORTED_LANGUAGES, isInterfaceLanguage, isSupportedLanguage, type InterfaceLanguage, type SupportedLanguage } from 'spine-core/languages';

/**
 * The interface in four languages; documents are translated into any language of a longer list, and in one of those the screens are in
 * English, which a notice at the top of the page says (`components/LanguageSwitcher.tsx`, with the switcher). The source of every string is its English text, written where it is used:
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

export type LanguageCode = SupportedLanguage;

/** A language's name in itself ("Italiano"), from the browser, or in English where the browser cannot say. */
function ownName(code: SupportedLanguage): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch { /* an older browser */ }
  return LANGUAGE_NAMES[code];
}

/** Every language on offer: the four the screens are written in first, then the others by their English name. */
export const LANGUAGES: ReadonlyArray<{ code: LanguageCode; name: string; screens: boolean }> = [
  ...INTERFACE_LANGUAGES.map(code => ({ code, name: ownName(code), screens: true })),
  ...SUPPORTED_LANGUAGES.filter(code => !isInterfaceLanguage(code))
    .sort((a, b) => LANGUAGE_NAMES[a].localeCompare(LANGUAGE_NAMES[b]))
    .map(code => ({ code, name: ownName(code), screens: false })),
];

/**
 * A language as a choice in a list: named in itself and, where that differs, in English too ("Italiano (Italian)"), so the English order
 * can be followed and either name typed. In a sentence the name in itself is enough.
 */
export const languageChoice = (code: LanguageCode): string => {
  const own = LANGUAGES.find(l => l.code === code)?.name ?? LANGUAGE_NAMES[code];
  return own === LANGUAGE_NAMES[code] ? own : `${own} (${LANGUAGE_NAMES[code]})`;
};

const DICTIONARIES: Record<Exclude<InterfaceLanguage, 'en'>, Record<string, string>> = { ro, fr, de };
const STORAGE_KEY = 'spine.lang';

export const isLanguage = (value: unknown): value is LanguageCode => isSupportedLanguage(value);

/** The language the screens are in: the chosen one if they are written in it, else English. */
export const screensIn = (lang: LanguageCode): InterfaceLanguage => (isInterfaceLanguage(lang) ? lang : 'en');

/**
 * The language to start in: the one remembered in this browser, else the browser's own if the screens are written in it, else English.
 * Any language can be chosen; only one the screens are in is chosen for the person.
 */
export function initialLanguage(preferred?: string | null): LanguageCode {
  if (isLanguage(preferred)) return preferred;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch { /* private window: the browser's language will do */ }
  const browser = (typeof navigator !== 'undefined' ? navigator.language : 'en').slice(0, 2).toLowerCase();
  return isInterfaceLanguage(browser) ? browser : 'en';
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
  const screens = screensIn(lang);
  const dictionary: Record<string, string> = screens === 'en' ? {} : DICTIONARIES[screens];
  const t: I18n['t'] = (english, values) => fill(dictionary[english] ?? english, values);
  const rules = new Intl.PluralRules(screens);
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

  // The screens' language: in a language they are not written in, they are English.
  useEffect(() => { document.documentElement.lang = screensIn(lang); }, [lang]);

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
