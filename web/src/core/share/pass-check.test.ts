import { describe, it, expect } from 'vitest';
import { newShareKey, sharePassCheck } from './keys';

/** SECURITY.md S-48: the value a recipient shows to get the pass for its model calls. */
describe('the check a share’s key makes for its pass', () => {
  it('is the same for the same key and id, and differs for another key or another id', async () => {
    const key = await newShareKey();
    const a = await sharePassCheck(key, 'share-one');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sharePassCheck(key, 'share-one')).toBe(a);
    expect(await sharePassCheck(key, 'share-two')).not.toBe(a);
    expect(await sharePassCheck(await newShareKey(), 'share-one')).not.toBe(a);
  });

  it('does not show the key', async () => {
    const key = await newShareKey();
    expect(await sharePassCheck(key, 'share-one')).not.toContain(key);
  });
});
