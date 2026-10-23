import { describe, it, expect } from 'vitest';
import { newShareKey, newVisitorKeys, openPart, sealPart, unwrapShareKey, wrapShareKey } from './keys';

describe('the keys of a share', () => {
  it('seals a part so that only the key and the same place open it', async () => {
    const key = await newShareKey();
    const sealed = await sealPart(key, 'share-aaaa', 'db', new TextEncoder().encode('Hemoglobin 13.5'));
    expect(new TextDecoder().decode(await openPart(key, 'share-aaaa', 'db', sealed))).toBe('Hemoglobin 13.5');
    await expect(openPart(await newShareKey(), 'share-aaaa', 'db', sealed)).rejects.toThrow();
    await expect(openPart(key, 'share-bbbb', 'db', sealed)).rejects.toThrow();
    await expect(openPart(key, 'share-aaaa', 'blob-0', sealed)).rejects.toThrow();
    sealed[sealed.length - 1] ^= 1;
    await expect(openPart(key, 'share-aaaa', 'db', sealed)).rejects.toThrow();
  });

  it('wraps the share key to one browser, whose key pair alone opens it', async () => {
    const shareKey = await newShareKey();
    const visitor = await newVisitorKeys();
    const wrapped = await wrapShareKey(shareKey, visitor.publicKey);
    expect(wrapped.length).toBeGreaterThan(60);
    expect(wrapped).not.toContain(shareKey);
    expect(await unwrapShareKey(wrapped, visitor)).toBe(shareKey);
    expect(await unwrapShareKey(wrapped, await newVisitorKeys())).toBeNull();
  });
});
