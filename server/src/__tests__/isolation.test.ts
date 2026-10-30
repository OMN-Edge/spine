import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs, routesOf } from './helpers/app.js';
import {
  OWNER_ID,
  createTestUser,
  seedDocument,
  seedPage,
  seedShareLink,
  seedSourceFile,
} from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';

/**
 * SECURITY.md P12 / M-1: one user must never read, change or enumerate another's
 * records, by any route.
 *
 * Written before the filtering existed, so the first run is the proof that these
 * fail when isolation is missing. Every assertion is made as user B against data
 * that belongs to user A.
 *
 * Responses for a record B does not own are 404, not 403: the same answer as for
 * a record that does not exist, so B cannot probe for what A has.
 */

const mockStartJob = vi.hoisted(() => vi.fn());
vi.mock('spine-core/ingestion/pipeline.js', () => ({
  startIngestionJob: mockStartJob,
  getJobStatus: vi.fn().mockReturnValue(null),
  resumeStalledJobs: vi.fn().mockResolvedValue({ resumed: 0, failed: 0 }),
}));

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookieA: string;
let cookieB: string;
let B: { id: string; email: string };
let tmp: string;

// What A owns
let docA: string;
let fileA: string;
let pageA: string;
let linkA: string;
let tagLinkA: string;
let checksumA: string;

// What B owns
let docB: string;
let linkB: string;

// One plain word: FTS5 reads a hyphen as a column filter and rejects the query.
const SECRET = 'zebrafish';
// Words that reach the search index through a page, a result and a doctor (M-2): each must find A's document for A and nothing for B.
const PAGE_WORD = 'quillfeather';
const VALUE_WORD = 'thistledown';
const DOCTOR_WORD = 'marmaduke';

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'spine-isolation-'));
  // Open registration, so the signup routes are registered and checked too.
  app = await buildTestApp({ accounts: { registration: 'open' } });
  B = await createTestUser('bee@spine.test');
  cookieA = await loginAs(app);
  cookieB = await loginAs(app, B.email);

  const store = getStore();

  // --- A's records ---------------------------------------------------------
  checksumA = uuidv4();
  fileA = await seedSourceFile({ userId: OWNER_ID, status: 'done', checksum: checksumA });

  const imagePath = path.join(tmp, 'a-page.png');
  writeFileSync(imagePath, Buffer.from('not-really-a-png'));
  pageA = await seedPage(fileA, { userId: OWNER_ID, imagePath, rawText: `the page says ${PAGE_WORD}` });

  const a = await seedDocument({
    userId: OWNER_ID,
    sourceFileId: fileA,
    withPage: false,
    provider: 'Secret Clinic',
    aiSummary: `A's note about the ${SECRET}`,
    tags: ['cardiology', 'a-only-tag'],
  });
  docA = a.id;
  await store.measurements.create(OWNER_ID, { id: uuidv4(), documentId: docA, pageId: pageA, name: 'Marker', canonical: 'marker', valueText: VALUE_WORD, valueNum: null, unit: null, refLow: null, refHigh: null, flag: null, takenOn: '2026-03-01', sourceSnippet: null, bbox: null, confidence: 1 });
  const doctorA = (await store.doctors.upsert(OWNER_ID, { name: `Dr ${DOCTOR_WORD} Test`, specialty: 'neurology' }, '2026-03-01'))!;
  await store.doctors.link(OWNER_ID, docA, doctorA, 'author');
  await store.fields.create(OWNER_ID, {
    id: uuidv4(), documentId: docA, pageId: pageA, label: 'diagnosis',
    value: 'a-private-diagnosis', sourceSnippet: null, bbox: null, confidence: 0.9,
  });

  linkA = await seedShareLink({ userId: OWNER_ID, scope: 'all' });
  tagLinkA = await seedShareLink({
    userId: OWNER_ID,
    scope: 'tag', scopeValue: JSON.stringify('cardiology'),
  });

  // --- B's records, sharing a tag name with A on purpose ---------------------
  const b = await seedDocument({
    userId: B.id, provider: 'Other Clinic', aiSummary: "B's own note", tags: ['cardiology'],
  });
  docB = b.id;
  linkB = await seedShareLink({ userId: B.id, scope: 'all' });
});

afterAll(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

const asB = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: cookieB }, payload: payload as object | undefined });

const asA = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: cookieA }, payload: payload as object | undefined });

const ids = (res: { json(): unknown }) => (res.json() as Array<{ id: string }>).map(r => r.id);

// ---------------------------------------------------------------------------

describe('P1 — deny by default', () => {
  /**
   * Every route the app registers must refuse an unauthenticated request, except
   * these, which are public on purpose. A route added to the wrong file is public
   * silently, so this fails when someone does that.
   */
  const PUBLIC = new Set([
    'POST /api/auth/login',
    'POST /api/auth/login/second-factor',
    'POST /api/auth/logout',
    'GET /api/auth/me',
    'GET /api/auth/options',
    'POST /api/auth/register',
    'POST /api/auth/verify',
    'POST /api/auth/resend-verification',
    'POST /api/auth/forgot',
    'POST /api/auth/reset',
    // The salt a device needs before it can sign in, and the recovery-wrapped key a reset link is for; both answer the same for any address.
    'POST /api/auth/kdf',
    'POST /api/auth/reset/keys',
    // Public on purpose, and known only by the random id in the link: they answer with metadata and sealed bytes, nothing a person can
    // read, and accept a browser's request, its public key and its note that it opened the link (shared.test.ts).
    'GET /api/shared/:id/meta',
    'GET /api/shared/:id/bundle',
    'GET /api/shared/:id/config',
    'GET /api/shared/:id/blob/:n',
    'POST /api/shared/:id/access-request',
    'GET /api/shared/:id/access-request/:rid',
    'POST /api/shared/:id/opened',
    'POST /api/shared/:id/relay-token',
    // Public on purpose, and off unless the operator turns the demo's uploads on: settings, and a pass counted by the relay per address and
    // for all of them (SECURITY.md M-39, demo-relay.test.ts).
    'GET /api/demo-relay/config',
    'POST /api/demo-relay/token',
    'GET /api/share/:link/documents',
    // Public on purpose, and scoped by the link, not a session: public-share-detail.test.ts.
    'GET /api/share/:link/documents/:id',
    'GET /api/share/:link/pages/:pageId/image',
    'GET /api/share/:link/meta',
    // Public on purpose: the privacy notice, the terms and the intended purpose are read before an account exists (own-account.test.ts).
    'GET /api/legal/:doc',
    // Public on purpose: they are how a passkey signs in (passkeys.test.ts); each is rate limited and single use.
    'POST /api/auth/passkey/options',
    'POST /api/auth/passkey/login',
    // Public on purpose: they are how a device that holds a one-time code asks to be let in and collects what the owner approved
    // (enrolment.test.ts); the id is made by the code and the token is the asking browser's, each is rate limited, and the offer is single use.
    'POST /api/enrol/request',
    'POST /api/enrol/claim',
    'GET /api/share/:link/documents/:id/translation',
    'GET /api/share/:link/trends',
    'GET /api/share/:link/trends/series',
    // Public on purpose, and scoped by the link (its documents only, confirmed links only): share-connections.test.ts.
    'GET /api/share/:link/documents/:id/connections',
    // Public on purpose, and scoped by the link: share-chat.test.ts.
    'POST /api/share/:link/chat',
  ]);

  it('refuses every other route without a session', async () => {
    const routes = routesOf.get(app)!;
    expect(routes.length).toBeGreaterThan(10);

    const open: string[] = [];
    for (const route of routes) {
      if (PUBLIC.has(`${route.method} ${route.url}`)) continue;
      const res = await app.inject({
        method: route.method as 'GET',
        url: route.url.replace(/:[a-z_]+/g, 'x'),
      });
      if (res.statusCode !== 401) open.push(`${route.method} ${route.url} -> ${res.statusCode}`);
    }
    expect(open).toEqual([]);
  });
});

describe('reading — B cannot see A’s records', () => {
  it('does not list A’s source files', async () => {
    const res = await asB('GET', '/api/source-files');
    expect(ids(res)).not.toContain(fileA);
  });

  it('answers 404 for A’s source file status', async () => {
    expect((await asB('GET', `/api/source-files/${fileA}/status`)).statusCode).toBe(404);
  });

  it('does not list A’s documents', async () => {
    const res = await asB('GET', '/api/documents');
    expect(ids(res)).not.toContain(docA);
    expect(ids(res)).toContain(docB);
  });

  it('does not return A’s documents from a full-text search (M-2)', async () => {
    const mine = await asA('GET', `/api/documents?q=${SECRET}`);
    expect(ids(mine)).toContain(docA); // the index does contain it

    const theirs = await asB('GET', `/api/documents?q=${SECRET}`);
    expect(ids(theirs)).not.toContain(docA);
  });

  it('does not return A’s documents from a search for a word only in a page, a result or a doctor’s name (M-2)', async () => {
    for (const word of [PAGE_WORD, VALUE_WORD, DOCTOR_WORD]) {
      expect(ids(await asA('GET', `/api/documents?q=${word}`)), `the index holds ${word}`).toContain(docA);
      expect(ids(await asB('GET', `/api/documents?q=${word}`)), `${word} must find nothing for B`).toEqual([]);
    }
  });

  it('does not return A’s documents when filtering by a tag name both use', async () => {
    const res = await asB('GET', '/api/documents?tag=cardiology');
    expect(ids(res)).toEqual([docB]);
  });

  it('does not return A’s documents when filtering by provider', async () => {
    expect(ids(await asB('GET', '/api/documents?provider=Secret'))).toEqual([]);
  });

  it('answers 404 for A’s document, with the same body as one that does not exist', async () => {
    const theirs = await asB('GET', `/api/documents/${docA}`);
    const missing = await asB('GET', `/api/documents/${uuidv4()}`);

    expect(theirs.statusCode).toBe(404);
    expect(theirs.json()).toEqual(missing.json());
  });

  it('answers 404 for A’s page image', async () => {
    expect((await asB('GET', `/api/pages/${pageA}/image`)).statusCode).toBe(404);
  });

  it('does not list A’s tags, and gives B their own', async () => {
    const names = (await asB('GET', '/api/tags')).json() as Array<{ name: string }>;
    expect(names.map(t => t.name)).not.toContain('a-only-tag');
    expect(names.map(t => t.name)).toContain('cardiology');

    // Per-user vocabulary: B's 'cardiology' is a different row from A's.
    const tagIdsA = ((await asA('GET', '/api/tags')).json() as Array<{ id: number; name: string }>)
      .filter(t => t.name === 'cardiology').map(t => t.id);
    const tagIdsB = (await asB('GET', '/api/tags')).json() as Array<{ id: number; name: string }>;
    expect(tagIdsB.filter(t => t.name === 'cardiology').map(t => t.id)).not.toEqual(tagIdsA);
  });

  it('does not list A’s share links', async () => {
    const res = await asB('GET', '/api/share-links');
    expect(ids(res)).not.toContain(linkA);
    expect(ids(res)).not.toContain(tagLinkA);
  });
});

describe('writing — B cannot change A’s records', () => {
  it('cannot PATCH A’s document', async () => {
    const res = await asB('PATCH', `/api/documents/${docA}`, { provider: 'Hijacked', user_notes: 'x' });
    expect(res.statusCode).toBe(404);

    const doc = await getStore().documents.findFor(OWNER_ID, docA);
    expect(doc?.provider).toBe('Secret Clinic');
    expect(doc?.user_notes).toBeNull();
  });

  it('cannot retag A’s document through a PATCH', async () => {
    await asB('PATCH', `/api/documents/${docA}`, { tags: ['planted'] });
    const tags = await getStore().tags.namesForDocument(OWNER_ID, docA);
    expect(tags).not.toContain('planted');
    expect(tags).toContain('a-only-tag');
  });

  it('cannot split A’s document', async () => {
    const before = await getStore().documents.findFor(OWNER_ID, docA);
    const res = await asB('POST', `/api/documents/${docA}/boundary`, { action: 'split', at_page: 1 });
    expect(res.statusCode).toBe(404);
    expect(await getStore().documents.findFor(OWNER_ID, docA)).toEqual(before);
  });

  it('cannot merge A’s document into one of B’s', async () => {
    const res = await asB('POST', `/api/documents/${docB}/boundary`, {
      action: 'merge', with_document_id: docA,
    });
    expect(res.statusCode).toBe(404);
    expect(await getStore().documents.findFor(OWNER_ID, docA)).not.toBeNull();
    expect(await getStore().fields.listForDocument(OWNER_ID, docA)).toHaveLength(1);
  });

  it('cannot merge one of B’s documents into A’s', async () => {
    const res = await asB('POST', `/api/documents/${docA}/boundary`, {
      action: 'merge', with_document_id: docB,
    });
    expect(res.statusCode).toBe(404);
    expect(await getStore().documents.findFor(B.id, docB)).not.toBeNull();
  });

  it('cannot revoke A’s share link', async () => {
    const res = await asB('DELETE', `/api/share-links/${linkA}`);
    expect(res.statusCode).toBe(404);

    const stillWorks = await app.inject({ method: 'GET', url: `/api/share/${linkA}/documents` });
    expect(stillWorks.statusCode).toBe(200);
  });

  it('does not treat B’s upload of the same bytes as a duplicate of A’s', async () => {
    const boundary = 'IsolationBoundary';
    const bytes = Buffer.from('%PDF-1.4 identical scan bytes');
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="s.pdf"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const headers = (cookie: string) => ({
      cookie, 'content-type': `multipart/form-data; boundary=${boundary}`,
    });

    const first = await app.inject({ method: 'POST', url: '/api/source-files/upload', headers: headers(cookieA), payload: body });
    const aId = (first.json() as Array<{ id: string }>)[0].id;

    const second = await app.inject({ method: 'POST', url: '/api/source-files/upload', headers: headers(cookieB), payload: body });
    const result = (second.json() as Array<Record<string, unknown>>)[0];

    // Reporting "duplicate of <A's id>" would tell B that A holds this file.
    expect(result.skipped).toBeUndefined();
    expect(result.existing_id).toBeUndefined();
    expect(result.id).not.toBe(aId);
  });
});

describe('sharing (M-5, P12)', () => {
  it('refuses a link naming a document B does not own', async () => {
    const res = await asB('POST', '/api/share-links', {
      scope: 'document_ids', scope_value: [docB, docA],
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a link naming only documents that do not exist', async () => {
    const res = await asB('POST', '/api/share-links', {
      scope: 'document_ids', scope_value: [uuidv4()],
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a link naming B’s own documents', async () => {
    const res = await asB('POST', '/api/share-links', {
      scope: 'document_ids', scope_value: [docB],
    });
    expect(res.statusCode).toBe(201);
  });

  it('gives each link only its owner’s documents, even with scope "all"', async () => {
    const a = await app.inject({ method: 'GET', url: `/api/share/${linkA}/documents` });
    const b = await app.inject({ method: 'GET', url: `/api/share/${linkB}/documents` });

    expect(ids(a)).toContain(docA);
    expect(ids(a)).not.toContain(docB);
    expect(ids(b)).toContain(docB);
    expect(ids(b)).not.toContain(docA);
  });

  it('scopes a tag link to its owner’s documents when both use the tag', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/share/${tagLinkA}/documents` });
    expect(ids(res)).toEqual([docA]);
  });

  it('keeps each owner’s access log to their own links', async () => {
    await getStore().shareLinks.logAccess(linkA, new Date().toISOString(), null, true);
    expect(await getStore().shareLinks.accessLogFor(B.id, linkA)).toEqual([]);
    expect((await getStore().shareLinks.accessLogFor(OWNER_ID, linkA)).length).toBeGreaterThan(0);
  });
});

/**
 * The same properties one layer down. A route can be correct while the repository
 * is not — a second caller, or a refactor, would find that out the hard way — so
 * every method that takes a user id is shown to honour it.
 */
describe('store — every method honours the acting user', () => {
  it('reads return nothing for a record the user does not own', async () => {
    const store = getStore();

    expect(await store.sourceFiles.findFor(B.id, fileA)).toBeNull();
    expect(await store.sourceFiles.findByChecksumFor(B.id, checksumA)).toBeNull();
    expect((await store.sourceFiles.listFor(B.id)).map(f => f.id)).not.toContain(fileA);

    expect(await store.documents.findFor(B.id, docA)).toBeNull();
    expect(await store.fields.listForDocument(B.id, docA)).toEqual([]);
    expect(await store.tags.namesForDocument(B.id, docA)).toEqual([]);

    expect(await store.pages.listForSourceFile(B.id, fileA)).toEqual([]);
    expect(await store.pages.listForDocument(B.id, docA)).toEqual([]);
    expect(await store.pages.findGroundingContext(B.id, pageA)).toBeNull();
    expect(await store.pages.findImagePathFor(B.id, pageA)).toBeNull();
  });

  it('writes change nothing for a record the user does not own', async () => {
    const store = getStore();
    const before = await store.documents.findFor(OWNER_ID, docA);
    const fileBefore = await store.sourceFiles.findFor(OWNER_ID, fileA);

    await store.documents.update(B.id, docA, { provider: 'x', reviewed: true });
    await store.documents.setPageEnd(B.id, docA, 99);
    await store.documents.delete(B.id, docA);
    await store.tags.setForDocument(B.id, docA, ['planted']);
    await store.tags.removeAllForDocument(B.id, docA);
    await store.fields.reassignDocument(B.id, docA, docB);
    await store.sourceFiles.setStatus(B.id, fileA, 'error', 'x');
    await store.sourceFiles.setPageCount(B.id, fileA, 99);
    await store.shareLinks.revoke(B.id, linkA);
    expect(await store.sourceFiles.clearDerived(B.id, fileA)).toBe(0);
    expect(await store.sourceFiles.delete(B.id, fileA)).toBe(false);
    expect(await store.pages.setHiddenForDocument(B.id, docA, true)).toBe(0);
    // Moving pages: another user's page has no upload, cannot be numbered, and its values cannot be moved.
    expect(await store.pages.sourceFileOf(B.id, pageA)).toBeNull();
    await expect(store.pages.renumber(B.id, fileA, [pageA])).rejects.toThrow();
    await store.documents.setRange(B.id, docA, 7, 9);
    await store.fields.reassignPage(B.id, pageA, docB);
    await store.measurements.reassignPage(B.id, pageA, docB);

    expect(await store.documents.findFor(OWNER_ID, docA)).toEqual(before);
    expect(await store.sourceFiles.findFor(OWNER_ID, fileA)).toEqual(fileBefore);
    expect(await store.tags.namesForDocument(OWNER_ID, docA)).toContain('a-only-tag');
    expect(await store.fields.listForDocument(OWNER_ID, docA)).toHaveLength(1);
    expect(await store.fields.listForDocument(B.id, docB)).toEqual([]); // A's field did not move into B's document
    const links = await store.shareLinks.listFor(OWNER_ID);
    expect(links.find(l => l.id === linkA)?.revoked).toBeFalsy();
  });

  it('a listing for B never contains a row owned by A', async () => {
    const store = getStore();
    const docs = await store.documents.listFor(B.id, { limit: 100, offset: 0 });
    expect(docs.every(d => d.id === docB || d.id !== docA)).toBe(true);
    expect(docs.map(d => d.id)).not.toContain(docA);

    expect((await store.shareLinks.listFor(B.id)).map(l => l.id)).not.toContain(linkA);
  });

  it('a create that names someone else’s record throws and inserts nothing', async () => {
    const store = getStore();

    await expect(store.documents.create(B.id, {
      id: uuidv4(), sourceFileId: fileA, pageStart: 1, pageEnd: 1,
    })).rejects.toThrow(/not found for this user/);

    await expect(store.pages.create(B.id, {
      id: uuidv4(), sourceFileId: fileA, pageNumber: 9, imagePath: '/tmp/x.png',
      imageWidth: 1, imageHeight: 1, rawText: null, elements: [],
      extractionSource: null, isContinuation: null,
      continuationConfidence: null, continuationReasoning: null,
    })).rejects.toThrow(/not found for this user/);

    // Attaching B's field to A's document — or A's page to B's document.
    await expect(store.fields.create(B.id, {
      id: uuidv4(), documentId: docA, pageId: pageA, label: 'x', value: 'y',
      sourceSnippet: null, bbox: null, confidence: null,
    })).rejects.toThrow(/not found for this user/);

    expect(await store.fields.listForDocument(OWNER_ID, docA)).toHaveLength(1);
    expect(await store.pages.listForSourceFile(OWNER_ID, fileA)).toHaveLength(1);
  });

  it('moving fields onto a document the user does not own does nothing', async () => {
    const store = getStore();
    // B's own document as the source, A's as the target.
    await store.fields.reassignDocument(B.id, docB, docA);
    expect(await store.fields.listForDocument(OWNER_ID, docA)).toHaveLength(1);
  });

  it('refuses to run without an acting user, rather than matching nothing quietly', async () => {
    await expect(getStore().documents.listFor('', { limit: 1, offset: 0 })).rejects.toThrow(/acting user/);
    await expect(getStore().documents.findFor(undefined as unknown as string, docA)).rejects.toThrow(/acting user/);
  });
});
