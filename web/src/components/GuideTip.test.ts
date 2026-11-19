import { describe, expect, it } from 'vitest';
import { stepsDone } from './GuideTip';

describe('the first steps', () => {
  it('tick in order: a share does not show as done above steps that are not', () => {
    expect(stepsDone({ uploads: 0, reviewed: 0, shares: 1 })).toEqual([false, false, false]);
    expect(stepsDone({ uploads: 38, reviewed: 0, shares: 1 })).toEqual([true, false, false]);
  });

  it('are all done once each has been', () => {
    expect(stepsDone({ uploads: 2, reviewed: 1, shares: 1 })).toEqual([true, true, true]);
  });
});
