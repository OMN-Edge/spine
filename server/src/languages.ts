/**
 * The languages the interface is written in, and so the ones a document can be translated into.
 * A translation is kept per document and language, so a short fixed list also bounds what the cache can hold
 * and what a share recipient can ask the model to do.
 */
export const SUPPORTED_LANGUAGES = ['en', 'ro', 'fr', 'de'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: 'English',
  ro: 'Romanian',
  fr: 'French',
  de: 'German',
};

export const isSupportedLanguage = (value: unknown): value is SupportedLanguage =>
  typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);

/**
 * What a document is written in, as a lowercase two- or three-letter code, or null. A code outside the list
 * above is fine here (a document can be in Hungarian); it just is not a language the interface offers.
 */
export function cleanLanguageCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(code) ? code : null;
}
