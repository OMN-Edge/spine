import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The environment an integration run has: `.env` for the model, and nothing else of the real instance. It runs before any test file
 * imports the app, because the store, the data directory and the sidecar address are read when their modules load.
 *
 * What is forced, so a run cannot touch or tell anyone about the real archive: an in-memory database, a temporary data and backup
 * directory, no mailer (the `.env` may have a real one: nothing here sends mail), and a session secret of its own.
 */
if (process.env.SPINE_INTEGRATION !== '1') {
  throw new Error('Integration tests call a real model. Run them with `npm run test:integration`.');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const scratch = mkdtempSync(path.join(tmpdir(), 'spine-it-'));
Object.assign(process.env, {
  SPINE_DB_PATH: ':memory:',
  DATA_DIR: path.join(scratch, 'data'),
  SPINE_BACKUP_DIR: path.join(scratch, 'backups'),
  SESSION_SECRET: randomBytes(32).toString('hex'), // throwaway: this run's database is in memory
  SPINE_MAILER: 'none',
  SPINE_REGISTRATION: 'operator',
  NODE_ENV: 'test',
});
