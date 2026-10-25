import { describe, it, expect } from 'vitest';
import { orderedRowId, randomRowId, starterTagId } from '../store/ids.js';

describe('row keys that no longer come from the engine’s counter', () => {
  it('stay whole numbers a browser holds exactly', () => {
    for (const id of [randomRowId(), starterTagId('u', 'Cardiology'), orderedRowId()]) {
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(String(id).length).toBeLessThanOrEqual(16);
    }
  });

  it('starter tags are the same on every device and differ by name and by person', () => {
    expect(starterTagId('u', 'Lab')).toBe(starterTagId('u', 'Lab'));
    expect(starterTagId('u', 'Lab')).not.toBe(starterTagId('u', 'Imaging'));
    expect(starterTagId('u', 'Lab')).not.toBe(starterTagId('v', 'Lab'));
  });

  it('random keys do not repeat', () => {
    expect(new Set(Array.from({ length: 5000 }, randomRowId)).size).toBe(5000);
  });

  it('ordered keys rise in the order they were made, even inside one millisecond or when the clock steps back', () => {
    const now = Date.UTC(2026, 9, 24);
    const made = Array.from({ length: 3000 }, () => orderedRowId(now));
    expect(made).toEqual([...made].sort((a, b) => a - b));
    expect(new Set(made).size).toBe(made.length);
    expect(orderedRowId(now - 60_000)).toBeGreaterThan(made[made.length - 1]);
    expect(orderedRowId(Date.UTC(2126, 0, 1))).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
