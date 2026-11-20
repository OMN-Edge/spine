import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listSide } from './LanguageSwitcher';

/**
 * The language list is wider than its button. Opened from the button's right edge, it runs off the screen where the button starts a row
 * at the screen's left (the phone menu, a share's page: the list was cut off and the languages could not be read), so it opens to the right there, by where the button is.
 */
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('the language list', () => {
  it('opens back from the button’s right edge where there is room for it, and forward from the left edge where the button starts a row at the left of a phone’s screen', () => {
    expect(listSide({ left: 900, right: 1032 })).toBe('left');
    expect(listSide({ left: 13, right: 131 })).toBe('right');
    expect(listSide({ left: 16, right: 148 })).toBe('right');
  });

  it('is not told which side by the place it is put in, which was wrong on the share page', () => {
    for (const file of ['../App.tsx', './PublicPage.tsx', '../pages/PublicShareView.tsx']) expect(source(file)).not.toContain('opens=');
  });
});

describe('the account\'s language', () => {
  it('is taken at load and on sign-in, and a choice is kept on the account except on a share link\'s page', () => {
    const app = source('../App.tsx');
    expect(app.match(/takeLanguage\(r\.language\)/g)).toHaveLength(2);
    expect(app).toContain("if (window.location.pathname.startsWith('/share/')) return;");
    expect(app).toContain('api.auth.setLanguage(language)');
  });

  it('is where a new share link starts, and what the sign-up sends', () => {
    expect(source('../pages/ShareLinks.tsx')).toContain("language: accountLanguage ?? ''");
    expect(source('../pages/Register.tsx')).toContain("params.get('ref') ?? undefined, lang, params.get('by') ?? undefined)");
  });
});
