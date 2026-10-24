import { describe, it, expect, beforeEach } from 'vitest';
import { startCore } from './boot';
import { memory } from './shims/fs';
import fs from './shims/fs';
import type { ObjectStore } from './persist';
import { seedDocument, seedPage, seedSourceFile } from '../../../server/src/__tests__/helpers/seed';
import { WasmDatabase } from './sqlite-wasm';
import { createSqliteStoreWith } from '../../../server/src/store/sqlite/store';
import accountsSchema from '../../../server/src/store/sqlite/schema-accounts.sql?raw';
import recordsSchema from '../../../server/src/store/sqlite/schema-records.sql?raw';

/** The vault as a Map: enough of it for the core to save into and load from. */
function vault(profile = 'profile-aaaaaaaa') {
  const objects = new Map<string, { kind: string; data: Uint8Array; seq: number }>();
  let counter = 0;
  const store: ObjectStore = {
    async put(kind, id, data, base) {
      if ((objects.get(id)?.seq ?? 0) !== base) throw new Error('conflict');
      const seq = ++counter;
      objects.set(id, { kind, data: Uint8Array.from(data), seq });
      return seq;
    },
    async get(id, kind) {
      const o = objects.get(id);
      if (!o || o.kind !== kind) throw Object.assign(new Error('not found'), { status: 404 });
      return { plaintext: Uint8Array.from(o.data), seq: o.seq };
    },
    getSync(id, kind) {
      const o = objects.get(id);
      if (!o || o.kind !== kind) throw new Error('not found');
      return Uint8Array.from(o.data);
    },
    async remove(id) { objects.delete(id); },
    async list(since) { return { objects: [...objects.entries()].filter(([, o]) => o.seq > since).map(([id, o]) => ({ id, profile_id: profile, kind: o.kind, seq: o.seq, deleted: false })) }; },
  };
  return { objects, store };
}

describe('the core, saving to and loading from the vault', () => {
  beforeEach(() => memory.clear());

  it('keeps what was written: records after a lock and a new start, and files once something asks for them', async () => {
    const { objects, store } = vault();
    const first = await startCore({ objects: store, profileId: 'profile-aaaaaaaa' });

    const upload = await seedSourceFile({ userId: 'device', status: 'done' });
    fs.mkdirSync('/data/pages/x', { recursive: true });
    fs.writeFileSync('/data/pages/x/page-1.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    const page = await seedPage(upload, { userId: 'device', imagePath: '/data/pages/x/page-1.png' });
    const doc = await seedDocument({ userId: 'device', sourceFileId: upload, withPage: false, tags: ['cardio'] });
    await first.flush();
    expect([...objects.values()].every(o => o.data.length > 0)).toBe(true);
    first.lock();

    // nothing of it is in memory now, as after a reload
    expect(fs.existsSync('/data/pages/x/page-1.png')).toBe(false);

    const second = await startCore({ objects: store, profileId: 'profile-aaaaaaaa' });
    const tags = (await second.inject({ method: 'GET', url: '/api/tags' })).json<Array<{ name: string }>>();
    expect(tags.map(t => t.name)).toContain('cardio');
    expect((await second.inject({ method: 'GET', url: `/api/documents/${doc.id}` })).statusCode).toBe(200);

    // the page image was saved as a file of its own, and is fetched when it is asked for
    expect(memory.isResident('/data/pages/x/page-1.png')).toBe(false);
    const image = await second.inject({ method: 'GET', url: `/api/pages/${page}/image` });
    expect(image.statusCode).toBe(200);
    expect([...(image.bytes ?? [])]).toEqual([137, 80, 78, 71, 1, 2, 3]);
    second.lock();
  });

  it('gives a new vault the starter tags once, and a tag the person deleted does not come back', async () => {
    const { store } = vault('profile-cccccccc');
    const first = await startCore({ objects: store, profileId: 'profile-cccccccc' });
    const before = (await first.inject({ method: 'GET', url: '/api/tags' })).json<Array<{ id: number; name: string }>>();
    expect(before.map(t => t.name)).toContain('cardiology');
    const gone = before.find(t => t.name === 'cardiology')!;
    expect((await first.inject({ method: 'DELETE', url: `/api/tags/${gone.id}` })).statusCode).toBe(200);
    await first.flush();
    first.lock();

    const second = await startCore({ objects: store, profileId: 'profile-cccccccc' });
    const after = (await second.inject({ method: 'GET', url: '/api/tags' })).json<Array<{ name: string }>>();
    expect(after.map(t => t.name)).not.toContain('cardiology');
    expect(after.length).toBe(before.length - 1);
    second.lock();
  });

  it('converts a vault of the earlier kind, whose records were a database file in pieces, and keeps its files', async () => {
    const { objects, store } = vault('profile-dddddddd');
    // The earlier kind, made by hand: a database file in one piece, a file of its own, and an index (v1) that names them.
    const schema = `${accountsSchema}\n${recordsSchema}`;
    const old = new WasmDatabase();
    const oldStore = createSqliteStoreWith({ adapter: 'sqlite', location: ':memory:' }, () => old, schema);
    await oldStore.users.create({ id: 'device', email: 'device@local', passwordHash: 'x', createdAt: 'now', verifiedAt: 'now', consent: undefined });
    await oldStore.sourceFiles.create('device', { id: 'old-file', uploadedAt: 'now', originalFilename: 'a.pdf', filePath: '/data/originals/a.pdf', mimeType: 'application/pdf', checksum: 'c' });
    await oldStore.documents.create('device', { id: 'old-doc', sourceFileId: 'old-file', pageStart: 1, pageEnd: 1, docDate: '2026-01-01', provider: null, docType: 'lab_result', aiSummary: 'from before' });
    const dbBytes = old.export();
    const hash = async (b: Uint8Array) => { const s2 = await (await import('../crypto/sodium')).sodium(); return s2.to_base64(s2.crypto_generichash(24, b, null), s2.base64_variants.URLSAFE_NO_PADDING); };
    const piece = { id: 'piece-1-xxxxxxxx', hash: await hash(dbBytes), size: dbBytes.length, seq: await store.put('bundle', 'piece-1-xxxxxxxx', dbBytes, 0) };
    const file = new Uint8Array([9, 8, 7]);
    const filePart = { id: 'file-1-xxxxxxxx', hash: await hash(file), size: 3, seq: await store.put('blob', 'file-1-xxxxxxxx', file, 0) };
    await store.put('library', 'ix-profile-dddddddd', new TextEncoder().encode(JSON.stringify({ v: 1, db: [piece], files: { '/data/originals/a.pdf': filePart } })), 0);

    const core = await startCore({ objects: store, profileId: 'profile-dddddddd' });
    expect((await core.inject({ method: 'GET', url: '/api/documents/old-doc' })).statusCode).toBe(200);
    expect([...(fs.readFileSync('/data/originals/a.pdf') as Buffer)]).toEqual([9, 8, 7]);
    await core.flush();
    core.lock();
    expect(objects.has('piece-1-xxxxxxxx')).toBe(false); // the pieces of the old file are let go

    // and it opens again from what the conversion wrote
    memory.clear();
    const again = await startCore({ objects: store, profileId: 'profile-dddddddd' });
    expect((await again.inject({ method: 'GET', url: '/api/documents/old-doc' })).statusCode).toBe(200);
    expect([...(fs.readFileSync('/data/originals/a.pdf') as Buffer)]).toEqual([9, 8, 7]);
    again.lock();
  });
});
