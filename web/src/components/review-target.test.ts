import { describe, expect, it } from 'vitest';
import { reviewTarget } from './GuideTip';

describe('where Review in the Get started list leads', () => {
  it('is the first upload waiting for its grouping while one is waiting, else the review queue', () => {
    expect(reviewTarget({ grouping_waiting: 2 })).toBe('/upload#grouping');
    expect(reviewTarget({ grouping_waiting: 0 })).toBe('/review');
  });
});
