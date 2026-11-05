import { describe, it, expect } from 'vitest';
import { visitorCode } from '../share-code.js';

/**
 * SECURITY.md S-40. The owner approves a browser by its key, and the server carries the key, so a request the server made up looks like a doctor's.
 * Both sides show a short code made from the key, and the owner compares them aloud before approving.
 */
const key = (n: number) => Buffer.alloc(32, n).toString('base64url');

describe('the code a visitor and the owner compare', () => {
  it('is eight letters and digits in two groups, with none that read alike (no 0, O, 1 or I)', async () => {
    const code = await visitorCode(key(7));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it('is the same for the same key, and different for another key', async () => {
    expect(await visitorCode(key(1))).toBe(await visitorCode(key(1)));
    const codes = new Set<string>();
    for (let n = 0; n < 200; n++) codes.add(await visitorCode(key(n)));
    expect(codes.size).toBe(200);
  });

  it('says nothing of the key it is made from', async () => {
    const code = await visitorCode(key(9)).then(c => c.replace('-', '').toLowerCase());
    expect(key(9).toLowerCase()).not.toContain(code);
  });
});
