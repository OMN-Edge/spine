import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV_OPEN, setNavOpen } from './nav-open';

/** The floating pills do not cover the phone's menu (T-12). */
describe('the phone menu and the floating pills', () => {
  const body = () => { const attrs = new Set<string>(); return { attrs, toggleAttribute: (name: string, force?: boolean) => { if (force) attrs.add(name); else attrs.delete(name); return !!force; } }; };

  it('says on the page that the menu is open, and says it no longer is when it closes', () => {
    const b = body();
    setNavOpen(b, true);
    expect(b.attrs.has(NAV_OPEN)).toBe(true);
    setNavOpen(b, false);
    expect(b.attrs.has(NAV_OPEN)).toBe(false);
  });

  it('is what every floating pill of the chat hides itself for', () => {
    const source = readFileSync(join(__dirname, 'components/ChatPanel.tsx'), 'utf8');
    const pills = source.split('\n').filter(line => /fixed bottom-(40|24) right-5/.test(line));
    expect(pills.length).toBeGreaterThanOrEqual(3);
    for (const pill of pills) expect(pill).toContain('[body[data-nav-open]_&]:hidden');
  });
});
