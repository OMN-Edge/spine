import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createChangeLog, currentClockOffset, HybridClock, observeServerClock, REPLICATED, resetServerClock, serverClockOffset, type Rows } from '../store/sync.js';
import type { Change, ChangeLog } from '../store/types.js';
import { MemoryRows, type TableSpec } from '../testing/memory-rows.js';

/**
 * The rules for syncing devices (store/sync.ts) with nothing under them but maps. `changes.test.ts` runs the same rules over SQLite through
 * the repositories; here they are checked alone, over a store that is not SQLite, which is also the proof that they need no engine.
 */
const SPEC: Record<string, TableSpec> = {
  pages: { key: ['id'], unique: [['file', 'place']] },
  tags: { key: ['id'], unique: [['name']] },
  document_tags: { key: ['document_id', 'tag_id'] },
  documents: { key: ['id'] },
};

let tick: number;
class Device {
  readonly rows: MemoryRows;
  readonly log: ChangeLog;
  constructor(name: string) {
    this.rows = new MemoryRows(SPEC, () => tick);
    this.log = createChangeLog(this.rows, new HybridClock(name.padEnd(8, '0')));
  }
  get held() {
    return Object.fromEntries(Object.keys(SPEC).map(t => [t, this.rows.rowsOf(t).map(r => JSON.stringify(r)).sort()]));
  }
}
const device = (name: string) => new Device(name);

async function exchange(...devices: Device[]) {
  const sent = await Promise.all(devices.map(d => d.log.drain()));
  for (let i = 0; i < devices.length; i++) for (let j = 0; j < devices.length; j++) if (i !== j) await devices[j].log.apply(sent[i]);
}

beforeEach(() => { tick = Date.UTC(2026, 9, 1); });

describe('the clock', () => {
  it('stamps in order, as text, and the counter separates writes in one millisecond', () => {
    const clock = new HybridClock('aaaaaaaa');
    const a = clock.stamp(1000);
    const b = clock.stamp(1000);
    const c = clock.stamp(1001);
    expect([a, b, c]).toEqual([...[a, b, c]].sort());
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).toMatch(/^\d{14}\.\d{5}\.aaaaaaaa$/);
  });

  it('never goes behind a change it has seen from elsewhere', () => {
    const clock = new HybridClock('aaaaaaaa');
    clock.observe('00000000009999.00007.bbbbbbbb');
    expect(clock.stamp(5) > '00000000009999.00007.bbbbbbbb').toBe(true);
  });

  it('ignores a stamp it cannot read', () => {
    const clock = new HybridClock('aaaaaaaa');
    clock.observe('garbage');
    expect(clock.stamp(1)).toMatch(/^00000000000001\.00000\./);
  });

  it('two devices do not produce the same stamp', () => {
    expect(new HybridClock().device).not.toBe(new HybridClock().device);
  });
});

describe('the server’s clock', () => {
  afterEach(resetServerClock);
  const at = (h: number, m = 0, s = 0) => Date.UTC(2026, 9, 1, h, m, s);
  const header = (ms: number) => new Date(ms).toUTCString();

  it('reads the server’s time from the Date header, as of the middle of the request (the header is cut to the second)', () => {
    // the device thought it was 11:00:00 and the answer took 200 ms to come; the server said 12:00:00
    expect(serverClockOffset(header(at(12)), at(11), at(11) + 200)).toBe(3_600_000 + 500 - 100);
  });

  it('reads nothing from a missing or unreadable header', () => {
    expect(serverClockOffset(null, 0, 10)).toBeNull();
    expect(serverClockOffset('not a date', 0, 10)).toBeNull();
    observeServerClock(null, 0, 10);
    expect(currentClockOffset()).toBe(0);
  });

  it('puts a write made on a clock a day ahead at about the server’s time, so a wrong clock does not decide which edit was later', () => {
    const serverNow = at(12);
    const localAhead = serverNow + 86_400_000; // this device thinks it is a day later than it is
    observeServerClock(header(serverNow), localAhead, localAhead + 100);
    const stamp = new HybridClock('aaaaaaaa').stamp(localAhead + 60_000); // a write a minute later by this device's clock
    const wall = Number(stamp.slice(0, 14));
    expect(Math.abs(wall - (serverNow + 60_000))).toBeLessThan(1_000);
  });

  it('keeps the reading of the quickest round trip, and ignores a slower one, a very slow one and a difference of a few seconds', () => {
    observeServerClock(header(at(12)), at(11), at(11) + 100);
    const quick = currentClockOffset();
    expect(quick).toBeGreaterThan(3_000_000);
    observeServerClock(header(at(13)), at(11), at(11) + 900); // slower: its reading is worth less
    expect(currentClockOffset()).toBe(quick);
    resetServerClock();
    observeServerClock(header(at(13)), at(11), at(11) + 20_000); // too slow to say anything
    expect(currentClockOffset()).toBe(0);
    observeServerClock(header(at(11) + 3_000), at(11), at(11) + 100); // three seconds: noise, not a wrong clock
    expect(currentClockOffset()).toBe(0);
  });

  it('leaves a device with a right clock alone', () => {
    observeServerClock(header(at(11)), at(11), at(11) + 80);
    expect(currentClockOffset()).toBe(0);
    expect(new HybridClock('aaaaaaaa').stamp(5_000)).toMatch(/^00000000005000\./);
  });
});

describe('draining and applying', () => {
  it('a drain gives each row once with its last state, and then nothing', async () => {
    const a = device('a');
    a.rows.set('documents', { id: 'd1', title: 'first' });
    a.rows.set('documents', { id: 'd1', title: 'second' });
    a.rows.set('documents', { id: 'd2', title: 'other' });
    const changes = await a.log.drain();
    expect(changes).toHaveLength(2);
    expect(changes.find(c => c.k.id === 'd1')!.r).toEqual({ id: 'd1', title: 'second' });
    expect(await a.log.drain()).toEqual([]);
  });

  it('says whether its own writes wait to be drained', async () => {
    const a = device('a');
    expect(await a.log.pending()).toBe(false);
    a.rows.set('documents', { id: 'd1', title: 'x' });
    expect(await a.log.pending()).toBe(true);
    await a.log.drain();
    expect(await a.log.pending()).toBe(false);
  });

  it('refuses to apply while its own writes wait, and to drain or apply inside a transaction', async () => {
    const a = device('a');
    a.rows.set('documents', { id: 'd1', title: 'x' });
    await expect(a.log.apply([{ t: 'documents', k: { id: 'd9' }, r: { id: 'd9', title: 'y' }, h: '00000000000001.00000.bbbbbbbb' }])).rejects.toThrow(/drain/);
    await expect(a.log.dump()).rejects.toThrow(/drain/);
    await a.log.drain();
    let inside: Promise<unknown> | undefined;
    a.rows.atomic(() => { inside = a.log.drain().catch(e => e); });
    expect(String(await inside)).toMatch(/inside a transaction/);
  });

  it('skips a table it does not hold, and applies nothing for an empty list', async () => {
    const a = device('a');
    expect(await a.log.apply([])).toBe(0);
    expect(await a.log.apply([{ t: 'elsewhere', k: { id: 1 }, r: { id: 1 }, h: '00000000000001.00000.bbbbbbbb' }])).toBe(0);
  });

  it('a change older than what is held for the row is not applied', async () => {
    const a = device('a');
    tick += 10;
    a.rows.set('documents', { id: 'd1', title: 'new' });
    await a.log.drain();
    const n = await a.log.apply([{ t: 'documents', k: { id: 'd1' }, r: { id: 'd1', title: 'old' }, h: '00000000000001.00000.bbbbbbbb' }]);
    expect(n).toBe(0);
    expect(a.rows.get('documents', { id: 'd1' })!.title).toBe('new');
  });

  it('a change that is applied twice changes the rows once', async () => {
    const a = device('a');
    const change: Change = { t: 'documents', k: { id: 'd1' }, r: { id: 'd1', title: 'x' }, h: '00000000000001.00000.bbbbbbbb' };
    expect(await a.log.apply([change])).toBe(1);
    expect(await a.log.apply([change])).toBe(0);
  });

  it('a merge that fails leaves nothing half done', async () => {
    const a = device('a');
    const bad = { t: 'documents', k: { id: 'd1' }, get r(): never { throw new Error('boom'); }, h: '00000000000002.00000.bbbbbbbb' } as unknown as Change;
    await expect(a.log.apply([{ t: 'documents', k: { id: 'd0' }, r: { id: 'd0', title: 'fine' }, h: '00000000000001.00000.bbbbbbbb' }, bad])).rejects.toThrow('boom');
    expect(a.rows.rowsOf('documents')).toEqual([]);
  });
});

describe('devices that write and then exchange changes', () => {
  it('edits to different rows are both kept, and the later edit to one row wins whichever way it arrives', async () => {
    const a = device('a');
    const b = device('b');
    a.rows.set('documents', { id: 'd1', title: 'start' });
    await exchange(a, b);
    a.rows.set('documents', { id: 'd1', title: 'from a' });
    tick += 5;
    b.rows.set('documents', { id: 'd1', title: 'from b' });
    b.rows.set('documents', { id: 'd2', title: 'only b' });
    await exchange(a, b);
    expect(a.held).toEqual(b.held);
    expect(a.rows.get('documents', { id: 'd1' })!.title).toBe('from b');
    expect(a.rows.get('documents', { id: 'd2' })!.title).toBe('only b');
  });

  it('a deletion is a change: an older edit that arrives after it does not bring the row back', async () => {
    const a = device('a');
    const b = device('b');
    a.rows.set('documents', { id: 'd1', title: 'x' });
    await exchange(a, b);
    b.rows.set('documents', { id: 'd1', title: 'edited' });
    const edit = await b.log.drain();
    tick += 5;
    a.rows.del('documents', { id: 'd1' });
    const gone = await a.log.drain();
    await b.log.apply(gone);
    await a.log.apply(edit);
    expect(a.rows.get('documents', { id: 'd1' })).toBeUndefined();
    expect(b.rows.get('documents', { id: 'd1' })).toBeUndefined();
  });

  it('a new device given a dump holds the same rows, and the deletions', async () => {
    const a = device('a');
    a.rows.set('documents', { id: 'd1', title: 'x' });
    a.rows.set('documents', { id: 'd2', title: 'y' });
    await a.log.drain();
    tick += 5;
    a.rows.del('documents', { id: 'd2' });
    await a.log.drain();
    const dump = await a.log.dump();
    expect(dump.filter(c => c.r === null)).toHaveLength(1);
    const fresh = device('c');
    await fresh.log.apply(dump);
    expect(fresh.held).toEqual(a.held);
    // and the deletion still beats an older copy of the row
    await fresh.log.apply([{ t: 'documents', k: { id: 'd2' }, r: { id: 'd2', title: 'y' }, h: '00000000000001.00000.bbbbbbbb' }]);
    expect(fresh.rows.get('documents', { id: 'd2' })).toBeUndefined();
  });

  it('the same tag made on two devices under two keys is one tag, and the rows that name it follow', async () => {
    const a = device('a');
    const b = device('b');
    a.rows.set('tags', { id: 1, name: 'cardiology' });
    a.rows.set('document_tags', { document_id: 'd1', tag_id: 1 });
    tick += 3;
    b.rows.set('tags', { id: 2, name: 'cardiology' });
    b.rows.set('document_tags', { document_id: 'd2', tag_id: 2 });
    await exchange(a, b);
    await exchange(a, b);
    for (const d of [a, b]) {
      expect(d.rows.rowsOf('tags')).toHaveLength(1);
      const kept = d.rows.rowsOf('tags')[0].id;
      expect(d.rows.rowsOf('document_tags').map(r => r.tag_id)).toEqual([kept, kept]);
      expect(d.rows.rowsOf('document_tags')).toHaveLength(2);
    }
  });

  it('two pages for one place: the newer change keeps it, in either order, and the older is dropped', async () => {
    for (const order of [0, 1]) {
      const a = device('a');
      const b = device('b');
      a.rows.set('pages', { id: 'pa', file: 'f', place: 1 });
      tick += 5;
      b.rows.set('pages', { id: 'pb', file: 'f', place: 1 });
      const [fromA, fromB] = [await a.log.drain(), await b.log.drain()];
      if (order === 0) { await a.log.apply(fromB); await b.log.apply(fromA); } else { await b.log.apply(fromA); await a.log.apply(fromB); }
      expect(a.held).toEqual(b.held);
      expect(a.rows.rowsOf('pages').map(r => r.id)).toEqual(['pb']);
    }
  });

  it('devices that edit at random and then exchange in different orders end with the same rows', async () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let round = 0; round < 60; round++) {
      const devices = [device('a'), device('b'), device('c')];
      for (let step = 0; step < 12; step++) {
        tick += rand(3);
        const d = devices[rand(3)];
        const id = `d${rand(4)}`;
        const op = rand(6);
        if (op === 0) d.rows.del('documents', { id });
        else if (op === 1) { try { d.rows.set('pages', { id: `p${rand(5)}`, file: 'f', place: rand(3) }); } catch { /* the place is taken on this device */ } }
        else if (op === 2) { try { d.rows.set('tags', { id: rand(9) + 1, name: ['x', 'y', 'z'][rand(3)] }); } catch { /* the name is taken on this device */ } }
        else d.rows.set('documents', { id, title: `t${rand(100)}` });
        if (rand(5) === 0) await exchange(devices[0], devices[1], devices[2]);
      }
      const sent = await Promise.all(devices.map(d => d.log.drain()));
      const orders = [[0, 1, 2], [2, 0, 1], [1, 2, 0]];
      devices.forEach((d, i) => {
        // each device receives the others' changes in its own order
        return orders[i].filter(j => j !== i).reduce((p, j) => p.then(() => d.log.apply(sent[j]).then(() => undefined)), Promise.resolve());
      });
      await new Promise(r => setTimeout(r, 0));
      await exchange(...devices);
      await exchange(...devices);
      expect(devices[1].held.documents).toEqual(devices[0].held.documents);
      expect(devices[2].held.documents).toEqual(devices[0].held.documents);
      expect(devices[1].held.pages).toEqual(devices[0].held.pages);
      expect(devices[2].held.pages).toEqual(devices[0].held.pages);
    }
  });
});

describe('the list of synced tables', () => {
  it('names each table once', () => {
    expect(new Set(REPLICATED).size).toBe(REPLICATED.length);
  });

  it('is what a store that holds none of them reports as nothing to sync', async () => {
    const empty: Rows = new MemoryRows({});
    expect(await createChangeLog(empty).drain()).toEqual([]);
  });
});
