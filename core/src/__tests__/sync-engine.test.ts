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

describe('columns of one row', () => {
  const doc = { id: 'd1', title: 'Original', date: '2026-01-01', notes: 'none' };
  /** Two devices that both hold `doc`, with nothing left to send. */
  async function pair() {
    const a = device('aaaa'); const b = device('bbbb');
    a.rows.set('documents', doc);
    await exchange(a, b);
    tick += 1000;
    return { a, b };
  }
  const row = (d: Device) => d.rows.get('documents', { id: 'd1' });

  it('keeps both edits when two devices change different columns of a row before they meet', async () => {
    const { a, b } = await pair();
    a.rows.set('documents', { ...doc, title: 'Renamed' });
    tick += 1000;
    b.rows.set('documents', { ...doc, date: '2026-02-02' }); // later than a’s edit, and from a row that still had the old title
    await exchange(a, b);
    expect(row(a)).toEqual({ ...doc, title: 'Renamed', date: '2026-02-02' });
    expect(row(b)).toEqual(row(a));
  });

  it('gives a column both devices changed to the later edit', async () => {
    const { a, b } = await pair();
    a.rows.set('documents', { ...doc, title: 'From a' });
    tick += 1000;
    b.rows.set('documents', { ...doc, title: 'From b' });
    await exchange(a, b);
    expect(row(a)?.title).toBe('From b');
    expect(row(b)?.title).toBe('From b');
  });

  it('says in a change which columns it wrote, and writes only those when it is a small edit', async () => {
    const { a } = await pair();
    a.rows.set('documents', { ...doc, date: '2026-03-03' });
    const sent = await a.log.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.c).toEqual(['date']);
    expect(sent[0]!.r).toEqual({ ...doc, date: '2026-03-03' });
  });

  it('sends nothing for an update that wrote the values it had', async () => {
    const { a } = await pair();
    a.rows.set('documents', { ...doc });
    expect(await a.log.drain()).toEqual([]);
  });

  it('sends a new row whole, even when it was changed again before it was sent', async () => {
    const a = device('aaaa');
    a.rows.set('documents', doc);
    a.rows.set('documents', { ...doc, title: 'Changed at once' });
    const sent = await a.log.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.c).toBeUndefined();
  });

  it('collects the columns of several edits made before they were sent', async () => {
    const { a, b } = await pair();
    a.rows.set('documents', { ...doc, title: 'One' });
    a.rows.set('documents', { ...doc, title: 'One', notes: 'Two' });
    const sent = await a.log.drain();
    expect(sent[0]!.c).toEqual(['notes', 'title']);
    await b.log.apply(sent);
    expect(row(b)).toEqual({ ...doc, title: 'One', notes: 'Two' });
  });

  it('ends the same whichever order the changes arrive in', async () => {
    const { a, b } = await pair();
    const c = device('cccc');
    const base = await a.log.dump();
    await c.log.apply(base);
    a.rows.set('documents', { ...doc, title: 'A1' });
    tick += 10;
    b.rows.set('documents', { ...doc, date: 'B1' });
    tick += 10;
    c.rows.set('documents', { ...doc, title: 'C1', notes: 'C1' });
    const sent = [await a.log.drain(), await b.log.drain(), await c.log.drain()];
    const all = sent.flat();
    const orders = [[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0], [2, 0, 1], [0, 2, 1]];
    const results = new Set<string>();
    for (const order of orders) {
      const fresh = device('dddd');
      await fresh.log.apply(base);
      for (const i of order) await fresh.log.apply(sent[i]!);
      results.add(JSON.stringify(row(fresh)));
    }
    // and all at once, which sorts them
    const once = device('eeee');
    await once.log.apply(base);
    await once.log.apply(all);
    results.add(JSON.stringify(row(once)));
    expect(results.size).toBe(1);
    expect(row(once)).toEqual({ id: 'd1', title: 'C1', date: 'B1', notes: 'C1' });
  });

  it('does not let an older write of a column beat a newer one that arrived first', async () => {
    const { a, b } = await pair();
    b.rows.set('documents', { ...doc, title: 'Old' });
    const old = await b.log.drain();
    tick += 5000;
    a.rows.set('documents', { ...doc, title: 'New' });
    await a.log.drain();
    await a.log.apply(old);
    expect(row(a)?.title).toBe('New');
  });

  it('keeps a deletion that is later than an edit, and lets an edit later than the deletion bring the row back', async () => {
    const { a, b } = await pair();
    a.rows.set('documents', { ...doc, title: 'Edited' });
    tick += 1000;
    b.rows.del('documents', { id: 'd1' });
    await exchange(a, b);
    expect(row(a)).toBeUndefined();
    expect(row(b)).toBeUndefined();

    const { a: c, b: d } = await pair();
    d.rows.del('documents', { id: 'd1' });
    tick += 1000;
    c.rows.set('documents', { ...doc, date: 'After' });
    await exchange(c, d);
    expect(row(c)).toEqual({ ...doc, date: 'After' });
    expect(row(d)).toEqual(row(c));
  });

  it('reads a change from before columns were stamped as the whole row', async () => {
    const { a } = await pair();
    tick += 1000;
    const old: Change = { t: 'documents', k: { id: 'd1' }, r: { id: 'd1', title: 'Whole', date: 'Whole', notes: 'Whole' }, h: `${String(tick).padStart(14, '0')}.00000.cccccccc` };
    await a.log.apply([old]);
    expect(row(a)).toEqual(old.r);
    // and a column edited later is not beaten by a whole row from before it, while its other columns still take what is newer than they are
    tick += 1000;
    a.rows.set('documents', { ...old.r!, title: 'Later' } as Record<string, string>);
    await a.log.drain();
    const earlier: Change = { ...old, r: { id: 'd1', title: 'Whole', date: 'Earlier', notes: 'Whole' }, h: `${String(tick - 500).padStart(14, '0')}.00000.dddddddd` };
    await a.log.apply([earlier]);
    expect(row(a)).toEqual({ id: 'd1', title: 'Later', date: 'Earlier', notes: 'Whole' });
  });

  it('gives a device started from a dump the same row and the same standing of each column', async () => {
    const { a, b } = await pair();
    a.rows.set('documents', { ...doc, title: 'A edit' });
    tick += 1000;
    b.rows.set('documents', { ...doc, date: 'B edit' });
    await exchange(a, b);
    const fresh = device('ffff');
    await fresh.log.apply(await a.log.dump());
    expect(row(fresh)).toEqual(row(a));
    // a write of the title older than a’s edit loses on both
    const late = device('gggg');
    late.rows.set('documents', doc);
    await late.log.drain();
    const staleTitle: Change = { t: 'documents', k: { id: 'd1' }, r: { ...doc, title: 'Stale' }, h: `${String(Date.UTC(2026, 9, 1) + 500).padStart(14, '0')}.00000.zzzzzzzz`, c: ['title'] };
    await fresh.log.apply([staleTitle]);
    await a.log.apply([staleTitle]);
    expect(row(fresh)?.title).toBe('A edit');
    expect(row(a)?.title).toBe('A edit');
    // and the dump of the fresh device is the same as the dump of the old one
    const same = (x: Change[]) => x.map(c => JSON.stringify({ ...c, h: undefined })).sort();
    expect(same(await fresh.log.dump())).toEqual(same(await a.log.dump()));
  });

  it('converges over many random edits of several columns on three devices, delivered in different orders', async () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let round = 0; round < 25; round++) {
      const devices = [device('aaaa'), device('bbbb'), device('cccc')];
      const columns = ['title', 'date', 'notes'];
      devices[0].rows.set('documents', doc);
      await exchange(...devices);
      for (let step = 0; step < 12; step++) {
        tick += 1 + rand(3);
        const d = devices[rand(3)]!;
        const current = d.rows.get('documents', { id: 'd1' });
        if (!current) { if (rand(2) === 0) d.rows.set('documents', { ...doc, title: `back${step}` }); continue; }
        if (rand(10) === 0) d.rows.del('documents', { id: 'd1' });
        else d.rows.set('documents', { ...current, [columns[rand(3)]!]: `v${rand(100)}` });
        if (rand(4) === 0) await exchange(...devices);
      }
      const sent = await Promise.all(devices.map(d => d.log.drain()));
      const orders = [[0, 1, 2], [2, 0, 1], [1, 2, 0]];
      for (let i = 0; i < 3; i++) for (const j of orders[i]!) if (j !== i) await devices[i]!.log.apply(sent[j]!);
      await exchange(...devices);
      await exchange(...devices);
      expect(row(devices[1]!)).toEqual(row(devices[0]!));
      expect(row(devices[2]!)).toEqual(row(devices[0]!));
    }
  });
});
