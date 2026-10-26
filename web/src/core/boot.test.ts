import { describe, it, expect, beforeEach } from 'vitest';
import { startCore } from './boot';
import { memory } from './shims/fs';
import fs from './shims/fs';
import type { ObjectStore } from './persist';
import { seedDocument, seedPage, seedSourceFile } from '../../../server/src/__tests__/helpers/seed';

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

  /** A vault that can be taken offline, and a core started on it with the states it announced. */
  async function offlineable(profile: string) {
    const { store } = vault(profile);
    const state = { offline: false };
    const flaky: ObjectStore = { ...store, put: (...args) => { if (state.offline) throw new Error('offline'); return store.put(...args); } };
    const states: Array<{ unsaved: boolean; error: string | null }> = [];
    const core = await startCore({ objects: flaky, profileId: profile }, { onSaveState: s => states.push(s) });
    await core.flush();
    return { core, state, states, store };
  }

  it('says when a save fails, keeps the records marked as changed, and clears it once the vault has them', async () => {
    const { core, state, states } = await offlineable('profile-dddddddd');
    expect(await core.saveState()).toEqual({ unsaved: false, error: null });
    await seedDocument({ userId: 'device', sourceFileId: await seedSourceFile({ userId: 'device', status: 'done' }), withPage: false, tags: ['cardio'] });
    expect((await core.saveState()).unsaved).toBe(true);

    state.offline = true;
    await expect(core.flush()).rejects.toThrow('offline');
    expect(await core.saveState()).toEqual({ unsaved: true, error: 'offline' });
    expect(states.at(-1)).toEqual({ unsaved: true, error: 'offline' });
    // still failing: still marked, not forgotten
    await expect(core.flush()).rejects.toThrow('offline');
    expect((await core.saveState()).unsaved).toBe(true);

    state.offline = false;
    await core.flush();
    expect(await core.saveState()).toEqual({ unsaved: false, error: null });
    expect(states.at(-1)).toEqual({ unsaved: false, error: null });
    core.lock();
  });

  it('does not lock over changes the vault does not have; it keeps them, and saves and locks once the vault answers', async () => {
    const { core, state, store } = await offlineable('profile-eeeeeeee');
    await seedDocument({ userId: 'device', sourceFileId: await seedSourceFile({ userId: 'device', status: 'done' }), withPage: false, tags: ['kept-offline'] });
    state.offline = true;
    await expect(core.close()).rejects.toMatchObject({ code: 'unsaved' });
    // refused, so nothing was dropped: the records answer and are still marked as changed
    expect((await core.inject({ method: 'GET', url: '/api/tags' })).json<Array<{ name: string }>>().map(t => t.name)).toContain('kept-offline');
    expect((await core.saveState()).unsaved).toBe(true);

    state.offline = false;
    await core.close();
    // and the vault has them: a new start finds them
    const again = await startCore({ objects: store, profileId: 'profile-eeeeeeee' });
    expect((await again.inject({ method: 'GET', url: '/api/tags' })).json<Array<{ name: string }>>().map(t => t.name)).toContain('kept-offline');
    again.lock();
  });

  it('lets go of unsaved changes only when the person chose to', async () => {
    const { core, state, store } = await offlineable('profile-ffffffff');
    await seedDocument({ userId: 'device', sourceFileId: await seedSourceFile({ userId: 'device', status: 'done' }), withPage: false, tags: ['lost-on-purpose'] });
    state.offline = true;
    await core.close(true);
    state.offline = false;
    const again = await startCore({ objects: store, profileId: 'profile-ffffffff' });
    expect((await again.inject({ method: 'GET', url: '/api/tags' })).json<Array<{ name: string }>>().map(t => t.name)).not.toContain('lost-on-purpose');
    again.lock();
  });

  it('refuses a vault of a kind it does not know and leaves it as it is', async () => {
    const { objects, store } = vault('profile-dddddddd');
    const index = new TextEncoder().encode(JSON.stringify({ v: 1, db: [], files: {} }));
    await store.put('library', 'ix-profile-dddddddd', index, 0);
    await expect(startCore({ objects: store, profileId: 'profile-dddddddd' })).rejects.toThrow(/cannot open/);
    expect(objects.has('ix-profile-dddddddd')).toBe(true);
  });
});
