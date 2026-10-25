import './shims/globals';
import type { FastifyInstance } from 'fastify';
import { LocalApp, type InjectRequest, type InjectResponse } from './local-app';
import { WasmDatabase } from './sqlite-wasm';
import { Persistence, type ObjectStore } from './persist';
import type { SaveState } from './protocol';
export type { SaveState };
import { memory } from './shims/fs';
import { createShareHost } from './share/host';
import { useShareHost } from 'spine-core/share-host';
import { relayMail } from './native/relay-auth';
import { newId } from '../crypto/keys';
import { STARTER_TAGS } from 'spine-core/tags';
import { ready as hashingReady } from './shims/crypto';
import accountsSchema from 'spine-core/store/sqlite/schema-accounts.sql?raw';
import recordsSchema from 'spine-core/store/sqlite/schema-records.sql?raw';

const schema = `${accountsSchema}\n${recordsSchema}`;
import { createDeviceStore } from 'spine-core/store/sqlite/browser';
import { resetStore } from 'spine-core/store/index';
import type { Store } from 'spine-core/store/types';
import { decorateAuth, useRequestAuth } from 'spine-core/routes/middleware';
import { HEALTH_CONSENT_VERSION, TERMS_VERSION } from 'spine-core/consent';
import { tagRoutes } from 'spine-core/routes/tags';
import { doctorRoutes } from 'spine-core/routes/doctors';
import { trendRoutes } from 'spine-core/routes/trends';
import { episodeRoutes } from 'spine-core/routes/episodes';
import { documentRoutes } from 'spine-core/routes/documents';
import { sourceFileRoutes } from 'spine-core/routes/source-files';
import { exportRoutes } from 'spine-core/routes/export';
import { similarityRoutes } from 'spine-core/routes/similarity';
import { linkRoutes } from 'spine-core/routes/links';
import { demoRoutes } from 'spine-core/routes/demo';
import { chatRoutes } from 'spine-core/routes/chat';
import { shareRoutes } from 'spine-core/routes/share';

/**
 * Starts the core: the server's store and route files, running in this page or worker, on SQLite in memory. One person is "signed in":
 * whoever has unlocked the vault, so a request needs no cookie and no session row: the device's `RequestAuth` answers with that person.
 *
 * With a vault (`objects`) the records are loaded from it (a snapshot, then the segments other saves left) and every change made here is sealed
 * and sent as it happens; other devices' changes are brought in as they appear. Without one (tests, the browser check) it is empty and goes nowhere.
 */
const DEVICE_USER = 'device';
/** How often to look for something to save. */
const SAVE_EVERY_MS = 2000;
/** How long after the records last changed the shares are looked at again. */
const FOLLOW_AFTER_MS = 15_000;

export interface Core {
  inject(request: InjectRequest): Promise<InjectResponse>;
  /** Saves now what has changed. Throws if the vault did not take it. */
  flush(): Promise<void>;
  saveState(): Promise<SaveState>;
  /** Stops saving and lets go of everything held in memory. Anything not saved is gone: use `close`. */
  lock(): void;
  /**
   * Saves, then locks. If something could not be saved it throws with code `unsaved` and keeps everything, unless `force` says the person
   * chose to lose it.
   */
  close(force?: boolean): Promise<void>;
  /** The store, for tests. */
  store: Store;
}

export async function startCore(vault?: { objects: ObjectStore; profileId: string }, hooks: { onConflict?: () => void; onChanged?: () => void; onSaveState?: (state: SaveState) => void } = {}): Promise<Core> {
  await hashingReady();
  const db = new WasmDatabase();
  const store = createDeviceStore(() => db, schema);
  resetStore(store);

  const now = new Date().toISOString();
  if (!(await store.users.findById(DEVICE_USER))) {
    await store.users.create({
      id: DEVICE_USER, email: 'device@local', passwordHash: 'x', createdAt: now, verifiedAt: now,
      consent: { healthVersion: HEALTH_CONSENT_VERSION, termsVersion: TERMS_VERSION },
      // With a vault the tags are the vault's: a new one gets the starter tags below, and a deleted one does not come back.
      starterTags: !vault,
    });
  }

  const persistence = vault && new Persistence(vault.objects, vault.profileId, `ix-${vault.profileId}`, newId, { changes: store.changes, files: store.files, userId: DEVICE_USER });
  if (persistence) {
    persistence.onChanged = () => { hooks.onChanged?.(); followRecords(); };
    const { legacy, empty } = await persistence.load();
    if (empty) await store.tags.ensure(DEVICE_USER, [...STARTER_TAGS]);
    if (legacy) {
      // A vault from before records were synced as changes: the database file is read once, its rows become the first snapshot, and it is let go.
      const old = new WasmDatabase(legacy);
      const oldStore = createDeviceStore(() => old, schema);
      await oldStore.changes.drain();
      await store.changes.apply(await oldStore.changes.dump());
      await oldStore.close();
      await persistence.adoptLegacy();
    }
  }

  // Links are sealed here and sent to the server (docs/crypto-design.md, stage 4).
  useShareHost(createShareHost({ source: db, schema, store: () => store, mail: relayMail }));

  const local = new LocalApp();
  const app = local as unknown as FastifyInstance;
  decorateAuth(app);
  // One person, and the password was just typed to open the vault: nothing here asks for it again.
  useRequestAuth({ user: () => store.users.findById(DEVICE_USER), recent: () => true });
  for (const routes of [tagRoutes, doctorRoutes, trendRoutes, episodeRoutes, documentRoutes, sourceFileRoutes, exportRoutes, similarityRoutes, linkRoutes, demoRoutes, chatRoutes, shareRoutes]) {
    await (routes as unknown as (a: FastifyInstance, o?: object) => Promise<void>)(app, {});
  }

  let seen = db.totalChanges;
  let locked = false;
  let ticks = 0;
  const dirty = () => db.totalChanges !== seen || memory.changes().written.length > 0 || memory.changes().removed.length > 0;
  let saveError: string | null = null;
  let announced = '';
  // Unsaved means the vault does not have something: writes no drain has taken, changes a failed save took and kept, or files not sent.
  // (SQLite's own change counter is not it: a save writes bookkeeping of its own.)
  const saveState = async (): Promise<SaveState> => {
    const waiting = !!persistence && (await store.changes.pending() || persistence.waiting || memory.changes().written.length > 0 || memory.changes().removed.length > 0);
    return { unsaved: waiting || saveError !== null, error: saveError };
  };
  /** Tells the page when the state changes (not on every look). */
  const announce = async () => {
    const state = await saveState();
    const key = `${state.unsaved}|${state.error ?? ''}`;
    if (key === announced) return;
    announced = key;
    hooks.onSaveState?.(state);
  };
  const flush = async () => {
    if (!persistence || locked) return;
    // A save waits for a moment when no transaction is open, so it never holds half of one.
    for (let waited = 0; db.inTransaction && waited < 50; waited++) await new Promise(r => setTimeout(r, 20));
    if (db.inTransaction) return;
    const mark = db.totalChanges;
    const wrote = dirty();
    try {
      await persistence.save();
    } catch (err) {
      // Nothing is marked as saved, so the next look tries again; the page is told, and the person is not left believing it was kept.
      saveError = (err as Error)?.message || 'the vault did not take the save';
      await announce();
      throw err;
    }
    // Only now: a save that failed must leave the records marked as changed.
    seen = mark;
    saveError = null;
    await announce();
    if (wrote) followRecords();
  };
  // A share follows the records for as long as it lasts: after the records change, a moment later the copies are looked at again, and one that
  // would now hold something different is made again (a deleted document leaves it). A copy that would be the same is not sent.
  let following: ReturnType<typeof setTimeout> | null = null;
  const followRecords = () => {
    if (locked) return;
    if (following) clearTimeout(following);
    following = setTimeout(() => {
      following = null;
      if (!locked) void inject({ method: 'POST', url: '/api/share-links/refresh' }).catch(() => undefined);
    }, FOLLOW_AFTER_MS);
  };
  const inject = (request: InjectRequest) => local.inject({
    ...request,
  });
  // Saves what changed, and now and then looks for what other devices wrote.
  // A failed save is retried here every time round (the records stay marked as changed), and the page is told once, in `announce`.
  const timer: ReturnType<typeof setInterval> | null = persistence ? setInterval(() => { void announce(); if (dirty() || persistence.waiting || ++ticks % 4 === 0) void flush().catch(err => console.warn('a save did not reach the vault:', (err as Error)?.message)); }, SAVE_EVERY_MS) : null;

  const lock = () => {
    locked = true;
    if (timer) clearInterval(timer);
    if (following) clearTimeout(following);
    useShareHost(null);
    useRequestAuth(null);
    memory.useLoader(null);
    memory.clear();
    db.close();
    resetStore(null);
  };

  return {
    store,
    flush,
    saveState,
    lock,
    async close(force = false) {
      try { await flush(); } catch { /* said by saveState below */ }
      if ((await saveState()).unsaved && !force) throw Object.assign(new Error('some changes are not saved yet'), { code: 'unsaved' });
      lock();
    },
    inject,
  };
}
