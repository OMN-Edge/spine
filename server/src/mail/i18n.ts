import { isInterfaceLanguage, type InterfaceLanguage } from 'spine-core/languages.js';
import { DICTIONARIES } from './translations.js';

/**
 * The words of account mail in the account's language, written as the screens are (web/src/i18n/index.tsx): the source of every string is its
 * English text where it is used, `tm(lang, 'Reset your password')`, and a language file maps an English string to its translation. A string
 * a language lacks is shown in English, never as a key. `__tests__/mail-i18n.test.ts` fails when a mail uses one a language does not have.
 *
 * Mail is written in the four languages the screens are; an account in any other language of the list gets English mail.
 */
export type Recipient = string | { email: string; language?: string | null };

export const recipientEmail = (to: Recipient): string => (typeof to === 'string' ? to : to.email);

/** The language a message to this recipient is written in: the account's if mail is written in it, else English. */
export const recipientLanguage = (to: Recipient): InterfaceLanguage => {
  const language = typeof to === 'string' ? null : to.language;
  return isInterfaceLanguage(language) ? language : 'en';
};

/** English strings looked up in a language that has no translation of them, collected so a test can list them. */
export const missing = new Set<string>();

const fill = (text: string, values?: Record<string, string | number>) =>
  values ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole)) : text;

const find = (lang: InterfaceLanguage, english: string): string => {
  if (lang === 'en') return english;
  const found = DICTIONARIES[lang][english];
  if (found === undefined) missing.add(`${lang}: ${english}`);
  return found ?? english;
};

export function tm(lang: InterfaceLanguage, english: string, values?: Record<string, string | number>): string {
  return fill(find(lang, english), values);
}

/**
 * The form that fits the number, as the screens' `tn`: the forms of a plural are kept as "one|few|other" under the key "one-english|other-english"
 * (a language with no "few" has two, Romanian has three).
 */
export function tmn(lang: InterfaceLanguage, n: number, one: string, other: string, values?: Record<string, string | number>): string {
  const forms = find(lang, `${one}|${other}`).split('|');
  const category = new Intl.PluralRules(lang).select(n);
  const form = category === 'one' ? forms[0] : category === 'few' && forms.length > 2 ? forms[1] : forms[forms.length - 1];
  return fill(form, { n, ...values });
}
