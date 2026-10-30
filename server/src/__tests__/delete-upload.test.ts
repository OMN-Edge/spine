import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedDocument, seedSourceFile } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';

const mockGetJobStatus = vi.hoisted(() => vi.fn().mockReturnValue(null));
vi.mock('spine-core/ingestion/pipeline.js', () => ({
  startIngestionJob: vi.fn(),
  getJobStatus: mockGetJobStatus,
  resumeStalledJobs: vi.fn().mockResolvedValue({ resumed: 0, failed: 0 }),
}));

/**
 * Deleting an upload: the rows, the page images, the original and its backup copy go; another
 * user's upload is not found; one still being read is refused; and a path in the row that points
 * outside the user's originals is never removed.
 */

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let root: string;
const saved = { data: process.env.DATA_DIR, backup: process.env.SPINE_BACKUP_DIR };

const del = (id: string, c = cookie) =>
  app.inject({ method: 'DELETE', url: `/api/source-files/${id}`, headers: c ? { cookie: c } : {} });

/** An upload with an original, page images and a mirror copy on disk, and one document. */
async function seedOnDisk(userId = OWNER_ID) {
  const id = uuidv4();
  const original = path.join(root, 'data', 'originals', userId, '2026', `${id}.pdf`);
  const mirror = path.join(root, 'backups', 'originals', userId, '2026', `${id}.pdf`);
  const pages = path.join(root, 'data', 'pages', id);
  for (const file of [original, mirror, path.join(pages, '1.png')]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'x');
  }
  await seedSourceFile({ id, userId, status: 'done', filePath: original });
  const doc = await seedDocument({ userId, sourceFileId: id });
  return { id, original, mirror, pages, docId: doc.id };
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'spine-delete-'));
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.SPINE_BACKUP_DIR = path.join(root, 'backups');
  mkdirSync(process.env.DATA_DIR, { recursive: true });
  app = await buildTestApp();
  cookie = await loginAs(app);
});
afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [['DATA_DIR', saved.data], ['SPINE_BACKUP_DIR', saved.backup]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
beforeEach(() => { mockGetJobStatus.mockReturnValue(null); });

describe('DELETE /api/source-files/:id', () => {
  it('removes the upload, its documents and pages, and every file it left', async () => {
    const up = await seedOnDisk();
    const res = await del(up.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });

    const store = getStore();
    expect(await store.sourceFiles.findFor(OWNER_ID, up.id)).toBeNull();
    expect(await store.documents.findFor(OWNER_ID, up.docId)).toBeNull();
    expect(await store.pages.listForSourceFile(OWNER_ID, up.id)).toEqual([]);
    expect(existsSync(up.original)).toBe(false);
    expect(existsSync(up.mirror)).toBe(false);
    expect(existsSync(up.pages)).toBe(false);
    expect((await del(up.id)).statusCode).toBe(404);
  });

  it('lets the same file be uploaded again afterwards', async () => {
    const id = await seedSourceFile({ status: 'done', checksum: 'abc123' });
    expect(await getStore().sourceFiles.findByChecksumFor(OWNER_ID, 'abc123')).not.toBeNull();
    await del(id);
    expect(await getStore().sourceFiles.findByChecksumFor(OWNER_ID, 'abc123')).toBeNull();
  });

  it('keeps the user’s tags and doctors', async () => {
    const store = getStore();
    const up = await seedOnDisk();
    await store.tags.setForDocument(OWNER_ID, up.docId, ['chronic']);
    await del(up.id);
    expect((await store.tags.listFor(OWNER_ID)).map(t => t.name)).toContain('chronic');
  });

  it('answers 404 for another user’s upload and leaves it whole', async () => {
    const other = await createTestUser('someone-else@spine.test');
    const theirs = await seedOnDisk(other.id);
    const res = await del(theirs.id);
    expect(res.statusCode).toBe(404);
    expect(await getStore().sourceFiles.findFor(other.id, theirs.id)).not.toBeNull();
    expect(await getStore().documents.findFor(other.id, theirs.docId)).not.toBeNull();
    expect(existsSync(theirs.original)).toBe(true);
    expect(existsSync(theirs.mirror)).toBe(true);
    expect(existsSync(theirs.pages)).toBe(true);
  });

  it('refuses while the upload is still being read, and removes nothing', async () => {
    const up = await seedOnDisk();
    mockGetJobStatus.mockReturnValue({ status: 'processing' });
    expect((await del(up.id)).statusCode).toBe(409);
    expect(await getStore().sourceFiles.findFor(OWNER_ID, up.id)).not.toBeNull();
    expect(existsSync(up.original)).toBe(true);
    mockGetJobStatus.mockReturnValue(null);

    const pending = await seedSourceFile({ status: 'pending' });
    expect((await del(pending)).statusCode).toBe(409);
  });

  it('never removes a file outside the user’s originals, whatever the row says', async () => {
    const stray = path.join(root, 'elsewhere.pdf');
    writeFileSync(stray, 'keep me');
    const id = await seedSourceFile({ status: 'done', filePath: stray });
    expect((await del(id)).statusCode).toBe(200);
    expect(existsSync(stray)).toBe(true);
    expect(await getStore().sourceFiles.findFor(OWNER_ID, id)).toBeNull();
  });

  it('needs a signed-in user', async () => {
    const id = await seedSourceFile({ status: 'done' });
    expect((await del(id, '')).statusCode).toBe(401);
    expect(await getStore().sourceFiles.findFor(OWNER_ID, id)).not.toBeNull();
  });
});
