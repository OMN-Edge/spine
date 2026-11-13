import { beforeEach, describe, expect, it } from 'vitest';
import { INTERFACE_LANGUAGES } from 'spine-core/languages.js';
import { accessRequestMail, approvedMail, cardOpenedMail, cardReviewMail, remindersDueMail, resetMail, verificationMail } from '../accounts.js';
import { CHANGES, newSignInMail, securityChangeMail, type Change } from '../notify.js';
import { missing, recipientLanguage, tm, tmn } from '../mail/i18n.js';
import { DICTIONARIES } from '../mail/translations.js';

const LANGS = INTERFACE_LANGUAGES.filter(l => l !== 'en');
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort().join(',');

/** Every message the server can send, in a language. */
function everyMail(language: string) {
  const to = { email: 'a@example.org', language };
  const at = '2026-01-01T00:00:00Z';
  return [
    verificationMail(to, 'https://x.example/verify#t'), approvedMail(to, 'https://x.example/login'), resetMail(to, 'https://x.example/reset#t'),
    cardOpenedMail(to, at, null), cardOpenedMail(to, at, 'Romania'), cardReviewMail(to),
    ...[1, 2, 5, 20, 21].map(n => remindersDueMail(to, n)),
    accessRequestMail(to, 'https://x.example/share-requests/1', at, null), accessRequestMail(to, 'https://x.example/share-requests/1', at, '203.0.113.9'),
    newSignInMail(to, at),
    ...(Object.keys(CHANGES) as Change[]).map(c => securityChangeMail(to, c, at, { email: 'b@example.org' })),
  ];
}

describe('mail in the languages of the screens', () => {
  beforeEach(() => missing.clear());

  it.each(LANGS)('has every string the mail uses in %s', lang => {
    everyMail(lang);
    expect([...missing]).toEqual([]);
  });

  it.each(LANGS)('has in %s the same strings as the others, each with the same {values} as its English', lang => {
    expect(Object.keys(DICTIONARIES[lang]).sort()).toEqual(Object.keys(DICTIONARIES.ro).sort());
    for (const [key, value] of Object.entries(DICTIONARIES[lang])) expect(placeholders(value), key).toBe(placeholders(key));
  });

  it.each(LANGS)('writes every message in %s with the words of that language and the link intact', lang => {
    for (const m of everyMail(lang)) {
      expect(m.html).toContain(`<html lang="${lang}">`);
      expect(m.subject).not.toMatch(/\{\w+\}/);
      expect(m.text).not.toMatch(/\{\w+\}/);
      expect(m.html).not.toMatch(/\{\w+\}/);
    }
    const english = everyMail('en');
    const translated = everyMail(lang);
    english.forEach((m, i) => expect(translated[i].subject === m.subject, `${lang} ${m.subject}`).toBe(false));
    expect(translated[0].text).toContain('https://x.example/verify#t');
  });

  it('writes an account whose language the mail is not written in in English', () => {
    expect(recipientLanguage({ email: 'a@example.org', language: 'it' })).toBe('en');
    expect(recipientLanguage({ email: 'a@example.org', language: null })).toBe('en');
    expect(recipientLanguage('a@example.org')).toBe('en');
    expect(resetMail({ email: 'a@example.org', language: 'it' }, 'https://x.example/r#t').subject).toBe('Reset your password');
  });

  it('chooses the form of a plural the language has', () => {
    const [one, other] = ['A reminder is due', '{n} reminders are due'];
    expect(tmn('ro', 1, one, other)).toBe('Un memento este scadent');
    expect(tmn('ro', 2, one, other)).toBe('2 mementouri sunt scadente');
    expect(tmn('ro', 19, one, other)).toBe('19 mementouri sunt scadente');
    expect(tmn('ro', 20, one, other)).toBe('20 de mementouri sunt scadente');
    expect(tmn('fr', 3, one, other)).toBe('3 rappels arrivent à échéance');
    expect(tmn('en', 1, one, other)).toBe(one);
    expect(tm('de', '{email} gave up its seat in your plan', { email: 'x@y.z' })).toBe('x@y.z hat den Platz in Ihrem Tarif aufgegeben');
  });
});
