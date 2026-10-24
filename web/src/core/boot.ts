import './shims/globals';
import type { FastifyInstance } from 'fastify';
import { LocalApp, type InjectRequest, type InjectResponse } from './local-app';
import { WasmDatabase } from './sqlite-wasm';
import { Persistence, type ObjectStore } from './persist';
import { memory } from './shims/fs';
import { createShareHost } from './share/host';
import { useShareHost } from '../../../server/src/share-host';
import { relayMail } from './native/relay-auth';
import { newId } from '../crypto/keys';
import { STARTER_TAGS } from '../../../server/src/tags';
import { ready as hashingReady } from './shims/crypto';
import accountsSchema from '../../../server/src/store/sqlite/schema-accounts.sql?raw';
import recordsSchema from '../../../server/src/store/sqlite/schema-records.sql?raw';

const schema = `${accountsSchema}\n${recordsSchema}`;
import { createSqliteStoreWith } from '../../../server/src/store/sqlite/store';
import { resetStore } from '../../../server/src/store/index';
import { decorateAuth } from '../../../server/src/routes/middleware';
import { HEALTH_CONSENT_VERSION, TERMS_VERSION } from '../../../server/src/legal';
import { tagRoutes } from '../../../server/src/routes/tags';
import { doctorRoutes } from '../../../server/src/routes/doctors';
import { trendRoutes } from '../../../server/src/routes/trends';
import { episodeRoutes } from '../../../server/src/routes/episodes';
import { documentRoutes } from '../../../server/src/routes/documents';
import { sourceFileRoutes } from '../../../server/src/routes/source-files';
import { exportRoutes } from '../../../server/src/routes/export';
import { similarityRoutes } from '../../../server/src/routes/similarity';
import { linkRoutes } from '../../../server/src/routes/links';
import { demoRoutes } from '../../../server/src/routes/demo';
import { chatRoutes } from '../../../server/src/routes/chat';
import { shareRoutes } from '../../../server/src/routes/share';

/**
 * Starts the core: the server's store and route files, running in this page or worker, on SQLite in memory. One person is "signed in":
 * whoever has unlocked the vault. Their sign-in row exists only so `requireAuth` finds a live session; the server holds the real one.
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
  /** Saves now what has changed. */
  flush(): Promise<void>;
  /** Stops saving and lets go of everything held in memory. */
  lock(): void;
  /** The store, for tests. */
  store: ReturnType<typeof createSqliteStoreWith>;
}

export async function startCore(vault?: { objects: ObjectStore; profileId: string }, hooks: { onConflict?: () => void; onChanged?: () => void } = {}): Promise<Core> {
  await hashingReady();
  const db = new WasmDatabase();
  const store = createSqliteStoreWith({ adapter: 'sqlite', location: ':memory:' }, () => db, schema);
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
  if (!(await store.sessions.get(DEVICE_USER, 'device-session'))) {
    await store.sessions.open(DEVICE_USER, { id: 'device-session', at: now, userAgent: '', address: '' });
  }
  const user = (await store.users.findById(DEVICE_USER))!;

  const persistence = vault && new Persistence(vault.objects, vault.profileId, `ix-${vault.profileId}`, newId, { changes: store.changes, files: store.files, userId: DEVICE_USER });
  if (persistence) {
    persistence.onChanged = () => { hooks.onChanged?.(); followRecords(); };
    const { legacy, empty } = await persistence.load();
    if (empty) await store.tags.ensure(DEVICE_USER, [...STARTER_TAGS]);
    if (legacy) {
      // A vault from before records were synced as changes: the database file is read once, its rows become the first snapshot, and it is let go.
      const old = new WasmDatabase(legacy);
      const oldStore = createSqliteStoreWith({ adapter: 'sqlite', location: ':memory:' }, () => old, schema);
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
  for (const routes of [tagRoutes, doctorRoutes, trendRoutes, episodeRoutes, documentRoutes, sourceFileRoutes, exportRoutes, similarityRoutes, linkRoutes, demoRoutes, chatRoutes, shareRoutes]) {
    await (routes as unknown as (a: FastifyInstance, o?: object) => Promise<void>)(app, {});
  }

  let seen = db.totalChanges;
  let locked = false;
  let ticks = 0;
  const dirty = () => db.totalChanges !== seen || memory.changes().written.length > 0 || memory.changes().removed.length > 0;
  const flush = async () => {
    if (!persistence || locked) return;
    // A save waits for a moment when no transaction is open, so it never holds half of one.
    for (let waited = 0; db.inTransaction && waited < 50; waited++) await new Promise(r => setTimeout(r, 20));
    if (db.inTransaction) return;
    const wrote = dirty();
    seen = db.totalChanges;
    await persistence.save();
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
    session: { userId: DEVICE_USER, authVersion: user.auth_version, sid: 'device-session', reauthAt: Date.now(), ...request.session },
  });
  // Saves what changed, and now and then looks for what other devices wrote.
  const timer: ReturnType<typeof setInterval> | null = persistence ? setInterval(() => { if (dirty() || ++ticks % 4 === 0) void flush().catch(() => undefined); }, SAVE_EVERY_MS) : null;

  return {
    store,
    flush,
    lock() {
      locked = true;
      if (timer) clearInterval(timer);
      if (following) clearTimeout(following);
      useShareHost(null);
      memory.useLoader(null);
      memory.clear();
      db.close();
      resetStore(null);
    },
    inject,
  };
}
