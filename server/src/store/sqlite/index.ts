import type { Database } from 'better-sqlite3';
import { openDatabase } from './connection.js';
import { documentRepository } from './documents.js';
import { extractedFieldRepository } from './fields.js';
import { measurementRepository } from './measurements.js';
import { doctorRepository } from './doctors.js';
import { maintenanceRepository } from './maintenance.js';
import { pageRepository } from './pages.js';
import { shareLinkRepository } from './share-links.js';
import { sourceFileRepository } from './source-files.js';
import { tagRepository } from './tags.js';
import { translationRepository } from './translations.js';
import { embeddingRepository } from './embeddings.js';
import { linkRepository } from './links.js';
import { userRepository } from './users.js';
import type { Store, StoreConfig } from '../types.js';

/**
 * The SQLite adapter: the only one, and the intended state for now. The interface
 * exists so a second is possible, not because one is planned.
 *
 * SQLite has a single-writer model. With a handful of family users that is
 * fine; WAL lets readers proceed during a write. It is the first thing to
 * revisit if concurrent ingestion becomes common.
 */
export function createSqliteStore(config: StoreConfig): Store {
  const db = openDatabase(config.location);
  return storeOver(db, 0);
}

function storeOver(db: Database, depth: number): Store {
  return {
    users: userRepository(db),
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
    maintenance: maintenanceRepository(db),

    /**
     * Explicit BEGIN/COMMIT rather than `db.transaction()`, which throws
     * outright on a callback that returns a promise — and the repositories are
     * async, because the interface spans drivers that are.
     *
     * The callback gets a `Store` over the same connection, so repository code
     * reads identically inside and outside a transaction. Nesting is handled
     * with SAVEPOINT so an inner transaction cannot commit the outer one.
     *
     * Caveat worth knowing: this connection is shared, so any statement issued
     * by *other* code while the callback is awaiting lands inside this
     * transaction. In a single-process app where ingestion is the only
     * multi-statement writer that is acceptable; it is the reason the callback
     * is handed a `tx` and should use nothing else.
     */
    async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
      const savepoint = `spine_tx_${depth}`;
      const begin = depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`;
      const commit = depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`;
      const rollback = depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`;

      db.exec(begin);
      try {
        const result = await fn(storeOver(db, depth + 1));
        db.exec(commit);
        return result;
      } catch (err) {
        db.exec(rollback);
        throw err;
      }
    },

    async close() {
      db.close();
    },
  };
}
