import { describe, it, expect, afterEach, vi } from 'vitest';
import { currentClockOffset, resetServerClock } from 'spine-core/store/sync';
import { fetchKdf } from './vault-client';

/** The vault client reads the server's time from every answer it gets, so the device stamps its changes on the server's clock. */
describe('the vault client and the server’s clock', () => {
  afterEach(() => { resetServerClock(); vi.unstubAllGlobals(); });

  it('takes the offset from the Date header of an answer, when this device’s clock is an hour behind', async () => {
    const serverNow = Date.now() + 3_600_000; // this device is an hour behind the server
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ vault: false }), { headers: { 'content-type': 'application/json', date: new Date(serverNow).toUTCString() } }));
    await fetchKdf('person@example.com');
    expect(Math.abs(currentClockOffset() - 3_600_000)).toBeLessThan(2_000);
  });

  it('leaves the offset alone when the server’s clock and this one agree', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ vault: false }), { headers: { 'content-type': 'application/json', date: new Date().toUTCString() } }));
    await fetchKdf('person@example.com');
    expect(currentClockOffset()).toBe(0);
  });
});
