import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The web app's interface strings are English literals passed to t(), tn(), tx() or msg(). Each of the
 * dictionaries (ro, fr, de) must have all of them and nothing else, with the same {placeholders}, so a string
 * added to a screen cannot reach a reader in English by accident, and a dictionary entry cannot go stale.
 * This reads the web source as text: there is no web test runner. `tr` is TrendChart's name for t, which its loops use.
 */
const WEB = resolve(__dirname, '../../../web/src');
const LANGUAGES = ['ro', 'fr', 'de'] as const;

const STR = String.raw`(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|\`((?:[^\`\\$]|\\.)*)\`)`;
const SINGLE = new RegExp(String.raw`(?<![\w.])(?:t|tx|tr|msg)\(\s*${STR}`, 'g');
const PLURAL = new RegExp(String.raw`(?<![\w.])tn\(\s*[^,()]*(?:\([^()]*\))?[^,()]*,\s*${STR}\s*,\s*${STR}`, 'g');

const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
const first = (...parts: Array<string | undefined>) => unescape(parts.find(p => p !== undefined) ?? '');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !path.endsWith(join('i18n', 'index.tsx')) ? [path] : [];
  });
}

function used(): { singles: Set<string>; plurals: Set<string> } {
  const singles = new Set<string>(['Document', 'Unknown date']);
  const plurals = new Set<string>();
  for (const file of sources(WEB)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(SINGLE)) singles.add(first(m[1], m[2], m[3]));
    for (const m of text.matchAll(PLURAL)) plurals.add(`${first(m[1], m[2], m[3])}|${first(m[4], m[5], m[6])}`);
  }
  // The display names in titles.ts are looked up by key at run time, so their values are the strings.
  const titles = readFileSync(join(WEB, 'titles.ts'), 'utf8');
  for (const block of titles.matchAll(/(?:FIELD_NAMES|DOC_TYPE_NAMES)[^=]*=\s*\{([\s\S]*?)\n\};/g)) {
    for (const m of block[1].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) singles.add(unescape(m[1]));
  }
  // The answers about Spine (core's help.ts) are shown with t() of each question and paragraph, so those are strings too; ids are not.
  const help = readFileSync(resolve(__dirname, '../help.ts'), 'utf8');
  const topics = /HELP_TOPICS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(help)?.[1] ?? '';
  for (const m of topics.matchAll(/(\bid:\s*)?'((?:[^'\\]|\\.)*)'/g)) if (!m[1]) singles.add(unescape(m[2]));
  return { singles, plurals };
}

const placeholders = (s: string) => [...s.matchAll(/\{\w+\}/g)].map(m => m[0]).sort();
const dictionary = (lang: string): Record<string, string> => JSON.parse(readFileSync(join(WEB, 'i18n', `${lang}.json`), 'utf8'));

describe('web interface translations', () => {
  const { singles, plurals } = used();

  it('finds the strings it is meant to check', () => {
    expect(singles.size).toBeGreaterThan(300);
    expect(singles).toContain('How is my data kept private?');
    expect(plurals.size).toBeGreaterThan(10);
  });

  for (const lang of LANGUAGES) {
    describe(lang, () => {
      const dict = dictionary(lang);

      it('has every string the screens use', () => {
        const missing = [...singles, ...plurals].filter(k => !(k in dict) || dict[k].trim() === '');
        expect(missing).toEqual([]);
      });

      it('has no string no screen uses', () => {
        const stale = Object.keys(dict).filter(k => !singles.has(k) && !plurals.has(k));
        expect(stale).toEqual([]);
      });

      it('keeps the placeholders of each string', () => {
        const wrong = Object.entries(dict).filter(([key, value]) => {
          const forms = key.includes('|') && plurals.has(key) ? value.split('|') : [value];
          const english = key.includes('|') && plurals.has(key) ? key.split('|') : [key];
          // Every form uses the placeholders of the English it stands for (a form may drop {n}: "one" can say "a").
          const wanted = new Set(english.flatMap(placeholders));
          return forms.some(form => placeholders(form).some(p => !wanted.has(p)))
            || [...wanted].filter(p => p !== '{n}').some(p => !forms.every(f => f.includes(p)) && !english.some(e => !e.includes(p)));
        });
        expect(wrong.map(([k]) => k)).toEqual([]);
      });

      it('gives a plural the forms its language uses', () => {
        const forms = lang === 'ro' ? 3 : 2;
        const wrong = [...plurals].filter(k => (dict[k] ?? '').split('|').length !== forms);
        expect(wrong).toEqual([]);
      });
    });
  }
});
