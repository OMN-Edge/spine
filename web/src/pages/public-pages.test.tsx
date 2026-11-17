import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { helpTopic } from 'spine-core/help';
import Landing from './Landing';
import HowItWorks from './HowItWorks';
import Protection from './Protection';
import Families from './Families';
import Encryption from './Encryption';
import SecurityChecks from './SecurityChecks';
import { PricingPage } from './Pricing';
import type { Pricing as PricingData } from '../api';

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
  { name: 'security in every release', page: <SecurityChecks />, path: '/security-checks', title: 'Checked on every change, reviewed before every release' },
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
        for (const href of ['/how-it-works', '/protection', '/families', '/encryption', '/for-doctors', '/login', '/privacy', '/terms', '/purpose', '/refunds', '/trust']) {
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

  it('names the attacks first, then the three stages every version goes through, and the front page links to it', () => {
    const page = text(render(<SecurityChecks />, '/security-checks'));
    for (const heading of ['The attacks it is built to resist', 'On every change', 'Before every release', 'At release']) expect(page).toContain(heading);
    expect(page.indexOf('The attacks it is built to resist')).toBeLessThan(page.indexOf('On every change'));
    expect(render(<Landing />, '/')).toContain('href="/security-checks"');
  });

  it('says under the headline what Spine is and what it is not, before the page asks for anything', () => {
    const page = text(render(<Landing />, '/'));
    const line = 'Spine is software for keeping, organising and sharing your own documents. It does not diagnose and does not give medical advice.';
    expect(page).toContain(line);
    expect(page.indexOf('All your medical records')).toBeLessThan(page.indexOf(line));
    expect(page.indexOf(line)).toBeLessThan(page.indexOf('Try the demo'));
  });
});

/**
 * The plans page, drawn for each thing the server can say. Plans come from Paddle's prices, so the page shows an amount only where it was given one, and
 * says so where it was not.
 */
describe('the front page says what Spine does for a doctor abroad', () => {
  it('has a line in the hero, a link to the page for doctors, and a section with the same report in two languages, with nothing real in it', () => {
    const page = text(render(<Landing />, '/'));
    expect(page).toContain('Your records, in any doctor’s language.');
    expect(page).toContain('A report from home, read by a doctor abroad');
    expect(page).toContain('A letter from a clinic abroad, read in your language.');
    for (const shown of ['Analize de laborator', 'Laborbefund', 'Hemoglobină', 'Hämoglobin', 'not certified translations']) expect(page).toContain(shown);
    expect(render(<Landing />, '/')).toContain('href="/for-doctors"');
  });
});

describe('the plans page', () => {
  const options = { registration: 'open' as const, instance: 'public' as const, billing: true, waitlist: false };
  const prices = { currency: 'EUR', essential: { year: 24.9, month: 2.49 }, premium: { year: 49, month: 4.99 }, founding: { year: 39 }, family: { year: 89, month: 8.99 } };
  const draw = (pricing: PricingData | null, authenticated = false) => text(render(<PricingPage pricing={pricing} authenticated={authenticated} options={options} />, '/pricing'));

  it('shows each plan at the amount it was given, a whole amount without cents, and the import only with a yearly plan', () => {
    const html = draw({ enabled: true, prices, essential: true, family: true, founding_left: 478 });
    for (const shown of ['Free', 'Essential', 'Premium', 'Family', '€24.90', '€49', '€89', '€39']) expect(html).toContain(shown);
    expect(html).not.toContain('€49.00');
    expect(html).toContain('Includes a one-off import of 150 pages');
    expect(html).toContain('Includes a one-off import of 250 pages');
    expect(html).toContain('Founding price for the first 500 members');
    expect(html).not.toMatch(/of 500 taken|places left/);
    for (const total of ['100', '50', '30']) expect(html).toContain(total);
  });

  it('shows the founding offer above the plans, three plans in a row, and the family plan in a tile of its own below them that the page links to', () => {
    const html = render(<PricingPage pricing={{ enabled: true, prices, essential: true, family: true, founding_left: 478 }} authenticated={false} options={options} />, '/pricing');
    const cards = [...html.matchAll(/<article[\s\S]*?<\/article>/g)].map(m => text(m[0]).trim());
    expect(cards.map(c => c.split(' ')[0])).toEqual(['Free', 'Essential', 'Premium']);
    for (const card of cards) expect(card.toLowerCase(), card.slice(0, 30)).toContain('emergency card');
    expect(html.indexOf('Founding members')).toBeLessThan(html.indexOf('Then keep the plan that fits'));
    expect(html.indexOf('id="family"')).toBeGreaterThan(html.lastIndexOf('</article>'));
    expect(html).toContain('href="#family"');
    const family = text(html.slice(html.indexOf('id="family"')));
    expect(family).toContain('€89');
    expect(family).toContain('emergency card');
    expect(family).toContain('Includes a one-off import of 500 pages');
    expect(html.match(/Premium for up to six people/g)).toHaveLength(1);
  });

  it('says one short line about the yearly price, how much less it is than twelve months, and nothing beside the monthly one', () => {
    const pricing = { enabled: true, prices, essential: true, family: true, founding_left: 478 };
    const yearly = text(render(<PricingPage pricing={pricing} authenticated={false} options={options} />, '/pricing'));
    // Rounded down, so the page never claims more than the prices give.
    for (const saving of ['Save 16%', 'Save 18%', 'Save 17%']) expect(yearly).toContain(saving);
    const monthly = text(render(<PricingPage pricing={pricing} authenticated={false} options={options} initialPeriod="month" />, '/pricing'));
    for (const shown of ['€2.49', '€4.99', '€8.99']) expect(monthly).toContain(shown);
    expect(monthly).not.toMatch(/\bor €\d+(\.\d+)? a year/);
    expect(monthly).not.toMatch(/Save \d+%|save \d+%/);
  });

  it('says nothing about a saving where the yearly price is no cheaper than twelve months', () => {
    const pricing = { enabled: true, prices: { ...prices, premium: { year: 60, month: 5 } }, essential: true, family: true, founding_left: 0 };
    const html = text(render(<PricingPage pricing={pricing} authenticated={false} options={options} />, '/pricing'));
    expect(html).not.toContain('Save 0%');
    expect(html.match(/Save \d+%/g)).toHaveLength(2);
  });

  it('does not offer the family plan, nor a link to it, where the instance does not sell it', () => {
    const html = render(<PricingPage pricing={{ enabled: true, prices: { ...prices, family: undefined }, family: false, founding_left: 10 }} authenticated={false} options={options} />, '/pricing');
    expect(html).not.toContain('id="family"');
    expect(html).not.toContain('href="#family"');
  });

  it('says nothing twice within a plan, and counts the free plan’s pages kept, not its documents', () => {
    const html = render(<PricingPage pricing={{ enabled: true, prices, essential: true, family: true, founding_left: 478 }} authenticated={false} options={options} />, '/pricing');
    for (const card of html.matchAll(/<article[\s\S]*?<\/article>/g)) {
      const lines = [...card[0].matchAll(/<li[\s\S]*?<\/li>/g)].map(m => text(m[0]));
      expect(new Set(lines).size, lines.join(' | ')).toBe(lines.length);
      // Translation and questions are each said once in a card, not once for what they are and again for how often.
      expect(lines.filter(l => /translation of your documents/i.test(l)).length).toBeLessThanOrEqual(1);
    }
    const page = text(html);
    expect(page).toContain('Up to 50 pages kept');
    expect(page).not.toMatch(/50 documents/);
  });

  it('opens with three months free', () => {
    const page = text(render(<PricingPage pricing={{ enabled: true, prices, essential: true, family: true, founding_left: 478 }} authenticated={false} options={options} />, '/pricing'));
    expect(page).toContain('Every account starts with three months of everything, free.');
    expect(page).toContain('Start with three months free');
    expect(page).not.toMatch(/six months/i);
    for (const total of ['100', '50', '30']) expect(page).toContain(total);
  });

  it('says the refund in plain words, and the trial as three months', () => {
    const page = draw({ enabled: true, prices, essential: true, family: true, founding_left: 478 });
    expect(page).toContain('minus the part of the year you already used');
    expect(page).not.toContain('less what the law lets us keep');
  });

  it('says one thing about the trial and a different thing on each plan’s button', () => {
    const html = render(<PricingPage pricing={{ enabled: true, prices, essential: true, family: true, founding_left: 478 }} authenticated={false} options={options} />, '/pricing');
    const page = text(html);
    expect(page.match(/Start with three months free/g)).toHaveLength(1);
    const buttons = [...html.matchAll(/<a[^>]*href="(\/register[^"]*)"[^>]*>([^<]*)<\/a>/g)].map(m => [m[1], m[2]]);
    const labels = buttons.map(b => b[1]);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of ['Stay free after the trial', 'Choose Essential', 'Choose Premium', 'Choose Family']) expect(page).toContain(label);
    for (const plan of ['free', 'essential', 'premium', 'family']) expect(buttons.some(b => b[0] === `/register?plan=${plan}`)).toBe(true);
  });

  it('says nothing of the founding places taken until a hundred are, then how many, then how many are left from a hundred left', () => {
    const founding = (left: number) => draw({ enabled: true, prices, essential: true, family: true, founding_left: left });
    expect(founding(500)).toContain('Founding price for the first 500 members');
    expect(founding(500)).not.toMatch(/of 500 taken|left/);
    expect(founding(350)).toContain('150 of 500 taken');
    expect(founding(350)).toContain('350 left');
    expect(founding(80)).toContain('Only 80 founding places left');
    expect(founding(80)).not.toContain('of 500 taken');
  });

  it('leaves out the plans the instance does not sell, and the founding offer once its places are gone', () => {
    const html = draw({ enabled: true, prices: { ...prices, essential: undefined, family: undefined }, founding_left: 0 });
    expect(html).not.toContain('Essential');
    expect(html).not.toContain('Family');
    expect(html).not.toContain('Founding members');
    expect(html).toContain('Premium');
  });

  it('shows no amount where Paddle could not say, and says that no plans exist where there are none', () => {
    const none = draw({ enabled: true, prices: null });
    expect(none).toContain('The prices cannot be shown right now');
    expect(none).not.toMatch(/€\s?\d/);
    expect(draw({ enabled: false })).toContain('This Spine has no paid plans');
    expect(draw(null)).not.toMatch(/€\s?\d/);
  });

  it('sends a signed-in person to the account page and a visitor to sign-up', () => {
    const pricing = { enabled: true, prices, essential: true, family: true, founding_left: 10 };
    expect(render(<PricingPage pricing={pricing} authenticated options={options} />, '/pricing')).toContain('href="/account"');
    expect(render(<PricingPage pricing={pricing} authenticated={false} options={options} />, '/pricing')).toContain('href="/register"');
  });
});
