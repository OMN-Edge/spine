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

  it('offers the plans, and no payment actions, to an account that has not paid', () => {
    const page = draw({ enabled: true, plan: 'trial', trial_ends_at: '2027-05-15T00:00:00.000Z', can_manage: false, subscription: null, prices: { currency: 'EUR', premium: { year: 49, month: 4.99 }, founding: { year: 39 } }, founding_left: 12 });
    expect(page).toContain('Premium for');
    for (const action of ACTIONS) expect(page).not.toContain(action);
  });
});
