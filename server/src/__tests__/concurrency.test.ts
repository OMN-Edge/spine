import { describe, it, expect } from 'vitest';
import { limiter, mapLimit } from '../concurrency.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Tracks how many of its calls are running at once. */
function gauge() {
  let now = 0;
  let peak = 0;
  return {
    peak: () => peak,
    async run<T>(work: () => Promise<T>): Promise<T> {
      now += 1; peak = Math.max(peak, now);
      try { return await work(); } finally { now -= 1; }
    },
  };
}

describe('mapLimit', () => {
  it('never has more than `limit` calls in flight, and does use the limit', async () => {
    const g = gauge();
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, i => g.run(() => sleep(5 + (i % 3))));
    expect(g.peak()).toBe(4);
  });

  it('returns results in the order of the items, whatever order they finish in', async () => {
    const out = await mapLimit([30, 5, 20, 1], 4, async ms => { await sleep(ms); return ms; });
    expect(out).toEqual([30, 5, 20, 1]);
  });

  it('starts items in order, so mocks and logs see them in order', async () => {
    const started: number[] = [];
    await mapLimit([0, 1, 2, 3, 4, 5], 3, async i => { started.push(i); await sleep(2); });
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('with a limit of 1 is a plain sequential loop', async () => {
    const g = gauge();
    const order: number[] = [];
    await mapLimit([1, 2, 3], 1, i => g.run(async () => { order.push(i); await sleep(2); }));
    expect(g.peak()).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  it('throws the first error and starts nothing new after it', async () => {
    const started: number[] = [];
    await expect(mapLimit(Array.from({ length: 10 }, (_, i) => i), 2, async i => {
      started.push(i);
      await sleep(5);
      if (i === 1) throw new Error('page 1 failed');
      return i;
    })).rejects.toThrow('page 1 failed');
    // Two were in flight when it failed (0 and 1), and 2 and 3 may have been picked up as 0 finished; no more.
    expect(started.length).toBeLessThanOrEqual(4);
    expect(started).not.toContain(9);
  });

  it('copes with no items, and with a limit larger than the items', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapLimit([1, 2], 50, async i => i * 2)).toEqual([2, 4]);
  });

  it('treats a limit below 1 as 1 instead of doing nothing', async () => {
    expect(await mapLimit([1, 2, 3], 0, async i => i)).toEqual([1, 2, 3]);
  });
});

describe('limiter', () => {
  it('keeps at most `limit` calls running, however many are queued', async () => {
    const g = gauge();
    const run = limiter(2);
    await Promise.all(Array.from({ length: 12 }, () => run(() => g.run(() => sleep(4)))));
    expect(g.peak()).toBe(2);
  });

  it('serialises with a limit of 1, in the order asked', async () => {
    const run = limiter(1);
    const order: number[] = [];
    await Promise.all([3, 1, 2].map(n => run(async () => { order.push(n); await sleep(2); })));
    expect(order).toEqual([3, 1, 2]);
  });

  it('frees its slot when a call fails, so one failure does not block the queue', async () => {
    const run = limiter(1);
    const results = await Promise.allSettled([
      run(async () => { throw new Error('boom'); }),
      run(async () => 'next'),
    ]);
    expect(results.map(r => r.status)).toEqual(['rejected', 'fulfilled']);
  });
});
