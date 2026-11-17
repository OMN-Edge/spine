import { languageName } from '../i18n/useTranslation';
import { screensIn, useI18n, type LanguageCode } from '../i18n';

/** Whether an edit would be made to a document in a language other than the one the screens are in: the owner corrects what was read, not its translation. */
export const editsOriginal = (documentLanguage: string | null | undefined, lang: LanguageCode): boolean => !!documentLanguage && documentLanguage !== screensIn(lang);

/**
 * Said above the review form when the document is written in a language other than the reader's (T-17): the fields are in the original, and the reader's version is a translation that
 * is made again after the save. Without it a reader in English opens Review on a Romanian document and sees Romanian fields with no word of why.
 */
export default function OriginalNote({ documentLanguage }: { documentLanguage: string | null | undefined }) {
  const { t, lang } = useI18n();
  if (!editsOriginal(documentLanguage, lang)) return null;
  return (
    <p role="note" className="mb-3 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">
      {t('You are correcting the original, in {language}. The {reader} version is a translation and is made again after you save.', { language: languageName(documentLanguage!), reader: languageName(screensIn(lang)) })}
    </p>
  );
}
