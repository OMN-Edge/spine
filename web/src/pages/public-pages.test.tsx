import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { helpTopic } from 'spine-core/help';
import Landing from './Landing';
import HowItWorks from './HowItWorks';
import Protection from './Protection';
import Families from './Families';
import Encryption from './Encryption';

/**
 * The pages a visitor reads before an account: each opens on its own title inside the one header and footer, offers the demo as the
 * first step, and links to the others. What the instance allows (registration, plans) arrives from the server after the first draw, so
 * the first draw is the closed instance with no plans: no sign-up and no prices are offered before the server has said so.
 */
// What the pages read while they are drawn, and nothing more: the theme the page has, whether the device prefers dark, and the address's
// query (a `ref` passed on to the sign-up). There is no DOM in these tests, so these three are given.
Object.assign(globalThis, {
  document: { documentElement: { getAttribute: () => null } },
  window: { matchMedia: () => ({ matches: false }), location: { search: '' } },
});

const render = (page: JSX.Element, path = '/') => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const PAGES = [
  { name: 'the front page', page: <Landing />, path: '/', title: 'All your medical records, in one place only you can open.' },
  { name: 'how it works', page: <HowItWorks />, path: '/how-it-works', title: 'How Spine works' },
  { name: 'protection', page: <Protection />, path: '/protection', title: 'How your records are protected' },
  { name: 'families', page: <Families />, path: '/families', title: 'Spine for families' },
  { name: 'encryption', page: <Encryption />, path: '/encryption', title: 'Encryption, in detail' },
];

describe('the pages before an account', () => {
  for (const { name, page, path, title } of PAGES) {
    describe(name, () => {
      const html = render(page, path);

      it('opens on its own title, once', () => {
        expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
        expect(text(html)).toContain(title);
      });

      it('sits in the one header and footer, with every page and every rule a link away', () => {
        for (const href of ['/how-it-works', '/protection', '/families', '/encryption', '/for-doctors', '/login', '/privacy', '/terms', '/purpose', '/trust']) {
          expect(html).toContain(`href="${href}"`);
        }
        expect(html).toContain('href="#main"');
      });

      it('offers the demo first, and no sign-up or prices before the server says they exist', () => {
        expect(text(html)).toContain('Try the demo');
        expect(html).not.toContain('href="/register');
        expect(html).not.toContain('href="/pricing"');
      });
    });
  }

  it('explains with the help the assistant gives, word for word, so the two cannot drift apart', () => {
    const page = text(render(<HowItWorks />, '/how-it-works'));
    for (const id of ['grouping', 'checking', 'assistant', 'sharing']) {
      for (const paragraph of helpTopic(id)!.paragraphs) expect(page).toContain(paragraph);
    }
    expect(page).toContain(helpTopic('password')!.question);
  });

  it('tells a family what deleting the account does to the people let in', () => {
    expect(text(render(<Families />, '/families'))).toContain('If you delete your account, everyone you let in loses the records too.');
  });

  it('says the relay sees what passes through it, and does not promise it cannot', () => {
    expect(text(render(<Protection />, '/protection'))).toContain('The relay does see the text while it passes through.');
  });
});
