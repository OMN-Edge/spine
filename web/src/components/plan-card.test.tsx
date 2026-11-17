import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { BillingView } from '../api';
import PlanCard from './PlanCard';

/**
 * The account's plan tile, in each state it must handle. What the plan is comes from the server; the card, the cancelling and the invoices are the
 * provider's page, which the buttons open where the person asked (`api.billing.portal`). Nothing here is drawn for an instance with no plans.
 */
const shown = vi.hoisted(() => ({ view: null as BillingView | null }));
vi.mock('../billing', async importOriginal => ({ ...(await importOriginal<typeof import('../billing')>()), useBilling: () => shown.view }));

Object.assign(globalThis, {
  document: { documentElement: { getAttribute: () => null } },
  window: { matchMedia: () => ({ matches: false }), location: { search: '', origin: 'https://spine.example' } },
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const draw = (view: BillingView) => { shown.view = view; return text(renderToStaticMarkup(<MemoryRouter><PlanCard /></MemoryRouter>)); };

const paid = (sub: Partial<NonNullable<BillingView['subscription']>> = {}, extra: Partial<BillingView> = {}): BillingView => ({
  enabled: true, plan: 'premium', can_manage: true,
  subscription: { status: 'active', interval: 'month', founding: false, ends_at: null, renews_at: '2026-12-15T00:00:00.000Z', provider: 'paddle', ...sub },
  ...extra,
});
const ACTIONS = ['Update payment method', 'Cancel subscription', 'Manage billing, invoices and cancellation'];

describe('the plan tile', () => {
  it('shows nothing where there are no plans', () => {
    expect(draw({ enabled: false })).toBe('');
  });

  it('offers the card, cancelling and the invoices to an account that pays', () => {
    const page = draw(paid());
    for (const action of ACTIONS) expect(page).toContain(action);
    expect(page).toContain('Renews on');
    expect(page).not.toContain('did not go through');
  });

  it('says when the plan will end, keeps what is held until then, and offers no second cancellation', () => {
    const page = draw(paid({ ends_at: '2026-12-15T00:00:00.000Z', renews_at: null }));
    expect(page).toContain('Your subscription ends on');
    expect(page).toContain('Update payment method');
    expect(page).not.toContain('Cancel subscription');
    expect(page).toContain('Manage billing, invoices and cancellation');
  });

  it('says a payment did not go through, and puts the card first', () => {
    const page = draw(paid({ status: 'past_due' }));
    expect(page).toContain('Your last payment did not go through');
    expect(page).toContain('Update payment method');
  });

  it('offers no payment actions to a plan the operator granted or a seat in someone else\'s plan', () => {
    for (const view of [paid({ provider: 'operator', ends_at: '2027-01-01T00:00:00.000Z', renews_at: null }, { can_manage: false }), paid({}, { can_manage: false, seat: 'member' })]) {
      const page = draw(view);
      for (const action of ACTIONS) expect(page).not.toContain(action);
    }
  });

  const prices = { currency: 'EUR', essential: { year: 24.9, month: 2.49 }, premium: { year: 49, month: 4.99 }, founding: { year: 39 } };
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

  it('does not sell on the first days of the trial: it shows the days left and one quiet way to compare', () => {
    const page = draw({ enabled: true, plan: 'trial', trial_ends_at: inDays(87), can_manage: false, subscription: null, essential: true, prices, founding_left: 12 });
    expect(page).toContain('Your trial: 87 days left.');
    expect(page).toContain('Compare plans');
    expect(page).not.toContain('Premium for');
    expect(page).not.toContain('Essential for');
    for (const action of ACTIONS) expect(page).not.toContain(action);
  });

  it('offers the plans, and no payment actions, once the trial is nearly over', () => {
    const page = draw({ enabled: true, plan: 'trial', trial_ends_at: inDays(10), can_manage: false, subscription: null, essential: true, prices, founding_left: 12 });
    expect(page).toContain('Premium for €39 a year (founding price, €49 after)');
    expect(page).toContain('Essential for €24.90 a year');
    expect(page).toContain('or €4.99 a month');
    expect(page).not.toContain('Compare plans');
    for (const action of ACTIONS) expect(page).not.toContain(action);
  });

  it('offers the plans to an account on the free plan, whenever', () => {
    const page = draw({ enabled: true, plan: 'free', can_manage: false, subscription: null, prices, founding_left: 0 });
    expect(page).toContain('Premium for €49 a year');
  });

  it('writes an amount as the pricing page does', async () => {
    const { PricingPage } = await import('../pages/Pricing');
    const options = { registration: 'open' as const, instance: 'public' as const, billing: true, waitlist: false };
    const pricing = text(renderToStaticMarkup(<MemoryRouter><PricingPage pricing={{ enabled: true, prices, essential: true, founding_left: 12 }} authenticated={false} options={options} /></MemoryRouter>));
    const account = draw({ enabled: true, plan: 'free', can_manage: false, subscription: null, essential: true, prices, founding_left: 0 });
    for (const shown of ['€24.90', '€49']) { expect(pricing).toContain(shown); expect(account).toContain(shown); }
    expect(account).not.toContain('€49.00');
  });
});
