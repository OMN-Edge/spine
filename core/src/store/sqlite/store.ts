import type { Database, OpenDatabase } from './driver.js';
import { openDatabase } from './connection.js';
import { documentRepository } from './documents.js';
import { extractedFieldRepository } from './fields.js';
import { measurementRepository } from './measurements.js';
import { doctorRepository } from './doctors.js';
import { maintenanceRepository } from './maintenance.js';
import { pageRepository } from './pages.js';
import { shareLinkRepository } from './share-links.js';
import { sourceFileRepository } from './source-files.js';
import { guideRepository } from './guide.js';
import { regroupPlanRepository } from './regroup-plans.js';
import { sessionRepository } from './sessions.js';
import { cookieSessionRepository } from './cookie-sessions.js';
import { enrolmentRepository } from './enrolments.js';
import { usageRepository } from './usage.js';
import { changeLog } from './changes.js';
import { fileRegistryRepository } from './file-registry.js';
import { matchDecisionRepository } from './match-decisions.js';
import { tagRepository } from './tags.js';
import { translationRepository } from './translations.js';
import { embeddingRepository } from './embeddings.js';
import { linkRepository } from './links.js';
import { episodeRepository } from './episodes.js';
import { conversationRepository } from './conversations.js';
import { userRepository } from './users.js';
import { vaultRepository } from './vault.js';
import { sharedRepository } from './shared.js';
import { copySlice } from './slice.js';
import type { AccountsStore, RecordsStore, Store, StoreConfig } from '../types.js';

/**
 * The SQLite adapter over any driver (`driver.ts`): the only adapter, and the intended state for now. The interface
 * exists so a second is possible, not because one is planned.
 *
 * SQLite has a single-writer model. The device's database has one owner and the server's holds accounts only, so that is not a limit
 * today; it is the first thing to revisit if one database had to serve many writers.
 */
export function createSqliteStoreWith(config: StoreConfig, open: OpenDatabase, schema?: string): Store {
  return recordsOver(openDatabase(config.location, open, schema, 'full'), 0, { open, schema });
}

/** The server's store: the schema of accounts alone, so there is no table that could hold a record (SECURITY.md **M-37**). */
export function createSqliteAccountsStoreWith(config: StoreConfig, open: OpenDatabase): AccountsStore {
  return accountsOver(openDatabase(config.location, open, undefined, 'accounts'), 0);
}

/**
 * Explicit BEGIN/COMMIT rather than `db.transaction()`, which throws outright on a callback that returns a promise — and the
 * repositories are async, because the interface spans drivers that are.
 *
 * The callback gets a store over the same connection, so repository code reads identically inside and outside a transaction. Nesting is
 * handled with SAVEPOINT so an inner transaction cannot commit the outer one.
 *
 * Caveat worth knowing: this connection is shared, so any statement issued by *other* code while the callback is awaiting lands inside
 * this transaction. Several paths write in transactions (reading an upload, regrouping, moving a page, merging, restoring); that is the
 * reason the callback is handed a `tx` and should use nothing else and await nothing slow.
 */
async function inTransaction<S, T>(db: Database, depth: number, inner: () => S, fn: (tx: S) => Promise<T>): Promise<T> {
  const savepoint = `spine_tx_${depth}`;
  const begin = depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`;
  const commit = depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`;
  const rollback = depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`;

  db.exec(begin);
  try {
    const result = await fn(inner());
    db.exec(commit);
    return result;
  } catch (err) {
    db.exec(rollback);
    throw err;
  }
}

function accountsOver(db: Database, depth: number): AccountsStore {
  return {
    users: userRepository(db),
    sessions: sessionRepository(db),
    cookieSessions: cookieSessionRepository(db),
    enrolments: enrolmentRepository(db),
    usage: usageRepository(db),
    vault: vaultRepository(db),
    shared: sharedRepository(db),
    maintenance: maintenanceRepository(db),
    transaction: fn => inTransaction(db, depth, () => accountsOver(db, depth + 1), fn),
    async close() {
      db.close();
    },
  };
}

function recordsOf(db: Database): Omit<RecordsStore, "slice"> {
  return {
    sourceFiles: sourceFileRepository(db),
    pages: pageRepository(db),
    documents: documentRepository(db),
    fields: extractedFieldRepository(db),
    measurements: measurementRepository(db),
    doctors: doctorRepository(db),
    tags: tagRepository(db),
    shareLinks: shareLinkRepository(db),
    translations: translationRepository(db),
    embeddings: embeddingRepository(db),
    links: linkRepository(db),
    episodes: episodeRepository(db),
    conversations: conversationRepository(db),
    regroupPlans: regroupPlanRepository(db),
    guide: guideRepository(db),
    matchDecisions: matchDecisionRepository(db),
    changes: changeLog(db),
    files: fileRegistryRepository(db),
  };
}

/** What a store needs to make another like itself: the driver and the schema it was opened with. */
interface Opened { open: OpenDatabase; schema: string | undefined }

function recordsOver(db: Database, depth: number, how: Opened): Store {
  return {
    ...accountsOver(db, depth),
    ...recordsOf(db),
    async slice(options) {
      // The copy is built in a database of its own, with the change log watching, and leaves it as changes: the form in which records travel.
      const stagingDb = openDatabase(':memory:', how.open, how.schema, 'full');
      const staging = recordsOver(stagingDb, 0, how);
      try {
        const result = copySlice(db, stagingDb, options);
        return { ...result, changes: await staging.changes.drain() };
      } finally {
        await staging.close();
      }
    },
    transaction: fn => inTransaction(db, depth, () => recordsOver(db, depth + 1, how), fn),
  };
}
