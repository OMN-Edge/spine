import { describe, it, expect, beforeEach } from 'vitest';
import { Persistence, type ObjectStore, type ObjectMeta } from './persist';
import { observeServerClock, resetServerClock } from 'spine-core/store/sync';
import { memory } from './shims/fs';
import fs from './shims/fs';
import { openDeviceStore } from './device-store';
import type { Store } from 'spine-core/store/types';

const USER = 'device';
const PROFILE = 'profile-aaaaaaaa';

/** The vault as a Map, with the sequence numbers and the conflict rule of the real one. */
function fakeVault() {
  const objects = new Map<string, { kind: string; profile: string; data: Uint8Array; seq: number; deleted: boolean }>();
  let counter = 0;
  const log = { puts: [] as string[], removes: [] as string[] };
  const store: ObjectStore = {
    async put(kind, id, data, baseSeq) {
      const have = objects.get(id);
      if ((have?.seq ?? 0) !== baseSeq) throw Object.assign(new Error('conflict'), { name: 'ConflictError' });
      objects.set(id, { kind, profile: PROFILE, data: Uint8Array.from(data), seq: ++counter, deleted: false });
      log.puts.push(kind);
      return counter;
    },
    async get(id, kind) {
      const o = objects.get(id);
      if (!o || o.kind !== kind || o.deleted) throw Object.assign(new Error('not found'), { status: 404 });
      return { plaintext: Uint8Array.from(o.data), seq: o.seq };
    },
    getSync(id, kind) {
      const o = objects.get(id);
      if (!o || o.kind !== kind) throw new Error('not found');
      return Uint8Array.from(o.data);
    },
    async remove(id, base) {
      const have = objects.get(id);
      if (have?.seq !== base) throw new Error('conflict');
      objects.delete(id);
      log.removes.push(id);
    },
    async list(since) {
      const metas: ObjectMeta[] = [...objects.entries()].filter(([, o]) => o.seq > since).map(([id, o]) => ({ id, profile_id: o.profile, kind: o.kind, seq: o.seq, deleted: o.deleted }));
      return { objects: metas };
    },
  };
  return { objects, log, store };
}

let n = 0;
const newId = async () => `id-${++n}-xxxxxxxx`;

/** One device: a store of its own over its own database, and the layer that saves it. */
async function device(store: ObjectStore): Promise<{ db: Store; p: Persistence; changed: number[] }> {
  const db = openDeviceStore();
  await db.users.create({ id: USER, email: 'device@local', passwordHash: 'x', createdAt: 'now', verifiedAt: 'now', consent: undefined, starterTags: false });
  const p = new Persistence(store, PROFILE, `ix-${PROFILE}`, newId, { changes: db.changes, files: db.files, userId: USER });
  const changed: number[] = [];
  p.onChanged = () => changed.push(1);
  return { db, p, changed };
}

async function addDoc(db: Store, id: string, title: string) {
  await db.sourceFiles.create(USER, { id: `s-${id}`, uploadedAt: 'now', originalFilename: 'a.pdf', filePath: '/data/originals/a.pdf', mimeType: 'application/pdf', checksum: id });
  await db.documents.create(USER, { id, sourceFileId: `s-${id}`, pageStart: 1, pageEnd: 1, docDate: '2026-01-01', provider: null, docType: 'lab_result', aiSummary: title });
}

describe('what the device keeps in the vault', () => {
  beforeEach(() => { memory.clear(); n = 0; });

  it('starts empty, then gives back what was saved on a new device', async () => {
    const { store } = fakeVault();
    const first = await device(store);
    expect((await first.p.load()).empty).toBe(true);
    await addDoc(first.db, 'd1', 'amlodipine');
    await first.db.tags.setForDocument(USER, 'd1', ['cardio']);
    await first.p.save();

    const second = await device(store);
    await second.p.load();
    expect((await second.db.documents.findFor(USER, 'd1'))?.ai_summary).toBe('amlodipine');
    expect(await second.db.tags.namesForDocument(USER, 'd1')).toEqual(['cardio']);
  });

  it('writes a segment for a save and nothing for a save with nothing new', async () => {
    const { store, log } = fakeVault();
    const d = await device(store);
    await d.p.load();
    await addDoc(d.db, 'd1', 'one');
    await d.p.save();
    expect(log.puts.filter(k => k === 'log')).toHaveLength(1);
    log.puts.length = 0;
    await d.p.save();
    expect(log.puts).toEqual([]);
  });

  it('a save that fails keeps the changes it had taken out of the log, and sends them with the next one', async () => {
    const { store } = fakeVault();
    let offline = false;
    const flaky: ObjectStore = { ...store, put: (...args) => { if (offline) throw new Error('offline'); return store.put(...args); } };
    const a = await device(flaky);
    await a.p.load();
    await addDoc(a.db, 'd1', 'amlodipine');
    offline = true;
    await expect(a.p.save()).rejects.toThrow('offline');
    // The log has handed the changes over and forgotten them: only the persistence layer still has them.
    expect(a.p.waiting).toBe(true);
    await expect(a.p.save()).rejects.toThrow('offline');
    expect(a.p.waiting).toBe(true);

    offline = false;
    await a.p.save();
    expect(a.p.waiting).toBe(false);

    const b = await device(store);
    await b.p.load();
    expect((await b.db.documents.findFor(USER, 'd1'))?.ai_summary).toBe('amlodipine');
  });

  it('reads the server’s clock right before it stamps the changes, not before', async () => {
    const { store } = fakeVault();
    const events: string[] = [];
    const watched: ObjectStore = {
      ...store,
      list: async since => { events.push('read the clock'); return store.list(since); },
      put: async (...args) => { events.push(`put ${args[0]}`); return store.put(...args); },
    };
    const a = await device(watched);
    await a.p.load();
    await addDoc(a.db, 'd1', 'one');
    events.length = 0;
    await a.p.save();
    expect(events.indexOf('read the clock')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('read the clock')).toBeLessThan(events.indexOf('put log'));
  });

  it('out of reach of the vault leaves the changes unstamped in the log, and stamps them on the clock read when it is back', async () => {
    resetServerClock();
    try {
      const { store } = fakeVault();
      let offline = false;
      const hour = 3_600_000;
      const reaching: ObjectStore = {
        ...store,
        async list(since) {
          if (offline) throw new Error('offline');
          // the server says it is an hour later than this device thinks
          const sent = Date.now();
          observeServerClock(new Date(sent + hour).toUTCString(), sent, sent + 50);
          return store.list(since);
        },
      };
      const a = await device(reaching);
      await a.p.load();
      offline = true;
      await addDoc(a.db, 'd1', 'written offline');
      await expect(a.p.save()).rejects.toThrow('offline');
      expect(a.p.waiting).toBe(false); // nothing was taken out of the log
      expect(await a.db.changes.pending()).toBe(true);

      offline = false;
      await a.p.save();
      expect(await a.db.changes.pending()).toBe(false);
      const b = await device(store);
      await b.p.load();
      const stamp = (await b.db.changes.dump()).find(c => c.t === 'documents' && c.r !== null)!.h;
      // on the server's clock, which was an hour ahead of this device's, and not on the device's own
      expect(Math.abs(Number(stamp.slice(0, 14)) - (Date.now() + hour))).toBeLessThan(60_000);
    } finally { resetServerClock(); }
  });

  it('two devices that write and save see each other’s writes, and neither is lost', async () => {
    const { store } = fakeVault();
    const a = await device(store);
    const b = await device(store);
    await a.p.load(); await b.p.load();
    await addDoc(a.db, 'from-a', 'a');
    await addDoc(b.db, 'from-b', 'b');
    await a.p.save(); await b.p.save();
    await a.p.save(); // looks for what b wrote
    for (const d of [a, b]) {
      expect(await d.db.documents.findFor(USER, 'from-a')).not.toBeNull();
      expect(await d.db.documents.findFor(USER, 'from-b')).not.toBeNull();
    }
    expect(a.changed.length + b.changed.length).toBeGreaterThan(0);
  });

  it('folds many segments into a snapshot, removes them, and a new device starts from the snapshot', async () => {
    const { store, objects } = fakeVault();
    const a = await device(store);
    await a.p.load();
    for (let i = 0; i < 45; i++) { await addDoc(a.db, `d${i}`, `doc ${i}`); await a.p.save(); }
    const kinds = [...objects.values()].map(o => o.kind);
    expect(kinds.filter(k => k === 'library')).toHaveLength(1);
    expect(kinds.filter(k => k === 'log').length).toBeLessThan(10);
    expect(kinds).toContain('bundle');

    const b = await device(store);
    await b.p.load();
    expect((await b.db.documents.findFor(USER, 'd0'))?.ai_summary).toBe('doc 0');
    expect((await b.db.documents.findFor(USER, 'd44'))?.ai_summary).toBe('doc 44');
  });

  it('a device that was away through a compaction catches up from the new snapshot', async () => {
    const { store } = fakeVault();
    const a = await device(store);
    const b = await device(store);
    await a.p.load(); await b.p.load();
    await addDoc(b.db, 'early', 'b before');
    await b.p.save();
    for (let i = 0; i < 45; i++) { await addDoc(a.db, `d${i}`, `doc ${i}`); await a.p.save(); }
    await b.p.save(); // finds the snapshot and what was folded into it
    expect(await b.db.documents.findFor(USER, 'd10')).not.toBeNull();
    const c = await device(store);
    await c.p.load();
    expect(await c.db.documents.findFor(USER, 'early')).not.toBeNull(); // b's write was folded in, not lost
  });

  it('keeps files apart from the records and brings one in only when asked', async () => {
    const { store } = fakeVault();
    const first = await device(store);
    await first.p.load();
    fs.mkdirSync('/data/originals', { recursive: true });
    fs.writeFileSync('/data/originals/a.pdf', new Uint8Array([1, 2, 3, 4]));
    fs.mkdirSync('/data/tmp', { recursive: true });
    fs.writeFileSync('/data/tmp/scratch', 'x');
    await first.p.save();
    expect(memory.changes().written).toEqual([]); // saved ones are settled; scratch is dropped, not kept

    // a new page, as after unlocking: nothing in memory
    memory.clear();
    const fresh = await device(store);
    await fresh.p.load();
    expect(fs.existsSync('/data/originals/a.pdf')).toBe(true);
    expect(fs.statSync('/data/originals/a.pdf').size).toBe(4);
    expect(memory.isResident('/data/originals/a.pdf')).toBe(false);
    expect([...(fs.readFileSync('/data/originals/a.pdf') as Buffer)]).toEqual([1, 2, 3, 4]);
    expect(memory.isResident('/data/originals/a.pdf')).toBe(true);
    expect(fs.existsSync('/data/tmp/scratch')).toBe(false);
  });

  it('removes a file from the vault when it is deleted here', async () => {
    const { store, objects } = fakeVault();
    const d = await device(store);
    await d.p.load();
    fs.mkdirSync('/data/originals', { recursive: true });
    fs.writeFileSync('/data/originals/a.pdf', new Uint8Array([1]));
    await d.p.save();
    const blobs = () => [...objects.values()].filter(o => o.kind === 'blob').length;
    expect(blobs()).toBe(1);
    fs.rmSync('/data/originals/a.pdf');
    await d.p.save();
    expect(blobs()).toBe(0);
  });

  it('notices a snapshot part that is not what was saved', async () => {
    const { store, objects } = fakeVault();
    const a = await device(store);
    await a.p.load();
    for (let i = 0; i < 45; i++) { await addDoc(a.db, `d${i}`, `doc ${i}`); await a.p.save(); }
    for (const o of objects.values()) if (o.kind === 'bundle') o.data[0] ^= 1;
    const b = await device(store);
    await expect(b.p.load()).rejects.toThrow();
  });
});
