import { v4 as uuidv4 } from 'uuid';
import { fileSystem } from '../files.js';
import { sha256Hex } from '../digest.js';
import { getStore } from '../store/index.js';
import { newUploadPath } from '../ingestion/accept-upload.js';
import { removeUploadFiles } from '../ingestion/remove-upload.js';
import { startRestore } from '../archive/import-file.js';
import { getJobStatus } from '../ingestion/jobs.js';
import { storeTranslation } from '../translation.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';
import { demoSource, type DemoArchive, type DemoLanguage } from './archive.js';

/**
 * "Explore with sample records" (FR-ACC-03): an invented patient's archive written into the person's own archive through the restore path (the page images are made again, nothing is read by a
 * model), marked as samples, and removed again in one step. It arrives as a person would have kept it: the documents read, the links between them confirmed (a few left as suggestions), the
 * episodes named, and every document already translated into the languages the app is written in, so the demo shows all of it with no model. Nothing of it is shared with any other account,
 * and the sample is not a second kind of account: it is ordinary records the person can see, edit and share like any other, which is the point of trying it.
 */
export async function loadDemo(userId: string, lang: DemoLanguage): Promise<'loaded' | 'already'> {
  const store = getStore();
  if ((await store.sourceFiles.listFor(userId)).some(u => u.sample)) return 'already';

  const source = demoSource();
  const archive = await source.archive();
  const ids = new Map<string, string>(); // the archive's key of a document -> its id here
  let left = archive.records.length;
  let lastStamp = 0; // each file a millisecond after the last, so the files do not tie and their order does not depend on chance
  const oneDone = (key: string) => (documentIds: Array<string | null> | null) => {
    const id = documentIds?.[0];
    if (id) ids.set(key, id);
    if (--left === 0) void finish(userId, lang, archive, ids);
  };
  for (const record of archive.records) {
    const { fileId, filePath } = newUploadPath(userId, '.pdf');
    fileSystem().writeFileSync(filePath, await source.pdf(record.pdf));
    const checksum = sha256Hex(fileSystem().readFileSync(filePath));
    await store.sourceFiles.create(userId, {
      id: fileId, uploadedAt: new Date((lastStamp = Math.max(Date.now(), lastStamp + 1))).toISOString(), originalFilename: record.file.original_filename, filePath, mimeType: 'application/pdf', checksum, sample: true, fromExport: true,
    });
    startRestore(userId, fileId, filePath, false, record.file, new Set(), [], oneDone(record.key));
  }
  return 'loaded';
}

/** Once every document is in: the links, the episodes and the translations, which need the documents' ids. A failure of one does not stop the others; the samples are there without it. */
async function finish(userId: string, lang: DemoLanguage, archive: DemoArchive, ids: Map<string, string>): Promise<void> {
  const store = getStore();
  const now = new Date().toISOString();
  const attempt = async (what: string, work: () => Promise<unknown>) => { try { await work(); } catch (err) { logger.warn(`the sample's ${what} could not be written`, { error: describeError(err) }); } };
  await attempt('links', async () => {
    for (const l of archive.links) {
      const from = ids.get(l.from), to = ids.get(l.to);
      if (from && to) await store.links.add(userId, { from_document_id: from, to_document_id: to, kind: l.kind, source: l.source, state: l.state, reason: null }, now);
    }
  });
  await attempt('episodes', async () => {
    for (const e of archive.episodes) {
      const documentIds = e.documents.map(k => ids.get(k)).filter((x): x is string => !!x);
      if (documentIds.length >= 2) await store.episodes.create(userId, { id: uuidv4(), title: e.title?.[lang] ?? '', state: e.state, source: e.state === 'confirmed' ? 'owner' : 'auto', documentIds }, now);
    }
  });
  await attempt('translations', async () => {
    for (const record of archive.records) {
      const id = ids.get(record.key);
      if (!id) continue;
      for (const [language, t] of Object.entries(record.translations)) await storeTranslation(userId, id, language as 'en' | 'fr' | 'de', t);
    }
    // The doctors' specialties and the tests' names are kept by their text too (`term_translations`), for the pages that list them across documents,
    // from the same hand-written wording, so those pages show them in the reader's language with no model, as the documents are.
    const terms = new Map<string, Map<string, { kind: 'specialty' | 'test'; sourceText: string; translated: string }>>();
    for (const record of archive.records) {
      for (const [language, t] of Object.entries(record.translations)) {
        const held = terms.get(language) ?? new Map();
        for (const [sourceText, translated] of Object.entries(t.doctors)) held.set(`specialty\u0000${sourceText}`, { kind: 'specialty', sourceText, translated });
        for (const [sourceText, translated] of Object.entries(t.measurements)) held.set(`test\u0000${sourceText}`, { kind: 'test', sourceText, translated });
        terms.set(language, held);
      }
    }
    for (const [language, held] of terms) await store.termTranslations.put(userId, language, [...held.values()], new Date().toISOString());
  });
}

/** What the sample is doing: whether any is held, and whether it is still being set up. */
export async function demoState(userId: string): Promise<{ loaded: boolean; processing: boolean }> {
  const samples = (await getStore().sourceFiles.listFor(userId)).filter(u => u.sample);
  return { loaded: samples.length > 0, processing: samples.some(u => u.status === 'pending' || u.status === 'processing' || getJobStatus(u.id)?.status === 'processing') };
}

/** Removes the sample records and nothing else. */
export async function removeDemo(userId: string): Promise<'removed' | 'busy' | 'none'> {
  const store = getStore();
  const samples = (await store.sourceFiles.listFor(userId)).filter(u => u.sample);
  if (samples.length === 0) return 'none';
  if ((await demoState(userId)).processing) return 'busy';
  // The sample's episodes go with its documents; one the person added their own documents to stays, as it holds more than the sample.
  const sampleDocuments = new Set<string>();
  for (const s of samples) for (const d of await store.documents.listFor(userId, { sourceFileId: s.id, includeHidden: true, includeUnconfirmed: true, limit: 1000, offset: 0 })) sampleDocuments.add(d.id);
  for (const e of await store.episodes.list(userId)) if (e.document_ids.every(id => sampleDocuments.has(id))) await store.episodes.remove(userId, e.id);
  for (const s of samples) {
    const file = await store.sourceFiles.findFor(userId, s.id);
    if (!file) continue;
    removeUploadFiles(userId, file);
    await store.sourceFiles.delete(userId, s.id);
  }
  return 'removed';
}
