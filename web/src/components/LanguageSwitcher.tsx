import { useState } from 'react';
import { LANGUAGE_NAMES, isInterfaceLanguage } from 'spine-core/languages';
import { Combobox } from './Combobox';
import { LANGUAGES, languageChoice, useI18n, type LanguageCode } from '../i18n';

/** The look of a control in the top bar (the language, whose records are open), so they read as one set. */
export const TOP_BAR_CONTROL = 'rounded-full border border-gray-300 bg-white px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-brand-500';

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { lang, setLang, t } = useI18n();
  return (
    <Combobox
      value={lang} ariaLabel={t('Language')} onChange={v => setLang(v as LanguageCode)} wrapperClassName={`relative w-32 ${className}`} listClassName="right-0 w-64"
      className={`w-full ${TOP_BAR_CONTROL}`}
      options={LANGUAGES.map(l => ({ value: l.code, label: languageChoice(l.code), ...(l.screens ? {} : { hint: t('documents only') }) }))}
    />
  );
}

const NOTICE_KEY = 'spine.lang-notice';

/**
 * In a language the screens are not written in, a line at the top of every page says that they are in English and that documents are
 * translated into it. Closed, it stays closed for that language in this browser.
 */
export function LanguageNotice() {
  const { lang, t } = useI18n();
  const [closed, setClosed] = useState<string | null>(() => { try { return localStorage.getItem(NOTICE_KEY); } catch { return null; } });
  if (isInterfaceLanguage(lang) || closed === lang) return null;
  // In English, as the sentence around it is.
  const name = LANGUAGE_NAMES[lang];
  const close = () => { setClosed(lang); try { localStorage.setItem(NOTICE_KEY, lang); } catch { /* closed for this visit */ } };
  return (
    <div role="status" className="bg-sky-50 border-b border-sky-100 px-4 sm:px-6 py-2 text-sm text-sky-900 flex items-center justify-between gap-3">
      <span>{t('{language} is used for translating your documents. The screens are not available in it yet, so they are in English.', { language: name })}</span>
      <button type="button" onClick={close} className="shrink-0 underline">{t('Dismiss')}</button>
    </div>
  );
}

/** The language picker: a small select in the page's corner. */
