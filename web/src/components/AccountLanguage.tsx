import { Combobox } from './Combobox';
import { LANGUAGES, languageChoice, useI18n, type LanguageCode } from '../i18n';

/**
 * The account's language. Choosing here is choosing with the switcher in the top bar: `setLang` tells the app, which keeps it on the account
 * (App.tsx), and the account's mail is written in it. A language the screens are not written in is a fine choice: the screens are in English
 * and the mail too, and documents are translated into it.
 */
export default function AccountLanguage() {
  const { lang, setLang, t } = useI18n();
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
      <h3 className="font-medium text-gray-900 mb-1">{t('Language')}</h3>
      <p className="text-sm text-gray-500 mb-3">{t('The screens, the mail Spine sends you, translations of your documents and new share links start in this language.')}</p>
      <Combobox
        value={lang} ariaLabel={t('Language')} onChange={v => setLang(v as LanguageCode)}
        options={LANGUAGES.map(l => ({ value: l.code, label: languageChoice(l.code), ...(l.screens ? {} : { hint: t('documents only') }) }))}
      />
    </section>
  );
}
