/**
 * The languages a document can be translated into: a fixed list, not whatever is asked for. A translation is kept per document and language,
 * and a share recipient can ask for one, so the list bounds what the cache can hold and what a model can be asked to do, and the language's
 * name in the prompt is always one of these, never text a reader sent (SECURITY.md M-13).
 *
 * The interface itself is written in `INTERFACE_LANGUAGES` only; in any other language of the list the screens are in English and the
 * documents are translated (the page says so).
 */
export const INTERFACE_LANGUAGES = ['en', 'ro', 'fr', 'de'] as const;

export const SUPPORTED_LANGUAGES = [
  ...INTERFACE_LANGUAGES,
  'it', 'es', 'pt', 'nl', 'pl', 'cs', 'sk', 'hu', 'bg', 'el', 'hr', 'sl', 'sr', 'bs', 'mk', 'sq', 'uk', 'ru', 'tr',
  'sv', 'da', 'nb', 'fi', 'et', 'lv', 'lt', 'ca', 'ar', 'he', 'fa', 'hi', 'bn', 'ur', 'zh', 'ja', 'ko', 'vi', 'th', 'id', 'ms', 'sw',
] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export type InterfaceLanguage = (typeof INTERFACE_LANGUAGES)[number];

/** Each language's name in English, as the model is told it. */
export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: 'English', ro: 'Romanian', fr: 'French', de: 'German',
  it: 'Italian', es: 'Spanish', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', cs: 'Czech', sk: 'Slovak', hu: 'Hungarian', bg: 'Bulgarian',
  el: 'Greek', hr: 'Croatian', sl: 'Slovenian', sr: 'Serbian', bs: 'Bosnian', mk: 'Macedonian', sq: 'Albanian', uk: 'Ukrainian',
  ru: 'Russian', tr: 'Turkish', sv: 'Swedish', da: 'Danish', nb: 'Norwegian', fi: 'Finnish', et: 'Estonian', lv: 'Latvian',
  lt: 'Lithuanian', ca: 'Catalan', ar: 'Arabic', he: 'Hebrew', fa: 'Persian', hi: 'Hindi', bn: 'Bengali', ur: 'Urdu',
  zh: 'Chinese (Simplified)', ja: 'Japanese', ko: 'Korean', vi: 'Vietnamese', th: 'Thai', id: 'Indonesian', ms: 'Malay', sw: 'Swahili',
};

export const isSupportedLanguage = (value: unknown): value is SupportedLanguage =>
  typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);

export const isInterfaceLanguage = (value: unknown): value is InterfaceLanguage =>
  typeof value === 'string' && (INTERFACE_LANGUAGES as readonly string[]).includes(value);

/**
 * What a document is written in, as a lowercase two- or three-letter code, or null. A code outside the list
 * above is fine here (a document can be in Icelandic); it just is not a language documents are translated into.
 */
export function cleanLanguageCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(code) ? code : null;
}
