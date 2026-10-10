import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

process.env.SPINE_DB_PATH = ':memory:';

import { reconcileStalledJobs } from '../ingestion/pipeline.js';
import { getStore, resetStore } from '../store/index.js';
import { seedSourceFile, createTestUser, OWNER_ID } from './helpers/seed.js';

async function insert(id: string, status: 'pending' | 'processing' | 'done' | 'error', errorMessage: string | null = null) {
  await seedSourceFile({ id, status });
  if (errorMessage !== null) {
    await getStore().sourceFiles.setStatus(OWNER_ID, id, status, errorMessage);
  }
}

async function statusOf(id: string) {
  const row = await getStore().sourceFiles.findFor(OWNER_ID, id);
  if (!row) throw new Error(`source_file ${id} not found`);
  return { status: row.status, error_message: row.error_message };
}

describe('reconcileStalledJobs', () => {
  beforeAll(async () => {
    resetStore();
    await createTestUser();
  });

  it('fails over rows stranded mid-flight by a restart', async () => {
    const processing = uuidv4();
    const pending = uuidv4();
    const done = uuidv4();
    const errored = uuidv4();
    await insert(processing, 'processing');
    await insert(pending, 'pending');
    await insert(done, 'done');
    await insert(errored, 'error', 'pdftoppm not found');

    const changed = await reconcileStalledJobs();
    expect(changed).toBe(2);

    // in-flight rows become errors with an explanatory message
    expect((await statusOf(processing)).status).toBe('error');
    expect((await statusOf(processing)).error_message).toMatch(/interrupted/);
    expect((await statusOf(pending)).status).toBe('error');

    // terminal rows are untouched, and an existing message is preserved
    expect((await statusOf(done)).status).toBe('done');
    expect((await statusOf(errored)).status).toBe('error');
    expect((await statusOf(errored)).error_message).toBe('pdftoppm not found');
  });

  it('is idempotent — a second pass changes nothing', async () => {
    expect(await reconcileStalledJobs()).toBe(0);
  });
});
