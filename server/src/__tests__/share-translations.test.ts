import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { accountsSchema } from 'spine-core/store/sqlite/schema-accounts.js';
import { recordsSchema } from 'spine-core/store/sqlite/schema-records.js';
import { openDatabase } from 'spine-core/store/sqlite/connection.js';
import { openNative } from 'spine-core/testing/driver-native.js';
import { createSqliteStoreWith } from 'spine-core/store/sqlite/store.js';
import { getStore, resetStore, type Store } from 'spine-core/store/index.js';
import { resetChatLlm, type ChatLlm, type TranslationBundle } from 'spine-core/llm/index.js';
import { carryTranslations, translateDocument } from 'spine-core/translation.js';
import { buildTestApp } from './helpers/app.js';
import { OWNER_ID, seedPage, seedSourceFile } from './helpers/seed.js';

/**
 * A share's copy carries what the owner already had translated, so a reader in that language is shown it at once instead of the model
 * being asked again at every visit (the reader's core starts from the copy each time). Only what the copy holds the original of goes:
 * the translation of a field on a page the owner hid stays behind with the field.
 */
const tr = (text: string | null) => (text === null ? null : `EN[${text}]`);
let asked = 0;
const fakeLlm = {
  translate: async (bundle: TranslationBundle) => {
    asked++;
    return {
      title: tr(bundle.title), summary: tr(bundle.summary), notes: tr(bundle.notes),
      fields: bundle.fields.map(f => ({ id: f.id, label: tr(f.label), value: `EN[${f.value}]` })),
      measurements: bundle.measurements.map(m => ({ id: m.id, name: `EN[${m.name}]` })),
      doctors: bundle.doctors.map(d => ({ id: d.id, specialty: tr(d.specialty) })),
    };
  },
} as unknown as ChatLlm;

let owner: Store;
beforeAll(async () => { await buildTestApp(); owner = getStore(); });
afterEach(() => { resetChatLlm(); });

/** A Romanian document on two pages; the second page, and the field read from it, are hidden by the owner. */
async function documentWithAHiddenPage() {
  const store = getStore();
  const sf = await seedSourceFile({ status: 'done' });
  const p1 = await seedPage(sf, { pageNumber: 1 });
  const p2 = await seedPage(sf, { pageNumber: 2 });
  const id = uuidv4();
  await store.documents.create(OWNER_ID, { id, sourceFileId: sf, pageStart: 1, pageEnd: 2, title: 'Buletin de analize', aiSummary: 'Rezumat', docType: 'lab_result', language: 'ro' });
  await store.fields.create(OWNER_ID, { id: uuidv4(), documentId: id, pageId: p1, label: 'observatie', value: 'Repaus', sourceSnippet: null, bbox: null, confidence: 1 });
  await store.fields.create(OWNER_ID, { id: uuidv4(), documentId: id, pageId: p2, label: 'observatie ascunsa', value: 'Pe pagina ascunsa', sourceSnippet: null, bbox: null, confidence: 1 });
  await store.pages.setHidden(OWNER_ID, p2, true);
  return id;
}

/** The copy as a share's reader opens it: made on the owner's device, applied to an empty store of the reader's own. */
async function openAsReader(documentId: string, finish?: (copy: Store) => Promise<void>): Promise<Store> {
  const { changes } = await owner.slice({
    userId: OWNER_ID, documentIds: [documentId], includeText: false, includeScans: false,
    link: { id: 'link-tr', label: null, createdAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z', language: 'en', allowChat: false },
    imagePathOf: () => '', finish,
  });
  const reader = createSqliteStoreWith({ adapter: 'sqlite', location: ':memory:' }, () => openDatabase(':memory:', openNative, undefined, 'full'), `${accountsSchema}\n${recordsSchema}`);
  await reader.users.create({ id: OWNER_ID, email: 'shared@invalid.example', passwordHash: 'x', createdAt: '2026-11-01T00:00:00.000Z', verifiedAt: '2026-11-01T00:00:00.000Z', starterTags: false });
  await reader.changes.apply(changes);
  return reader;
}

describe('a share’s copy and the owner’s translations', () => {
  it('leaves out the translation of what the copy does not hold: a field on a page the owner hid', async () => {
    const id = await documentWithAHiddenPage();
    resetChatLlm(fakeLlm);
    await translateDocument(OWNER_ID, id, 'en');
    expect((await owner.translations.get(OWNER_ID, id, 'en'))?.content).toContain('Pe pagina ascunsa'); // the owner's has it

    const reader = await openAsReader(id, copy => carryTranslations(OWNER_ID, [id], copy));
    const kept = await reader.translations.get(OWNER_ID, id, 'en');
    expect(kept?.content).toContain('EN[Repaus]');
    expect(kept?.content).not.toMatch(/ascuns/);
  });

  it('carries nothing that is no longer good for the owner’s document, and nothing at all when not asked to', async () => {
    const id = await documentWithAHiddenPage();
    resetChatLlm(fakeLlm);
    await translateDocument(OWNER_ID, id, 'en');
    expect(await (await openAsReader(id)).translations.languagesFor(OWNER_ID, id)).toEqual([]);

    await owner.documents.update(OWNER_ID, id, { ai_summary: 'Rezumat nou' }); // the kept one is stale now
    expect(await (await openAsReader(id, copy => carryTranslations(OWNER_ID, [id], copy))).translations.languagesFor(OWNER_ID, id)).toEqual([]);
  });

  it('carries a kept translation, so the reader is shown it with no call to the model', async () => {
    const id = await documentWithAHiddenPage();
    resetChatLlm(fakeLlm);
    expect(await translateDocument(OWNER_ID, id, 'en')).toMatchObject({ status: 'translated' });

    const reader = await openAsReader(id, copy => carryTranslations(OWNER_ID, [id], copy));
    resetStore(reader); // the reader's core, as the share opens it; it closes the owner's store, so this test comes last
    const before = asked;
    const shown = await translateDocument(OWNER_ID, id, 'en', { cachedOnly: true });
    expect(shown).toMatchObject({ status: 'cached', title: 'EN[Buletin de analize]', ai_summary: 'EN[Rezumat]' });
    expect(Object.values((shown as { fields: Record<string, { value: string }> }).fields).map(f => f.value)).toEqual(['EN[Repaus]']);
    expect(asked).toBe(before);
  });
});
