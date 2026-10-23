import { describe, it, expect, beforeEach } from 'vitest';
import { Persistence, type ObjectStore } from './persist';
import { memory } from './shims/fs';
import fs from './shims/fs';

/** The vault as a Map, with the sequence numbers and the conflict rule of the real one. */
function fakeVault() {
  const objects = new Map<string, { kind: string; data: Uint8Array; seq: number }>();
  const log = { puts: [] as string[], removes: [] as string[] };
  const store: ObjectStore = {
    async put(kind, id, data, baseSeq) {
      const have = objects.get(id);
      if ((have?.seq ?? 0) !== baseSeq) throw Object.assign(new Error('conflict'), { name: 'ConflictError' });
      const seq = (have?.seq ?? 0) + 1;
      objects.set(id, { kind, data: Uint8Array.from(data), seq });
      log.puts.push(`${kind}`);
      return seq;
    },
    async get(id, kind) {
      const o = objects.get(id);
      if (!o || o.kind !== kind) throw Object.assign(new Error('not found'), { status: 404 });
      return { plaintext: Uint8Array.from(o.data), seq: o.seq };
    },
    async remove(id, base) {
      if (objects.get(id)?.seq !== base) throw new Error('conflict');
      objects.delete(id);
      log.removes.push(id);
    },
  };
  return { objects, log, store };
}

let n = 0;
const newId = async () => `id-${++n}-xxxxxxxx`;
const bigDb = (pieces: number, fill = 1) => new Uint8Array(pieces * 1024 * 1024 - 100).fill(fill);

describe('what the device keeps in the vault', () => {
  beforeEach(() => { memory.clear(); n = 0; });

  it('starts empty, then gives back the database it saved', async () => {
    const { store } = fakeVault();
    const first = new Persistence(store, 'ix-profile-1', newId);
    expect(await first.load()).toBeNull();
    const db = new Uint8Array(2_500_000).map((_, i) => i % 251);
    await first.save(() => db);

    const again = new Persistence(store, 'ix-profile-1', newId);
    expect(Buffer.from((await again.load())!).equals(Buffer.from(db))).toBe(true);
  });

  it('sends only the pieces of the database that changed, and removes the ones they replace', async () => {
    const { store, log, objects } = fakeVault();
    const p = new Persistence(store, 'ix-profile-1', newId);
    const db = bigDb(3);
    await p.save(() => db);
    expect(log.puts.filter(k => k === 'bundle')).toHaveLength(3);
    const before = objects.size;

    const changed = Uint8Array.from(db);
    changed[1_500_000] = 9; // in the second piece
    log.puts.length = 0;
    await p.save(() => changed);
    expect(log.puts.filter(k => k === 'bundle')).toHaveLength(1);
    expect(log.removes).toHaveLength(1);
    expect(objects.size).toBe(before); // one in, one out

    log.puts.length = 0;
    await p.save(() => changed); // nothing changed: only the index is written
    expect(log.puts).toEqual(['library']);
  });

  it('keeps files apart from the database and brings one in only when asked', async () => {
    const { store } = fakeVault();
    const p = new Persistence(store, 'ix-profile-1', newId);
    fs.mkdirSync('/data/originals', { recursive: true });
    fs.writeFileSync('/data/originals/a.pdf', new Uint8Array([1, 2, 3, 4]));
    fs.mkdirSync('/data/tmp', { recursive: true });
    fs.writeFileSync('/data/tmp/scratch', 'x');
    await p.save(() => new Uint8Array([7]));
    expect(memory.changes().written).toEqual([]); // saved ones are settled; scratch is dropped, not kept

    // a new page, as after unlocking: nothing in memory
    memory.clear();
    const fresh = new Persistence(store, 'ix-profile-1', newId);
    await fresh.load();
    expect(fs.existsSync('/data/originals/a.pdf')).toBe(true);
    expect(fs.statSync('/data/originals/a.pdf').size).toBe(4);
    expect(() => fs.readFileSync('/data/originals/a.pdf')).toThrow(/not loaded yet/);
    await fresh.fill('/data/originals/a.pdf');
    expect([...(fs.readFileSync('/data/originals/a.pdf') as Buffer)]).toEqual([1, 2, 3, 4]);
    expect(fs.existsSync('/data/tmp/scratch')).toBe(false);
  });

  it('removes a file from the vault when it is deleted here', async () => {
    const { store, objects } = fakeVault();
    const p = new Persistence(store, 'ix-profile-1', newId);
    fs.mkdirSync('/data/originals', { recursive: true });
    fs.writeFileSync('/data/originals/a.pdf', new Uint8Array([1]));
    await p.save(() => new Uint8Array([7]));
    const withFile = objects.size;
    fs.rmSync('/data/originals/a.pdf');
    await p.save(() => new Uint8Array([7]));
    expect(objects.size).toBe(withFile - 1);
  });

  it('refuses to save over what another device saved since, and says so', async () => {
    const { store } = fakeVault();
    const here = new Persistence(store, 'ix-profile-1', newId);
    await here.save(() => new Uint8Array([1]));
    const there = new Persistence(store, 'ix-profile-1', newId);
    await there.load();
    await there.save(() => new Uint8Array([2]));
    await expect(here.save(() => new Uint8Array([3]))).rejects.toThrow(/conflict/);
  });

  it('notices a piece that is not what was saved', async () => {
    const { store, objects } = fakeVault();
    const p = new Persistence(store, 'ix-profile-1', newId);
    await p.save(() => new Uint8Array([1, 2, 3]));
    for (const o of objects.values()) if (o.kind === 'bundle') o.data[0] ^= 1;
    await expect(new Persistence(store, 'ix-profile-1', newId).load()).rejects.toThrow(/not what was saved/);
  });
});
