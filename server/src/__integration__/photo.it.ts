import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { expect, it } from 'vitest';
import { describePipeline } from './support/live.js';
import { LAB_REPORT } from './support/fixtures.js';
import { makeTextPdf } from './support/pdf.js';
import { OWNER_ID, attach, startWorld, until } from './support/world.js';
import { getStore } from 'spine-core/store/index.js';

/**
 * A photograph of a paper report, which has no text layer at all: the only way to read it is to send the picture to the model, which
 * is allowed here (`SPINE_MULTIMODAL_ENABLED`). The picture is made by drawing a fixture page and rendering it to a PNG, so the text
 * exists only as pixels. Asserted: the values come out as printed, the page says it was read by the model, and, because a model gives
 * the words and not where they sit, no box is drawn for any value (CLAUDE.md, Parsing).
 */
describePipeline('a photo of a paper report', () => {
  it('is read by the model, and its values come out as printed with no box drawn on the page', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'spine-it-photo-'));
    try {
      writeFileSync(path.join(dir, 'page.pdf'), makeTextPdf([LAB_REPORT[0]]));
      execFileSync('pdftoppm', ['-png', '-r', '110', '-singlefile', path.join(dir, 'page.pdf'), path.join(dir, 'page')]);
      const png = readFileSync(path.join(dir, 'page.png'));

      const w = await startWorld();
      const attached = await attach(w, [{ name: 'photo.png', content: png, type: 'image/png' }]);
      expect(attached.files).toEqual([expect.objectContaining({ name: 'photo.png', state: 'reading' })]);
      const upload = attached.files[0].upload_id!;

      // One page has no grouping to check, so the document is read as soon as the page is.
      const docs = await until('the document read from the photo', async () => {
        const f = await getStore().sourceFiles.findFor(OWNER_ID, upload);
        if (f?.status === 'error') throw new Error(`the upload failed: ${f.error_message}`);
        const found = await getStore().documents.listFor(OWNER_ID, { limit: 100, offset: 0, includeUnconfirmed: true });
        return found.length > 0 && f?.status === 'done' ? found : null;
      }, 300_000, 3000);
      expect(docs).toHaveLength(1);

      const pages = await getStore().pages.listForSourceFile(OWNER_ID, upload);
      expect(pages).toHaveLength(1);
      expect(pages[0]!.extraction_source).toBe('multimodal');
      // A model gives the words and not where they sit: the stored text blocks carry no box.
      const stored = await getStore().pages.listForDocument(OWNER_ID, docs[0]!.id);
      const elements = JSON.parse(stored[0]!.elements ?? '[]') as Array<{ bbox: unknown; source: string }>;
      expect(elements.length).toBeGreaterThan(0);
      expect(elements.every(e => e.bbox === null && e.source === 'multimodal')).toBe(true);

      // The upload is done when its pages are read; the document is read after that, in the background.
      const results = await until('the results read from the photo', async () => {
        const found = await getStore().measurements.listForDocument(OWNER_ID, docs[0]!.id);
        return found.length > 0 ? found : null;
      }, 300_000, 3000);
      const read = JSON.stringify(results.map(m => [m.name, m.canonical, m.value_text, m.unit]));
      expect(results.some(m => /hemoglobin/i.test(`${m.canonical} ${m.name}`) && String(m.value_text).startsWith('13.5')), read).toBe(true);
      expect(results.some(m => /leucocit|wbc|white/i.test(`${m.canonical} ${m.name}`) && String(m.value_text).startsWith('6.2')), read).toBe(true);
      // Where the model says the text sits is not trusted, so it is not asked for: no value carries a box.
      expect(results.every(m => m.bbox_x0 == null && m.bbox_y0 == null && m.bbox_x1 == null && m.bbox_y1 == null)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
