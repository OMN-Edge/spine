import { useMemo } from 'react';
import { screensIn, useI18n } from './i18n';
import type { InterfaceLanguage } from 'spine-core/languages';

/**
 * Dates, times, money and sizes as the reader's language writes them (T-05): one place, so a screen never shows `2/17/2027` beside `17.02.2027` or `€3.99` beside `3,99 €`.
 * The language is always the screens', never the browser's (`undefined` in an `Intl` call is the browser's, which is how an English-set browser showed a Romanian page
 * its dates). English is day month year with the month spelled (`17 Sept 2026`, 12-hour time), Romanian and German `17.09.2026`, French `17/09/2026`, and 24-hour time elsewhere.
 * A date with no time (`2026-09-17`) is a calendar day and is never moved by the time zone; a timestamp is shown in the reader's own.
 */
const LOCALE: Record<InterfaceLanguage, string> = { en: 'en-GB', ro: 'ro-RO', de: 'de-DE', fr: 'fr-FR' };

const instant = (value: string | Date): { date: Date; day: boolean } => {
  if (value instanceof Date) return { date: value, day: false };
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: new Date(`${value}T00:00:00Z`), day: true } : { date: new Date(value), day: false };
};

const dateOptions = (lang: InterfaceLanguage): Intl.DateTimeFormatOptions => (lang === 'en' ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
const timeOptions = (lang: InterfaceLanguage): Intl.DateTimeFormatOptions => (lang === 'en' ? { hour: 'numeric', minute: '2-digit', hour12: true } : { hour: '2-digit', minute: '2-digit', hour12: false });

export function formatDate(value: string | Date, lang: InterfaceLanguage): string {
  const { date, day } = instant(value);
  return new Intl.DateTimeFormat(LOCALE[lang], { ...dateOptions(lang), ...(day ? { timeZone: 'UTC' } : {}) }).format(date);
}

export function formatDateTime(value: string | Date, lang: InterfaceLanguage): string {
  const { date } = instant(value);
  return new Intl.DateTimeFormat(LOCALE[lang], { ...dateOptions(lang), ...timeOptions(lang) }).format(date);
}

export function formatTime(value: string | Date, lang: InterfaceLanguage): string {
  return new Intl.DateTimeFormat(LOCALE[lang], timeOptions(lang)).format(instant(value).date);
}

/** A day and a short month ("17 Sept", "17 sept."), for a label that has no room for a year. */
export function formatDayMonth(value: string | Date, lang: InterfaceLanguage): string {
  const { date, day } = instant(value);
  return new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', ...(day ? { timeZone: 'UTC' } : {}) }).format(date);
}

export function formatNumber(n: number, lang: InterfaceLanguage): string {
  return new Intl.NumberFormat(LOCALE[lang]).format(n);
}

/** An amount in whole units: no cents where there are none ("€49", "49 €"), two where there are ("€24.90", "24,90 €"); a symbol, not the code, where the currency has one in that language. */
export function formatAmount(amount: number, currency: string, lang: InterfaceLanguage): string {
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat(LOCALE[lang], { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(amount);
}

/** The same from an amount in minor units (cents), as the server and the payment provider count. */
export function formatMoney(minor: number, currency: string, lang: InterfaceLanguage): string {
  return formatAmount(minor / 100, currency, lang);
}

/** A size: "640 MB", "25 GB", "1.5 GB" ("1,5 GB"): one decimal only where there is one to show. */
export function formatBytes(bytes: number, lang: InterfaceLanguage): string {
  const unit = bytes >= 1024 ** 3 ? { size: 1024 ** 3, name: 'GB' } : { size: 1024 ** 2, name: 'MB' };
  const value = bytes >= 1024 ** 3 ? bytes / unit.size : Math.max(1, Math.round(bytes / unit.size));
  return `${new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 1 }).format(value)} ${unit.name}`;
}

/** The sign a currency is written with in the language ("€", "lei"), or its code where there is none. */
export function currencySymbol(currency: string, lang: InterfaceLanguage): string {
  return new Intl.NumberFormat(LOCALE[lang], { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find(p => p.type === 'currency')?.value ?? currency;
}

/** A name that starts a line written with a capital, as the language writes it (a Turkish "i" is not an English one); the rest as it is. */
export function startsWithCapital(text: string, lang: InterfaceLanguage): string {
  return text.charAt(0).toLocaleUpperCase(LOCALE[lang]) + text.slice(1);
}

/** The formatters for the language the screens are in, for a component to call. */
export function useFormat() {
  const { lang } = useI18n();
  const screens = screensIn(lang);
  return useMemo(() => ({
    date: (v: string | Date) => formatDate(v, screens),
    dateTime: (v: string | Date) => formatDateTime(v, screens),
    time: (v: string | Date) => formatTime(v, screens),
    dayMonth: (v: string | Date) => formatDayMonth(v, screens),
    number: (n: number) => formatNumber(n, screens),
    amount: (n: number, currency: string) => formatAmount(n, currency, screens),
    money: (minor: number, currency: string) => formatMoney(minor, currency, screens),
    bytes: (n: number) => formatBytes(n, screens),
    symbol: (currency: string) => currencySymbol(currency, screens),
  }), [screens]);
}
