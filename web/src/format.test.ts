import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { currencySymbol, startsWithCapital, formatAmount, formatBytes, formatDate, formatDateTime, formatDayMonth, formatMoney, formatNumber, formatTime } from './format';

/** Dates, times, money and sizes in the language of the screens (T-05), and a check that no screen writes one with the browser's own. */
/** The spaces Intl writes between a number and its sign are not ordinary ones. */
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

describe('a date', () => {
  it('is written as each language writes it: month spelled in English, day first with dots in Romanian and German, with slashes in French', () => {
    expect(formatDate('2026-09-17', 'en')).toMatch(/^17 Sept? 2026$/);
    expect(formatDate('2026-09-17', 'ro')).toBe('17.09.2026');
    expect(formatDate('2026-09-17', 'de')).toBe('17.09.2026');
    expect(formatDate('2026-09-17', 'fr')).toBe('17/09/2026');
  });

  it('is never US style, in any language', () => {
    for (const lang of ['en', 'ro', 'de', 'fr'] as const) expect(plain(formatDate('2027-02-17', lang))).not.toMatch(/^2\/17|^02\/17/);
  });

  it('is a calendar day that the time zone does not move, where it has no time', () => {
    expect(formatDate('2026-12-31', 'ro')).toBe('31.12.2026');
    expect(formatDayMonth('2026-12-31', 'ro')).toMatch(/^31 dec/);
  });

  it('has a time of day in 24 hours outside English and 12 in English', () => {
    const at = new Date(2026, 8, 17, 17, 5);
    expect(formatTime(at, 'ro')).toBe('17:05');
    expect(formatTime(at, 'de')).toBe('17:05');
    expect(formatTime(at, 'fr')).toBe('17:05');
    expect(plain(formatTime(at, 'en'))).toMatch(/^5:05\s?pm$/i);
    expect(formatDateTime(at, 'ro')).toBe('17.09.2026, 17:05');
    expect(formatDateTime(at, 'ro')).not.toMatch(/AM|PM/i);
  });
});

describe('money', () => {
  it('has no cents on a whole amount and two on any other, with the sign the language writes', () => {
    expect(plain(formatMoney(4900, 'EUR', 'ro'))).toBe('49 €');
    expect(plain(formatMoney(2490, 'EUR', 'en'))).toBe('€24.90');
    expect(plain(formatMoney(2490, 'EUR', 'ro'))).toBe('24,90 €');
    expect(plain(formatMoney(399, 'EUR', 'de'))).toBe('3,99 €');
    expect(plain(formatMoney(399, 'EUR', 'fr'))).toBe('3,99 €');
    expect(plain(formatAmount(49, 'EUR', 'en'))).toBe('€49');
    expect(formatAmount(24.9, 'EUR', 'en')).toBe('€24.90');
  });

  it('is written the same way on every screen that shows it: the same amount, the same words', () => {
    for (const lang of ['en', 'ro', 'de', 'fr'] as const) expect(formatMoney(3900, 'EUR', lang)).toBe(formatAmount(39, 'EUR', lang));
  });

  it('names the currency sign for a field that shows it apart', () => {
    expect(currencySymbol('EUR', 'en')).toBe('€');
    expect(currencySymbol('RON', 'ro')).toBe('lei');
  });
});

describe('a size and a number', () => {
  it('is whole or has one decimal, with the language’s own separator', () => {
    expect(plain(formatBytes(25 * 1024 ** 3, 'en'))).toBe('25 GB');
    expect(plain(formatBytes(1.5 * 1024 ** 3, 'en'))).toBe('1.5 GB');
    expect(plain(formatBytes(1.5 * 1024 ** 3, 'ro'))).toBe('1,5 GB');
    expect(plain(formatBytes(640 * 1024 ** 2, 'de'))).toBe('640 MB');
    expect(plain(formatBytes(10, 'en'))).toBe('1 MB');
    expect(formatNumber(1234567, 'ro')).toBe('1.234.567');
  });
});

/** The screens never ask the browser how to write a date or an amount: the browser's language is not the screens'. */
describe('the screens', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return name === 'core' || name === 'e2e' ? [] : walk(file);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [file] : [];
  });
  it('write no date, time or amount with the browser’s own locale', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(__dirname))) {
      if (file === path.join(__dirname, 'format.ts')) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/\.toLocale(Date|Time)?String\(\s*\)/.test(line) || /\.toLocale(Date|Time)?String\(\s*undefined/.test(line) || /Intl\.(NumberFormat|DateTimeFormat)\(\s*undefined/.test(line)) offenders.push(`${path.relative(__dirname, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('a name that starts a line', () => {
  it('starts with a capital in each language, and the rest is left as it is', () => {
    expect(startsWithCapital('family medicine', 'en')).toBe('Family medicine');
    expect(startsWithCapital('cardiologie', 'ro')).toBe('Cardiologie');
    expect(startsWithCapital('Kardiologie', 'de')).toBe('Kardiologie');
    expect(startsWithCapital('', 'en')).toBe('');
  });
});
