import { describe, expect, it } from 'vitest';
import { objectUrlCache } from './object-urls';

describe('the addresses of the pictures shown', () => {
  it('fetches a picture once, and again after a load that failed', async () => {
    // Nov 4: a share's page image that failed to load once stayed blank (its alt text in a box) until the page was reloaded.
    let calls = 0;
    let fail = true;
    const cache = objectUrlCache(async url => { calls++; if (fail) throw new Error('not yet'); return `blob:${url}`; }, () => undefined, 10);
    await expect(cache.get('/p/1')).rejects.toThrow('not yet');
    fail = false;
    expect(await cache.get('/p/1')).toBe('blob:/p/1');
    expect(await cache.get('/p/1')).toBe('blob:/p/1');
    expect(calls).toBe(2);
  });

  it('lets the oldest go beyond what it keeps, and revokes their addresses', async () => {
    const revoked: string[] = [];
    const cache = objectUrlCache(async url => `blob:${url}`, a => revoked.push(a), 2);
    await cache.get('/a'); await cache.get('/b'); await cache.get('/a'); await cache.get('/c');
    await new Promise(r => setTimeout(r, 0));
    expect(revoked).toEqual(['blob:/b']);
  });
});
