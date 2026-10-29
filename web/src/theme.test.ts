import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/theme.js runs in the page's <head> before anything else, so it is run here as a page would: in a sandbox that has the few things it
// touches (the <html> element, localStorage, matchMedia, window events), with the device's preference set by the test.
const script = fs.readFileSync(path.resolve(import.meta.dirname, '../public/theme.js'), 'utf8');

function load({ stored, deviceDark = false, storageThrows = false }: { stored?: string; deviceDark?: boolean; storageThrows?: boolean }) {
  const data = new Map<string, string>(stored ? [['spine.theme', stored]] : []);
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(e?: unknown) => void>> = {};
  const device = { matches: deviceDark, addEventListener: (_: string, f: () => void) => { (listeners.device ??= []).push(f); } };
  const sandbox: Record<string, unknown> = {
    document: { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } } },
    matchMedia: () => device,
    localStorage: storageThrows
      ? { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } }
      : { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } },
  };
  sandbox.window = Object.assign(sandbox, { addEventListener: (type: string, f: (e?: unknown) => void) => { (listeners[type] ??= []).push(f); } });
  vm.runInNewContext(script, sandbox);
  const theme = sandbox.spineTheme as { get(): string; set(c: string): void };
  return { theme, attrs, data, device, listeners };
}

describe('public/theme.js', () => {
  it('follows the device when nothing was chosen, and changes with it', () => {
    const page = load({ deviceDark: false });
    expect(page.attrs['data-theme']).toBe('light');
    expect(page.theme.get()).toBe('auto');
    page.device.matches = true;
    page.listeners.device!.forEach(f => f());
    expect(page.attrs['data-theme']).toBe('dark');
  });

  it('is dark on a dark device and light on a light one', () => {
    expect(load({ deviceDark: true }).attrs['data-theme']).toBe('dark');
    expect(load({ deviceDark: false }).attrs['data-theme']).toBe('light');
  });

  it('keeps a choice over the device, in either direction', () => {
    expect(load({ stored: 'light', deviceDark: true }).attrs['data-theme']).toBe('light');
    expect(load({ stored: 'dark', deviceDark: false }).attrs['data-theme']).toBe('dark');
  });

  it('stores a choice, applies it at once, and forgets it when set back to auto', () => {
    const page = load({ deviceDark: false });
    page.theme.set('dark');
    expect(page.attrs['data-theme']).toBe('dark');
    expect(page.data.get('spine.theme')).toBe('dark');
    page.theme.set('auto');
    expect(page.data.has('spine.theme')).toBe(false);
    expect(page.attrs['data-theme']).toBe('light');
  });

  it('treats anything else in storage as auto', () => {
    const page = load({ stored: 'purple', deviceDark: true });
    expect(page.theme.get()).toBe('auto');
    expect(page.attrs['data-theme']).toBe('dark');
  });

  it('still works when the browser will not let the page store anything', () => {
    const page = load({ storageThrows: true, deviceDark: true });
    expect(page.attrs['data-theme']).toBe('dark');
    page.theme.set('light');
    expect(page.attrs['data-theme']).toBe('light'); // for this visit
  });

  it('follows a change made in another tab', () => {
    const page = load({ deviceDark: false });
    page.data.set('spine.theme', 'dark');
    page.listeners.storage!.forEach(f => f({ key: 'spine.theme' }));
    expect(page.attrs['data-theme']).toBe('dark');
    page.data.set('spine.theme', 'light');
    page.listeners.storage!.forEach(f => f({ key: 'something else' }));
    expect(page.attrs['data-theme']).toBe('dark'); // another key is not ours
  });
});

describe('toggleLook', () => {
  // The app's side, over the same stand-in page: what the button does with a click.
  async function withPage(look: 'light' | 'dark', deviceDark: boolean) {
    const set: string[] = [];
    const g = globalThis as Record<string, unknown>;
    g.document = { documentElement: { getAttribute: () => look } };
    g.window = { matchMedia: () => ({ matches: deviceDark }), spineTheme: { get: () => 'auto', set: (c: string) => { set.push(c); } } };
    const { toggleLook } = await import('./theme');
    toggleLook();
    delete g.document; delete g.window;
    return set;
  }

  it('chooses the other look when it differs from the device', async () => {
    expect(await withPage('light', false)).toEqual(['dark']);
    expect(await withPage('dark', true)).toEqual(['light']);
  });

  it("goes back to following the device when the other look is the device's own", async () => {
    expect(await withPage('dark', false)).toEqual(['auto']);
    expect(await withPage('light', true)).toEqual(['auto']);
  });
});
