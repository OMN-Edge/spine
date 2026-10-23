import './shims/globals';
import type { FastifyInstance } from 'fastify';
import { LocalApp, type InjectRequest, type InjectResponse } from './local-app';
import { WasmDatabase } from './sqlite-wasm';
import { Persistence, type ObjectStore } from './persist';
import { NeedsFile, memory } from './shims/fs';
import { newId } from '../crypto/keys';
import { ready as hashingReady } from './shims/crypto';
import schema from '../../../server/src/store/sqlite/schema.sql?raw';
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

/**
 * Starts the core: the server's store and route files, running in this page or worker, on SQLite in memory. One person is "signed in":
 * whoever has unlocked the vault. Their sign-in row exists only so `requireAuth` finds a live session; the server holds the real one.
 *
 * With a vault (`objects`) the database is loaded from it and saved back as it changes; without one (tests, the browser check) it is
 * empty and goes nowhere.
 */
const DEVICE_USER = 'device';
/** How often to look for something to save. */
const SAVE_EVERY_MS = 2000;

export interface Core {
  inject(request: InjectRequest): Promise<InjectResponse>;
  /** Saves now what has changed. */
  flush(): Promise<void>;
  /** Stops saving and lets go of everything held in memory. */
  lock(): void;
  /** The store, for tests. */
  store: ReturnType<typeof createSqliteStoreWith>;
}

export async function startCore(vault?: { objects: ObjectStore; profileId: string }): Promise<Core> {
  await hashingReady();
  const persistence = vault && new Persistence(vault.objects, `ix-${vault.profileId}`, newId);
  const saved = persistence ? await persistence.load() : null;
  const db = new WasmDatabase(saved ?? undefined);
  const store = createSqliteStoreWith({ adapter: 'sqlite', location: ':memory:' }, () => db, schema);
  resetStore(store);

  const now = new Date().toISOString();
  if (!(await store.users.findById(DEVICE_USER))) {
    await store.users.create({
      id: DEVICE_USER, email: 'device@local', passwordHash: 'x', createdAt: now, verifiedAt: now,
      consent: { healthVersion: HEALTH_CONSENT_VERSION, termsVersion: TERMS_VERSION },
    });
  }
  if (!(await store.sessions.get(DEVICE_USER, 'device-session'))) {
    await store.sessions.open(DEVICE_USER, { id: 'device-session', at: now, userAgent: '', address: '' });
  }
  const user = (await store.users.findById(DEVICE_USER))!;

  const local = new LocalApp();
  const app = local as unknown as FastifyInstance;
  decorateAuth(app);
  for (const routes of [tagRoutes, doctorRoutes, trendRoutes, episodeRoutes, documentRoutes, sourceFileRoutes, exportRoutes, similarityRoutes, linkRoutes, demoRoutes, chatRoutes]) {
    await (routes as unknown as (a: FastifyInstance, o?: object) => Promise<void>)(app, {});
  }

  let seen = db.totalChanges;
  let locked = false;
  const dirty = () => db.totalChanges !== seen || memory.changes().written.length > 0 || memory.changes().removed.length > 0;
  const flush = async () => {
    if (!persistence || locked) return;
    // A save waits for a moment when no transaction is open, so it never holds half of one.
    for (let waited = 0; db.inTransaction && waited < 50; waited++) await new Promise(r => setTimeout(r, 20));
    if (db.inTransaction) return;
    seen = db.totalChanges;
    await persistence.save(() => db.export());
  };
  const timer = persistence ? setInterval(() => { if (dirty()) void flush().catch(() => undefined); }, SAVE_EVERY_MS) : null;

  return {
    store,
    flush,
    lock() {
      locked = true;
      if (timer) clearInterval(timer);
      memory.clear();
      db.close();
      resetStore(null);
    },
    async inject(request) {
      // A file the vault holds is brought in the first time something reads it, and the request is made again.
      for (let tries = 0; ; tries++) {
        try {
          return await local.inject({
            ...request,
            session: { userId: DEVICE_USER, authVersion: user.auth_version, sid: 'device-session', reauthAt: Date.now(), ...request.session },
          });
        } catch (err) {
          if (!(err instanceof NeedsFile) || !persistence || tries >= 20) throw err;
          await persistence.fill(err.path);
        }
      }
    },
  };
}
