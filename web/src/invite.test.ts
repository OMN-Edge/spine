import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rememberJoined, recentlyJoined } from './invite';

/** A tab's session storage, as far as the helpers use it. */
function fakeSession() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

describe('that joining worked, for the page of people', () => {
  beforeEach(() => { (globalThis as { sessionStorage?: unknown }).sessionStorage = fakeSession(); });
  afterEach(() => { delete (globalThis as { sessionStorage?: unknown }).sessionStorage; });

  it('is there for a page drawn again right after, and for a minute', () => {
    expect(recentlyJoined(1_000)).toBe('');
    rememberJoined('owner@example.com', 1_000);
    expect(recentlyJoined(1_000)).toBe('owner@example.com');
    expect(recentlyJoined(1_000 + 59_999)).toBe('owner@example.com');
  });

  it('is not shown on a later visit', () => {
    rememberJoined('owner@example.com', 1_000);
    expect(recentlyJoined(1_000 + 60_000)).toBe('');
    expect(recentlyJoined(500)).toBe(''); // a clock that went back is not a reason to show it
  });

  it('says nothing, and breaks nothing, where the browser keeps nothing or what was kept is not ours', () => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    expect(() => rememberJoined('owner@example.com')).not.toThrow();
    expect(recentlyJoined()).toBe('');
    (globalThis as { sessionStorage?: unknown }).sessionStorage = { getItem: () => '{"owner":42,"at":"x"}', setItem: () => undefined, removeItem: () => undefined };
    expect(recentlyJoined()).toBe('');
    (globalThis as { sessionStorage?: unknown }).sessionStorage = { getItem: () => 'not json', setItem: () => undefined, removeItem: () => undefined };
    expect(recentlyJoined()).toBe('');
  });
});
