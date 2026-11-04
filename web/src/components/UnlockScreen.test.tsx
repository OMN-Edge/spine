import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import UnlockScreen from './UnlockScreen';
import { vaultState } from '../crypto/vault-state';
import { device } from '../core/client';

/** What the unlock screen says when the sign-in's key was accepted and the records still did not open (Nov 4). */
Object.assign(globalThis, {
  document: { documentElement: { getAttribute: () => null } },
  window: { matchMedia: () => ({ matches: false }), location: { search: '' } },
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');
const draw = () => text(renderToStaticMarkup(<MemoryRouter><UnlockScreen opened={() => undefined} signOut={() => undefined} /></MemoryRouter>));

describe('the unlock screen', () => {
  it('asks for the master password when nothing failed', () => {
    vaultState.forgetOpenFailure();
    expect(draw()).toContain('Type your master password');
  });

  it('says the records did not open, not that the password is wrong, when the core failed after the key was accepted', async () => {
    device.unlock = () => Promise.reject(new Error('a row of pages still clashes'));
    vaultState.stashMaster(new Uint8Array(32));
    await expect(vaultState.startDevice()).rejects.toThrow();
    const shown = draw();
    expect(shown).toContain('We couldn’t load your records on this device.');
    expect(shown).toContain('no need to change it');
    expect(shown).toContain('Copy details for support');
    expect(shown).toContain('What is copied');
    expect(shown).toContain('Failed at: records');
    expect(shown).not.toContain('Type your master password');
    vaultState.forgetOpenFailure();
  });

  it('tries again with the key the sign-in left, though the page has let go of its own copy meanwhile (the browser check found it asked for the password instead)', async () => {
    let calls = 0;
    device.isOpen = () => false;
    device.unlock = () => (++calls === 1 ? Promise.reject(new Error('the server answered 503')) : Promise.resolve());
    vaultState.stashMaster(new Uint8Array(32));
    await expect(vaultState.startDevice()).rejects.toThrow();
    vaultState.stashMaster(null); // what the page does once it has opened the vault itself
    expect(await vaultState.startDevice()).toBe('open');
    expect(calls).toBe(2);
    expect(vaultState.openFailure()).toBeNull();
    // and that key is not kept once the records are open
    expect(await vaultState.startDevice()).toBe('locked');
  });
});
