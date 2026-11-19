import { describe, expect, it } from 'vitest';
import type { BillingView } from './api';
import { extraPages, importLeft, readingEstimate } from './reading-estimate';

const view = (reading: Partial<NonNullable<BillingView['ai']>['reading']>, topup = 0, imported: Partial<NonNullable<BillingView['ai']>['import']> = {}): BillingView => ({
  enabled: true, plan: 'premium',
  ai: { period: 'month', reading: { used: 10, allowance: 40, ...reading }, chat: { used: 0, allowance: null }, translation: { used: 0, allowance: null }, import: { used: 0, allowance: 0, ...imported } },
  addons: { page_topup: { buyable: true, pages_left: topup } },
});

describe('what reading an upload will use', () => {
  it('is the pages of the upload against what can still be added, a top-up included', () => {
    expect(readingEstimate(view({}, 0), 12)).toEqual({ pages: 12, left: 30, short: 0 });
    expect(readingEstimate(view({}, 250), 300)).toEqual({ pages: 300, left: 280, short: 20 });
  });

  it('counts the one-off import of a yearly plan among the extra pages, held to a seat’s own cap', () => {
    expect(readingEstimate(view({}, 0, { used: 50, allowance: 250 }), 300)).toEqual({ pages: 300, left: 230, short: 70 });
    expect(importLeft(view({}, 0, { used: 50, allowance: 250, own_cap: 125, own_used: 100 }))).toBe(25);
    expect(extraPages(view({}, 40, { used: 0, allowance: 150 }))).toBe(190);
    expect(extraPages(view({}, 0, { allowance: 0 }))).toBe(0);
  });

  it('says how many pages are short when the upload is more than is left', () => {
    expect(readingEstimate(view({ used: 38 }), 5)).toEqual({ pages: 5, left: 2, short: 3 });
  });

  it('holds a seat to its own cap', () => {
    expect(readingEstimate(view({ own_cap: 20, own_used: 18 }), 5)).toEqual({ pages: 5, left: 2, short: 3 });
  });

  it('says nothing where adding is not limited, billing is off, or there is nothing to read', () => {
    expect(readingEstimate(view({ allowance: null }), 5)).toBeNull();
    expect(readingEstimate({ enabled: false }, 5)).toBeNull();
    expect(readingEstimate(null, 5)).toBeNull();
    expect(readingEstimate(view({}), 0)).toBeNull();
  });
});
