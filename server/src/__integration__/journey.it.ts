import { expect, it } from 'vitest';
import { describePipeline } from './support/live.js';
import { makeTextPdf } from './support/pdf.js';
import { CONSULTATION, DISCHARGE, FACTS, LAB_REPORT, PRESCRIPTION } from './support/fixtures.js';
import { OWNER_ID, ask, attach, confirm, proposalOf, reportOf, startWorld, until } from './support/world.js';
import { getStore } from '../store/index.js';

/**
 * The whole journey of a bulk export, with the real sidecar, the real model and the real assistant: a physician's export whose six pages
 * are from four documents and out of order is attached in the chat; the app reads it and reports; the pages are checked for mixing and
 * regrouped on the owner's confirmation; the grouping is confirmed; the owner asks about the result.
 *
 * What is asserted is what must hold whatever the model words: the facts in the pages, the structure of the answers, and that nothing
 * changes before a Confirm.
 */
const step = (what: string) => console.log(`[journey ${new Date().toISOString().slice(11, 19)}] ${what}`);

describePipeline('attach a mixed export and follow it to the end', () => {
  it('reads it, finds the mixed pages, regroups them on confirmation, and answers questions about the result', async () => {
    const w = await startWorld();
    const store = getStore();

    // Six pages, four documents, interleaved the way a bulk export comes out.
    const pages = [LAB_REPORT[0], DISCHARGE[0], CONSULTATION[0], LAB_REPORT[1], DISCHARGE[1], PRESCRIPTION[0]];
    step('attaching the export');
    const attached = await attach(w, [{ name: 'export-physician.pdf', content: makeTextPdf(pages) }]);
    expect(attached.files).toEqual([expect.objectContaining({ name: 'export-physician.pdf', state: 'reading' })]);
    const conversation = attached.conversation.id;
    const upload = attached.files[0].upload_id!;

    // 1. The app reports in the same conversation when reading ends.
    step('waiting for the report');
    const report = await reportOf(w, conversation);
    const notice = report.data as { state: string; pages: number; documents: unknown[]; grouping_pending: boolean; looks_mixed: boolean; doctors_added: string[]; tests_new: string[]; matches_open: number };
    expect(notice.state).toBe('done');
    expect(notice.pages).toBe(6);
    expect(notice.documents.length).toBeGreaterThanOrEqual(2);
    expect(notice.grouping_pending).toBe(true);
    // Report-level facts from reading: the doctors on the pages were filed, and the tests are new.
    expect(notice.doctors_added.join(' ')).toMatch(/popescu/i);
    expect(notice.tests_new.join(' ')).toMatch(/hemoglobin/i);
    // The pages of the lab report and the discharge note are apart, and the signals say so.
    expect(notice.looks_mixed).toBe(true);
    expect((await store.conversations.find(OWNER_ID, conversation))!.unread).toBe(true);
    expect((await store.sourceFiles.findFor(OWNER_ID, upload))!.grouping_confirmed).toBe(false);

    // 2. The owner presses "Check the pages with AI": the analysis runs and reports in the same conversation.
    step('checking the pages with the model');
    expect((await w.app.inject({ method: 'POST', url: `/api/source-files/${upload}/regroup/analyze`, headers: { cookie: w.cookie } })).statusCode).toBe(202);
    const plan = await until('the regrouping plan', async () => (await store.regroupPlans.get(OWNER_ID, upload))?.plan as {
      groups: Array<{ page_numbers: number[]; status: string; confidence: number }>; model_calls: number; embeddings: boolean;
    } | undefined, 240_000, 2000);
    console.log(`[journey] plan: ${plan.groups.map(g => `${g.page_numbers.join('+')}:${g.status}`).join(' ')} (${plan.model_calls} model calls, embeddings ${plan.embeddings})`);
    const sets = plan.groups.map(g => [...g.page_numbers].sort((a, b) => a - b).join(','));
    // The lab report is pages 1 and 4, the discharge note pages 2 and 5; the model must find both and say they are sure.
    expect(sets).toContain('1,4');
    expect(sets).toContain('2,5');
    for (const g of plan.groups.filter(g => ['1,4', '2,5'].includes([...g.page_numbers].sort((a, b) => a - b).join(',')))) expect(g.status).toBe('validated');
    // Nothing has moved: a plan is not a change.
    expect((await store.pages.listForSourceFile(OWNER_ID, upload)).map(p => p.page_number).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    await until('the regrouping notice', async () => (await store.conversations.messages(OWNER_ID, conversation)).find(m => m.kind === 'regroup'), 30_000);

    // 3. The assistant, in that conversation, proposes the groups; Confirm makes them and reads the changed documents again.
    step('asking the assistant to regroup');
    const proposed = await ask(w, 'Show me what you found and regroup the pages the model was sure of.', { conversation });
    const regroup = proposalOf(proposed, 'regroup');
    expect(regroup.upload.id).toBe(upload);
    const kept = regroup.groups.filter(g => g.status === 'validated');
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect((await store.pages.listForSourceFile(OWNER_ID, upload)).map(p => p.page_number).sort()).toEqual([1, 2, 3, 4, 5, 6]);

    step('confirming the regrouping');
    const applied = await w.app.inject({ method: 'POST', url: `/api/source-files/${upload}/regroup`, headers: { cookie: w.cookie }, payload: { groups: kept.map(g => g.page_ids) } });
    expect(applied.statusCode).toBe(200);
    const { touched } = applied.json() as { touched: string[] };
    step('reading the changed documents again');
    const reread = await w.app.inject({ method: 'POST', url: `/api/source-files/${upload}/extract`, headers: { cookie: w.cookie }, payload: { document_ids: touched } });
    expect(reread.statusCode).toBe(200);

    const docs = await store.documents.listFor(OWNER_ID, { sourceFileId: upload, includeUnconfirmed: true, limit: 50, offset: 0 });
    console.log(`[journey] documents: ${docs.map(d => `${d.page_start}-${d.page_end} ${d.doc_type} "${d.title}"`).join(' | ')}`);
    const lab = docs.find(d => d.page_start <= 1 && d.page_end >= 2) ?? docs.find(d => d.doc_type === 'lab_result');
    expect(lab).toBeTruthy();
    // The lab report was read from its two pages together: the value, the date and the provider are the ones on the pages.
    const results = await store.measurements.listForDocument(OWNER_ID, lab!.id);
    expect(results.some(m => /hemoglobin/i.test(m.canonical) && String(m.value_text).startsWith('13.5'))).toBe(true);
    expect(results.some(m => /ldl|colesterol/i.test(m.canonical))).toBe(true);
    expect(lab!.doc_date).toBe(FACTS.lab.date);
    expect(lab!.provider ?? '').toMatch(FACTS.lab.provider);
    const discharge = docs.find(d => d.doc_type === 'discharge_note');
    expect(discharge).toBeTruthy();

    // 4. The grouping is right: the assistant proposes confirming it, and Confirm puts the documents in the archive.
    step('confirming the grouping through the assistant');
    const confirming = await ask(w, 'The grouping looks right now. Please confirm it.', { conversation });
    await confirm(w, proposalOf(confirming, 'confirm_grouping'));
    expect((await store.sourceFiles.findFor(OWNER_ID, upload))!.grouping_confirmed).toBe(true);
    const timeline = (await w.app.inject({ method: 'GET', url: '/api/documents', headers: { cookie: w.cookie } })).json() as Array<{ id: string }>;
    expect(timeline.length).toBeGreaterThanOrEqual(3);

    // 5. And now the owner can ask about what is in the archive.
    step('asking about the result');
    const answer = await ask(w, 'What was my hemoglobin in the March 2026 lab report, and was it in range?');
    expect(answer.answer ?? '').toMatch(/13[.,]5/);
    expect(answer.sources.length).toBeGreaterThan(0);
    expect(answer.sources.some(s => s.id === lab!.id)).toBe(true);
    expect(answer.proposals).toBeUndefined();
  });
});
