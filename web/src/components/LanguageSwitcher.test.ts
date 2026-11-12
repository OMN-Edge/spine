import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The language list is wider than its button. Opened from the button's right edge, it runs off the screen where the button starts a row
 * at the screen's left (the phone menu: the list was cut off and the languages could not be read), so those places open it to the right.
 */
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('the language list', () => {
  it('opens to the right where the button starts a row at the left edge of a phone’s screen', () => {
    expect(source('../App.tsx')).toContain('<div className="py-3 flex items-center gap-2"><LanguageSwitcher opens="right" />');
    expect(source('./PublicPage.tsx')).toContain('sm:hidden"><LanguageSwitcher opens="right" />');
    expect(source('../pages/PublicShareView.tsx')).toContain('justify-center gap-2"><LanguageSwitcher opens="right" />');
  });

  it('is placed from the side it opens towards', () => {
    expect(source('./LanguageSwitcher.tsx')).toContain("listClassName={opens === 'left' ? 'right-0 w-64' : 'left-0 w-64'}");
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
    expect(source('../pages/Register.tsx')).toContain("params.get('ref') ?? undefined, lang)");
  });
});
