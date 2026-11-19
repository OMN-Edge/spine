import { describe, expect, it } from 'vitest';
import { foundingStage } from './founding';

/** The three things the founding offer says about its places (T-13). */
describe('the founding places', () => {
  it('say no number while fewer than a hundred are taken', () => {
    expect(foundingStage(500)).toBe('quiet');
    expect(foundingStage(478)).toBe('quiet');
    expect(foundingStage(401)).toBe('quiet');
  });

  it('say how many are taken from a hundred taken', () => {
    expect(foundingStage(400)).toBe('count');
    expect(foundingStage(350)).toBe('count');
    expect(foundingStage(101)).toBe('count');
  });

  it('say how many are left from a hundred left', () => {
    expect(foundingStage(100)).toBe('scarce');
    expect(foundingStage(80)).toBe('scarce');
    expect(foundingStage(1)).toBe('scarce');
  });
});
