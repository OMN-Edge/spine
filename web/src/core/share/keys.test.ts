import { describe, it, expect } from 'vitest';
import { normaliseCard, EMPTY_CARD } from 'spine-core/emergency';
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

  it('seals an emergency card so that the key in the address opens it, here and nowhere else', async () => {
    const key = await newShareKey();
    const card = normaliseCard({ ...EMPTY_CARD, name: 'Jane Example', allergies: ['penicillin'] });
    const sealed = await sealPart(key, 'card-aaaa', 'card', new TextEncoder().encode(JSON.stringify(card)));
    expect(new TextDecoder().decode(sealed)).not.toContain('penicillin');
    expect(normaliseCard(JSON.parse(new TextDecoder().decode(await openPart(key, 'card-aaaa', 'card', sealed)))).allergies).toEqual(['penicillin']);
    await expect(openPart(key, 'card-bbbb', 'card', sealed)).rejects.toThrow();
    await expect(openPart(key, 'card-aaaa', 'db', sealed)).rejects.toThrow();
  });
});
