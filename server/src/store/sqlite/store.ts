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
import { regroupPlanRepository } from './regroup-plans.js';
import { sessionRepository } from './sessions.js';
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
import type { Store, StoreConfig } from '../types.js';

/**
 * The SQLite adapter over any driver (`driver.ts`): the only adapter, and the intended state for now. The interface
 * exists so a second is possible, not because one is planned.
 *
 * SQLite has a single-writer model. With a handful of family users that is
 * fine; WAL lets readers proceed during a write. It is the first thing to
 * revisit if concurrent ingestion becomes common.
 */
export function createSqliteStoreWith(config: StoreConfig, open: OpenDatabase, schema?: string): Store {
  const scope = config.scope ?? 'full';
  const db = openDatabase(config.location, open, schema, scope);
  return storeOver(db, 0, scope);
}

/**
 * In `accounts` scope there are no tables for records, and a repository would fail where it prepares its first statement. It is replaced
 * by one that fails when it is used, naming the repository, so code that reaches for a record on the server stops at once and says so.
 */
function absent<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, member) {
      if (member === 'then') return undefined;
      throw new Error(`the server keeps no ${name} (${String(member)}): records are on the device (SECURITY.md M-37)`);
    },
  });
}

function storeOver(db: Database, depth: number, scope: 'full' | 'accounts'): Store {
  const records = scope === 'full';
  return {
    users: userRepository(db),
    sourceFiles: records ? sourceFileRepository(db) : absent('sourceFiles'),
    pages: records ? pageRepository(db) : absent('pages'),
    documents: records ? documentRepository(db) : absent('documents'),
    fields: records ? extractedFieldRepository(db) : absent('fields'),
    measurements: records ? measurementRepository(db) : absent('measurements'),
    doctors: records ? doctorRepository(db) : absent('doctors'),
    tags: records ? tagRepository(db) : absent('tags'),
    shareLinks: records ? shareLinkRepository(db) : absent('shareLinks'),
    translations: records ? translationRepository(db) : absent('translations'),
    embeddings: records ? embeddingRepository(db) : absent('embeddings'),
    links: records ? linkRepository(db) : absent('links'),
    episodes: records ? episodeRepository(db) : absent('episodes'),
    conversations: records ? conversationRepository(db) : absent('conversations'),
    regroupPlans: records ? regroupPlanRepository(db) : absent('regroupPlans'),
    matchDecisions: records ? matchDecisionRepository(db) : absent('matchDecisions'),
    sessions: sessionRepository(db),
    vault: vaultRepository(db),
    shared: sharedRepository(db),
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
        const result = await fn(storeOver(db, depth + 1, scope));
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
