import { describe, it, expect } from 'vitest';
import { requireWhereExpected } from '../testing/tools.js';

describe('a tool the tests need', () => {
  it('lets the tests skip on a machine that has not got it, as on a laptop', () => {
    expect(requireWhereExpected(false, {})).toBe(false);
    expect(requireWhereExpected(false, { CI: '' })).toBe(false);
  });

  it('is a failure, not a skip, where CI is set', () => {
    expect(() => requireWhereExpected(false, { CI: 'true' })).toThrow(/poppler-utils is not installed/);
    expect(() => requireWhereExpected(false, { CI: '1' })).toThrow(/would be skipped and still look green/);
  });

  it('is not an error when it is there', () => {
    expect(requireWhereExpected(true, { CI: 'true' })).toBe(true);
    expect(requireWhereExpected(true, {})).toBe(true);
  });
});
