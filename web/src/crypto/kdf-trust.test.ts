import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchKdf, prepareSignIn } from './vault-client';
import { rememberKdf, KdfRefusedError } from './kdf-trust';

const answer = (body: unknown) => (async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
const salt = 'c2FsdHNhbHRzYWx0c2FsdA';
const usual = { vault: true as const, salt, params: { alg: 'argon2id13' as const, ops: 3, memKiB: 65536 } };

/** The device decides what to send from the server's answer about how to derive its credential (S-37): a wrong answer must send nothing. */
describe('the key derivation answer the server gives', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  });
  afterEach(() => vi.unstubAllGlobals());

  const derive = vi.fn(async () => ({ masterKey: new Uint8Array(32), authValue: 'derived' }));
  beforeEach(() => derive.mockClear());

  it('is not believed when it says no vault for an address that had one: the password is not returned', async () => {
    rememberKdf('person@example.com', usual);
    await expect(prepareSignIn('person@example.com', 'the master password', answer({ vault: false }), derive)).rejects.toBeInstanceOf(KdfRefusedError);
    expect(derive).not.toHaveBeenCalled();
  });

  it('is not believed when it names a weaker cost than this browser saw for the address', async () => {
    rememberKdf('person@example.com', usual);
    const weaker = { ...usual, params: { alg: 'argon2id13' as const, ops: 2, memKiB: 19456 } };
    await expect(prepareSignIn('person@example.com', 'the master password', answer(weaker), derive)).rejects.toBeInstanceOf(KdfRefusedError);
    expect(derive).not.toHaveBeenCalled();
  });

  it('remembers the address by its normal form, so another spelling of it is held to the same', async () => {
    rememberKdf('  Person@Example.com ', usual);
    await expect(fetchKdf('person@example.com', answer({ vault: false }))).rejects.toBeInstanceOf(KdfRefusedError);
  });

  it.each([
    ['fewer passes than the minimum', { ops: 1, memKiB: 65536 }],
    ['less memory than the minimum', { ops: 3, memKiB: 1024 }],
    ['more memory than a phone has (4 GiB)', { ops: 3, memKiB: 4 * 1024 * 1024 }],
    ['more passes than the ceiling', { ops: 100, memKiB: 65536 }],
    ['a cost that is not a whole number', { ops: 3.5, memKiB: 65536 }],
  ])('is refused when it names %s, even for a first sign-in', async (_name, cost) => {
    const bad = { ...usual, params: { alg: 'argon2id13', ...cost } };
    await expect(prepareSignIn('new@example.com', 'the master password', answer(bad), derive)).rejects.toBeInstanceOf(KdfRefusedError);
    expect(derive).not.toHaveBeenCalled();
  });

  it('is refused when it names another algorithm', async () => {
    const bad = { ...usual, params: { alg: 'md5', ops: 3, memKiB: 65536 } };
    await expect(fetchKdf('new@example.com', answer(bad))).rejects.toBeInstanceOf(KdfRefusedError);
  });

  it('still lets an address this browser has not seen sign in with an ordinary cost, and an account with no vault yet use its password', async () => {
    const first = await prepareSignIn('new@example.com', 'the master password', answer(usual), derive);
    expect(first.credential).toBe('derived');
    const none = await prepareSignIn('operator@example.com', 'a made password', answer({ vault: false }), derive);
    expect(none.credential).toBe('a made password');
  });

  it('accepts the same or a stronger cost than remembered', async () => {
    rememberKdf('person@example.com', usual);
    const stronger = { ...usual, params: { alg: 'argon2id13' as const, ops: 4, memKiB: 131072 } };
    expect((await prepareSignIn('person@example.com', 'the master password', answer(stronger), derive)).credential).toBe('derived');
    expect((await prepareSignIn('person@example.com', 'the master password', answer(usual), derive)).credential).toBe('derived');
  });
});
