import { describe, it, expect, beforeEach } from 'vitest';
import { startCore } from './boot';
import { memory } from './shims/fs';
import fs from './shims/fs';
import type { ObjectStore } from './persist';
import { seedDocument, seedPage, seedSourceFile } from '../../../server/src/__tests__/helpers/seed';

/** The vault as a Map: enough of it for the core to save into and load from. */
function vault() {
  const objects = new Map<string, { kind: string; data: Uint8Array; seq: number }>();
  const store: ObjectStore = {
    async put(kind, id, data, base) {
      if ((objects.get(id)?.seq ?? 0) !== base) throw new Error('conflict');
      const seq = (objects.get(id)?.seq ?? 0) + 1;
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
});
