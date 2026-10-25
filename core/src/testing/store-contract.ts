import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import type { Change, ResolvedShareLink, Store } from '../store/types.js';
import { isListed } from '../store/visibility.js';

/**
 * What every store must do, through the interface and nothing else. `describeStoreContract` is run once for each adapter
 * (`store-contract.test.ts`), so a second adapter is finished when this passes for it. The rest of the suite goes through the interface as
 * well, but against the one adapter there is; this is the part that says what the interface *means*: who sees what, in what order, and
 * what a transaction, a rename or a sync does.
 */
const A = 'user-a';
const B = 'user-b';

export function describeStoreContract(name: string, make: () => Store | Promise<Store>) {
  describe(`the store contract: ${name}`, () => {
    let store: Store;
    beforeEach(async () => {
      store = await make();
      for (const [id, email] of [[A, 'a@spine.test'], [B, 'b@spine.test']]) {
        await store.users.create({ id, email, passwordHash: 'x', createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), consent: undefined });
      }
    });
    afterEach(async () => { await store.close(); });

    /** An upload with pages, and one document over them, made as the pipeline makes them. */
    async function document(user: string, o: { title?: string; summary?: string; date?: string | null; pages?: number; hidden?: boolean[]; confirmed?: boolean; tags?: string[]; upload?: string } = {}) {
      const sourceFileId = o.upload ?? uuid();
      if (!o.upload) {
        await store.sourceFiles.create(user, { id: sourceFileId, uploadedAt: new Date().toISOString(), originalFilename: 'scan.pdf', filePath: '/tmp/x.pdf', mimeType: 'application/pdf', checksum: uuid() });
        await store.sourceFiles.setStatus(user, sourceFileId, 'done');
        if (o.confirmed === false) await store.sourceFiles.setGroupingConfirmed(user, sourceFileId, false);
      }
      const pageCount = o.pages ?? 1;
      const pageIds: string[] = [];
      for (let n = 1; n <= pageCount; n++) {
        const id = uuid();
        pageIds.push(id);
        await store.pages.create(user, { id, sourceFileId, pageNumber: n, imagePath: '/tmp/p.png', imageWidth: 800, imageHeight: 1100, rawText: `page ${n} text`, elements: [], extractionSource: 'native_text', isContinuation: null, continuationConfidence: null, continuationReasoning: null });
        if (o.hidden?.[n - 1]) await store.pages.setHidden(user, id, true);
      }
      const id = uuid();
      await store.documents.create(user, { id, sourceFileId, pageStart: 1, pageEnd: Math.max(pageCount, 1), title: o.title ?? null, docDate: o.date === undefined ? '2026-01-15' : o.date, provider: 'Example Clinic', docType: 'lab_result', aiSummary: o.summary ?? 'A lab result.' });
      if (o.tags?.length) await store.tags.setForDocument(user, id, o.tags);
      return { id, sourceFileId, pageIds };
    }
    const resolved = (scope: string, scopeValue: string | null): ResolvedShareLink =>
      ({ id: uuid(), userId: A, scope, scopeValue, expiresAt: '2999-01-01T00:00:00.000Z', includeScans: false, language: null, requireApproval: false, allowChat: false });
    const list = async (user: string, filter: Partial<Parameters<Store['documents']['listFor']>[1]> = {}) =>
      (await store.documents.listFor(user, { limit: 100, offset: 0, ...filter })).map(d => d.id);

    describe('who sees what', () => {
      it('gives a user their own documents and no one else’s, whatever they ask for', async () => {
        const mine = await document(A, { tags: ['cardio'], summary: 'hemoglobin result' });
        const theirs = await document(B, { tags: ['cardio'], summary: 'hemoglobin result' });
        expect(await list(A)).toEqual([mine.id]);
        expect(await list(A, { q: 'hemoglobin' })).toEqual([mine.id]);
        expect(await list(A, { tag: 'cardio' })).toEqual([mine.id]);
        expect(await store.documents.findFor(A, theirs.id)).toBeNull();
        expect(await store.documents.findFor(B, mine.id)).toBeNull();
      });

      it('changes and deletes nothing of another user’s', async () => {
        const mine = await document(A, { title: 'mine' });
        await store.documents.update(B, mine.id, { title: 'taken' });
        await store.documents.delete(B, mine.id);
        expect((await store.documents.findFor(A, mine.id))?.title).toBe('mine');
        expect(await store.tags.rename(B, (await store.tags.listFor(A))[0]?.id ?? 0, 'taken')).toBe('not_found');
      });

      it('refuses a call that names no user', async () => {
        await expect(store.documents.listFor(undefined as never, { limit: 1, offset: 0 })).rejects.toThrow();
        await expect(store.tags.listFor('' as never)).rejects.toThrow();
      });

      it('shares only the owner’s shown documents, by every kind of scope', async () => {
        const one = await document(A, { tags: ['labs'], date: '2026-03-01' });
        const two = await document(A, { tags: ['visit'], date: '2026-04-01' });
        const aside = await document(A, { tags: ['labs'], hidden: [true] });
        const other = await document(B, { tags: ['labs'] });
        const link = (scope: 'all' | 'tag' | 'document_ids' | 'date_range', value: unknown) => resolved(scope, value === null ? null : JSON.stringify(value));
        const shared = async (l: ReturnType<typeof link>) => (await store.documents.listForShare(l)).map(d => d.id).sort();

        expect(await shared(link('all', null))).toEqual([one.id, two.id].sort());
        expect(await shared(link('tag', 'labs'))).toEqual([one.id]);
        expect(await shared(link('document_ids', [one.id, aside.id, other.id]))).toEqual([one.id]);
        expect(await shared(link('date_range', { from: '2026-03-15', to: '2026-12-31' }))).toEqual([two.id]);
      });
    });

    describe('order', () => {
      it('lists the newest document date first and the undated last, and newest created first among equals', async () => {
        const old = await document(A, { date: '2025-01-01' });
        const undated = await document(A, { date: null });
        const first = await document(A, { date: '2026-06-01' });
        const second = await document(A, { date: '2026-06-01' });
        expect(await list(A)).toEqual([second.id, first.id, old.id, undated.id]);
      });

      it('pages the same way: no document is on two pages or none', async () => {
        const made = [];
        for (let i = 0; i < 5; i++) made.push((await document(A, { date: `2026-0${i + 1}-01` })).id);
        const pages = [...(await list(A, { limit: 2, offset: 0 })), ...(await list(A, { limit: 2, offset: 2 })), ...(await list(A, { limit: 2, offset: 4 }))];
        expect(pages).toEqual(made.reverse());
      });
    });

    describe('search', () => {
      it('finds by a word anywhere in a document, a title ahead of a page, with the matched words marked in a snippet', async () => {
        const inSummary = await document(A, { summary: 'notes on the cardiology visit', date: '2026-05-01' });
        const inTitle = await document(A, { title: 'Cardiology referral', summary: 'unrelated', date: '2026-01-01' });
        const rows = await store.documents.listFor(A, { q: 'cardiology', limit: 10, offset: 0 });
        expect(rows.map(d => d.id)).toEqual([inTitle.id, inSummary.id]);
        for (const row of rows) expect(row.snippet).toMatch(/\u0001cardiology\u0002/i);
      });

      it('finds nothing for a query with no word in it, and does not find across users', async () => {
        await document(A, { summary: 'hemoglobin' });
        await document(B, { summary: 'zinc' });
        expect(await list(A, { q: '"?!…' })).toEqual([]);
        expect(await list(A, { q: 'zinc' })).toEqual([]);
      });

      it('follows an edit: the old words stop matching and the new ones start', async () => {
        const doc = await document(A, { summary: 'alpha' });
        expect(await list(A, { q: 'alpha' })).toEqual([doc.id]);
        await store.documents.update(A, doc.id, { ai_summary: 'omega' });
        expect(await list(A, { q: 'alpha' })).toEqual([]);
        expect(await list(A, { q: 'omega' })).toEqual([doc.id]);
      });
    });

    describe('which documents are shown', () => {
      // The rule is store/visibility.ts; this is every store's rendering of it, over every case it names.
      const cases: Array<{ name: string; hidden?: boolean[]; pages?: number; confirmed: boolean }> = [];
      for (const confirmed of [true, false]) {
        cases.push({ name: `no page, ${confirmed ? 'confirmed' : 'unconfirmed'}`, pages: 0, confirmed });
        cases.push({ name: `one shown page, ${confirmed ? 'confirmed' : 'unconfirmed'}`, hidden: [false], confirmed });
        cases.push({ name: `one hidden page, ${confirmed ? 'confirmed' : 'unconfirmed'}`, hidden: [true], confirmed });
        cases.push({ name: `a hidden and a shown page, ${confirmed ? 'confirmed' : 'unconfirmed'}`, hidden: [true, false], pages: 2, confirmed });
        cases.push({ name: `every page hidden, ${confirmed ? 'confirmed' : 'unconfirmed'}`, hidden: [true, true], pages: 2, confirmed });
      }
      for (const options of [{}, { includeUnconfirmed: true }, { includeHidden: true }]) {
        for (const c of cases) {
          it(`${c.name}, asked for with ${JSON.stringify(options)}`, async () => {
            const made = await document(A, { pages: c.pages ?? c.hidden?.length ?? 1, hidden: c.hidden, confirmed: c.confirmed });
            const pages = (c.hidden ?? (c.pages === 0 ? [] : [false])).map(hidden => ({ hidden }));
            const shown = (await list(A, options)).includes(made.id);
            expect(shown).toBe(isListed({ pages: c.pages === 0 ? [] : pages, groupingConfirmed: c.confirmed }, options));
          });
        }
      }

      it('bringing a hidden page back brings the document back', async () => {
        const made = await document(A, { hidden: [true] });
        expect(await list(A)).toEqual([]);
        await store.pages.setHidden(A, made.pageIds[0], false);
        expect(await list(A)).toEqual([made.id]);
      });
    });

    describe('tags', () => {
      it('renaming to a name that exists makes the two one, with no document carrying it twice', async () => {
        const x = await document(A, { tags: ['one'] });
        const y = await document(A, { tags: ['two', 'one'] });
        const tags = await store.tags.listFor(A);
        const two = tags.find(t => t.name === 'two')!;
        expect(await store.tags.rename(A, two.id, 'one')).toBe('merged');
        const names = (await store.tags.listFor(A)).map(t => t.name);
        expect(names.filter(n => n === 'one')).toHaveLength(1);
        expect(names).not.toContain('two');
        expect(await store.tags.namesForDocument(A, x.id)).toEqual(['one']);
        expect(await store.tags.namesForDocument(A, y.id)).toEqual(['one']);
      });

      it('keeps a share that is scoped to a tag pointing at it through a rename and a merge, and at nothing after a removal', async () => {
        await document(A, { tags: ['alpha', 'beta'] });
        const id = uuid();
        await store.shareLinks.create(A, { id, tokenHash: uuid(), label: null, scope: 'tag', scopeValue: JSON.stringify('alpha'), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), includeScans: false, language: null, requireApproval: false, allowChat: false });
        const tags = await store.tags.listFor(A);
        const alpha = tags.find(t => t.name === 'alpha')!;
        const beta = tags.find(t => t.name === 'beta')!;
        const scope = async () => (await store.shareLinks.findFor(A, id))?.scope_value;

        expect(await store.tags.rename(A, alpha.id, 'gamma')).toBe('ok');
        expect(await scope()).toBe(JSON.stringify('gamma'));
        expect(await store.tags.merge(A, alpha.id, beta.id)).toBe('ok');
        expect(await scope()).toBe(JSON.stringify('beta'));
        expect(await store.tags.remove(A, beta.id)).toBe(true);
        expect(await scope()).toBe(JSON.stringify('beta')); // names a tag that no longer exists, so shares nothing
        expect(await store.documents.listForShare(resolved('tag', JSON.stringify('beta')))).toEqual([]);
      });

      it('does not create a tag in one user’s vocabulary for a document that is another’s', async () => {
        const mine = await document(A);
        await store.tags.setForDocument(B, mine.id, ['intruder']);
        expect((await store.tags.listFor(B)).map(t => t.name)).not.toContain('intruder');
        expect(await store.tags.namesForDocument(A, mine.id)).toEqual([]);
      });
    });

    describe('transactions', () => {
      it('commit what the callback did, all of it', async () => {
        await store.transaction(async tx => { await document2(tx, 'in one'); await document2(tx, 'transaction'); });
        expect((await list(A)).length).toBe(2);
      });

      it('undo all of it when the callback throws, and rethrow', async () => {
        await expect(store.transaction(async tx => { await document2(tx, 'doomed'); throw new Error('stop'); })).rejects.toThrow('stop');
        expect(await list(A)).toEqual([]);
      });

      it('undo only the inner one when the outer catches its failure', async () => {
        await store.transaction(async tx => {
          await document2(tx, 'kept');
          await tx.transaction(async inner => { await document2(inner, 'dropped'); throw new Error('inner'); }).catch(() => undefined);
        });
        const titles = (await store.documents.listFor(A, { limit: 10, offset: 0 })).map(d => d.title);
        expect(titles).toEqual(['kept']);
      });

      async function document2(tx: Store, title: string) {
        const sourceFileId = uuid();
        await tx.sourceFiles.create(A, { id: sourceFileId, uploadedAt: new Date().toISOString(), originalFilename: 'scan.pdf', filePath: '/tmp/x.pdf', mimeType: 'application/pdf', checksum: uuid() });
        await tx.sourceFiles.setStatus(A, sourceFileId, 'done');
        await tx.documents.create(A, { id: uuid(), sourceFileId, pageStart: 1, pageEnd: 1, title, docDate: '2026-01-01', docType: 'lab_result' });
      }
    });

    describe('quotas', () => {
      it('counts up to the limit and then answers null without counting', async () => {
        expect([await store.usage.spend(A, '2026-10-24', 2), await store.usage.spend(A, '2026-10-24', 2), await store.usage.spend(A, '2026-10-24', 2)]).toEqual([1, 2, null]);
        expect(await store.usage.spend(A, '2026-10-25', 2)).toBe(1);
        expect(await store.usage.spend(B, '2026-10-24', 2)).toBe(1);
        expect(await store.usage.spend(A, '2026-10-26', 0)).toBeNull();
      });
    });

    describe('devices', () => {
      it('says whether writes wait to be sent: yes after a write, no once they are drained', async () => {
        await store.changes.drain();
        expect(await store.changes.pending()).toBe(false);
        await document(A, { title: 'waiting' });
        expect(await store.changes.pending()).toBe(true);
        await store.changes.drain();
        expect(await store.changes.pending()).toBe(false);
      });

      it('a second store given the first’s dump holds the same documents, and follows its later changes, edits and deletions', async () => {
        const other = await make();
        try {
          await other.users.create({ id: A, email: 'a@spine.test', passwordHash: 'x', createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), consent: undefined });
          await other.changes.drain();
          const kept = await document(A, { title: 'kept', tags: ['t'] });
          const gone = await document(A, { title: 'gone' });
          await store.changes.drain();
          await other.changes.apply(await store.changes.dump());
          expect((await other.documents.listFor(A, { limit: 10, offset: 0 })).map(d => d.id).sort()).toEqual([kept.id, gone.id].sort());
          expect(await other.tags.namesForDocument(A, kept.id)).toEqual(['t']);

          await new Promise(r => setTimeout(r, 5));
          await store.documents.update(A, kept.id, { title: 'edited' });
          await store.documents.delete(A, gone.id);
          const later: Change[] = await store.changes.drain();
          expect(later.length).toBeGreaterThan(0);
          await other.changes.apply(later);
          expect((await other.documents.findFor(A, kept.id))?.title).toBe('edited');
          expect(await other.documents.findFor(A, gone.id)).toBeNull();
          expect(await list(A, { q: 'edited' })).toEqual([kept.id]);
        } finally { await other.close(); }
      });

      it('applying changes that were already applied changes nothing', async () => {
        await document(A);
        const dump = await store.changes.dump().catch(async () => { await store.changes.drain(); return store.changes.dump(); });
        await store.changes.drain();
        expect(await store.changes.apply(dump)).toBe(0);
      });
    });
  });
}
