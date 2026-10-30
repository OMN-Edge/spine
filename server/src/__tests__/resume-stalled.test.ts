import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SPINE_DB_PATH = ':memory:';

// A started upload stays at its first step, so the test sees that it was started and nothing else.
vi.mock('spine-core/ingestion/rasterize.js', () => ({ rasterizePdf: () => new Promise(() => {}) }));

import { resumeStalledJobs, getJobStatus } from 'spine-core/ingestion/pipeline.js';
import { getStore, resetStore } from 'spine-core/store/index.js';
import { seedSourceFile, createTestUser, OWNER_ID } from './helpers/seed.js';

const dir = mkdtempSync(join(tmpdir(), 'spine-resume-'));
function aFile(): string {
  const path = join(dir, `${uuidv4()}.pdf`);
  writeFileSync(path, '%PDF-1.4');
  return path;
}

async function insert(status: 'pending' | 'processing' | 'done' | 'error', options: { filePath?: string; fromExport?: boolean; errorMessage?: string } = {}) {
  const id = uuidv4();
  await seedSourceFile({ id, status, filePath: options.filePath ?? aFile(), fromExport: options.fromExport });
  if (options.errorMessage) await getStore().sourceFiles.setStatus(OWNER_ID, id, status, options.errorMessage);
  return id;
}

async function statusOf(id: string) {
  const row = await getStore().sourceFiles.findFor(OWNER_ID, id);
  if (!row) throw new Error(`source_file ${id} not found`);
  return { status: row.status, error_message: row.error_message };
}

describe('resumeStalledJobs', () => {
  beforeAll(async () => {
    resetStore();
    await createTestUser();
  });

  it('starts an upload a closed page left reading, and fails what cannot be started again', async () => {
    const processing = await insert('processing');
    const pending = await insert('pending');
    const restoring = await insert('processing', { fromExport: true });
    const lostFile = await insert('processing', { filePath: join(dir, 'never-saved.pdf') });
    const done = await insert('done');
    const errored = await insert('error', { errorMessage: 'pdftoppm not found' });

    expect(await resumeStalledJobs()).toEqual({ resumed: 2, failed: 2 });

    // read again, from its file
    expect(getJobStatus(processing)?.status).toBe('processing');
    expect(getJobStatus(pending)?.status).toBe('processing');
    expect((await statusOf(processing)).error_message).toBeNull();

    // a restore has no manifest to go on, and a file that did not reach the vault has nothing to read: both say so
    for (const id of [restoring, lostFile]) {
      expect((await statusOf(id)).status).toBe('error');
      expect((await statusOf(id)).error_message).toMatch(/interrupted/);
      expect(getJobStatus(id)).toBeNull();
    }

    // finished rows are untouched, and an existing message is preserved
    expect((await statusOf(done)).status).toBe('done');
    expect((await statusOf(errored)).error_message).toBe('pdftoppm not found');
  });

  it('is idempotent once nothing is left stalled by a failure', async () => {
    const before = await resumeStalledJobs();
    expect(before.failed).toBe(0);
  });
});
