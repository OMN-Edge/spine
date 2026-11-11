import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const access = vi.hoisted(() => ({ state: 'limit' as string }));
vi.mock('../core/share/access', () => ({ useShareAccess: () => ({ state: access.state, ask: async () => undefined, error: '', code: '' }) }));

Object.assign(globalThis, {
  document: { documentElement: { getAttribute: () => null } },
  window: { matchMedia: () => ({ matches: false }), location: { search: '' } },
});

const { default: PublicShareView } = await import('./PublicShareView');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');
const render = () => text(renderToStaticMarkup(<MemoryRouter initialEntries={['/share/abc']}><Routes><Route path="/share/:id" element={<PublicShareView />} /></Routes></MemoryRouter>));

describe('a share link whose owner’s plan has used up the month', () => {
  it('tells the reader the link is unavailable until next month, in the words of a limit and not of a broken address', () => {
    access.state = 'limit';
    const page = render();
    expect(page).toContain('Link unavailable');
    expect(page).toContain('This link has reached its limit for this month. It opens again next month.');
    expect(page).not.toContain('incomplete or damaged');
  });

  it('is not what a link that has ended or a damaged address says', () => {
    access.state = 'gone';
    expect(render()).toContain('This link is no longer active.');
    access.state = 'broken';
    expect(render()).toContain('incomplete or damaged');
  });
});
