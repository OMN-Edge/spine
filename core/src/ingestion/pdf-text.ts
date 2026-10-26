import { fileSystem } from '../files.js';
import type { ParseResponse, UnstructuredElement } from '../types.js';

/**
 * The PDF's own text layer, read with PDF.js: what the Unstructured sidecar's `fast` strategy
 * returned, without a second process. No OCR; a page with no text layer has no elements, which
 * is how the caller finds it. Boxes are in PDF points from the top-left of the page, and the
 * page size is reported so the parser can scale them into the page image.
 *
 * PDF.js gives runs of text. They are joined into lines, and lines into paragraphs, because a
 * box per run is too fine for grounding a value and a box per page too coarse.
 * docs/sidecar.md says what the old sidecar returned and how this differs.
 */

interface Run { str: string; x0: number; x1: number; top: number; bottom: number }

/** The text layer holds glyph box edges; the sidecar's boxes ended a little lower, below the baseline. */
const DESCENT = 0.2;
/** Runs closer than this many line heights are one line; further apart are separate cells. */
const SAME_LINE_GAP = 1.5;
/** A line closer than this many line heights below the last belongs to its paragraph. */
const SAME_PARAGRAPH_GAP = 0.6;

export async function parseDocument(filePath: string): Promise<ParseResponse> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fileSystem().readFile(filePath));
  const task = getDocument({ data, useSystemFonts: true, verbosity: 0 });
  const pdf = await task.promise;
  try {
    const pages: ParseResponse['pages'] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const view = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const runs: Run[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [, , , , x, baseline] = item.transform;
        const height = item.height || Math.abs(item.transform[3]) || 10;
        runs.push({
          str: item.str,
          x0: x,
          x1: x + item.width,
          top: view.height - (baseline + height),
          bottom: view.height - baseline + height * DESCENT,
        });
      }
      const elements = paragraphs(runs).map(
        (p): UnstructuredElement => ({
          type: 'NarrativeText',
          text: p.text,
          page_number: n,
          bbox: p.box,
          source: 'native_text',
        }),
      );
      page.cleanup();
      // Like the sidecar, leave a page with nothing on it out.
      if (elements.length) {
        pages.push({ page_number: n, elements, extraction_source: 'native_text', image_width: view.width, image_height: view.height });
      }
    }
    return { pages };
  } finally {
    await task.destroy();
  }
}

interface Block { text: string; box: { x0: number; y0: number; x1: number; y1: number } }

function lines(runs: Run[]): Block[] {
  const sorted = [...runs].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const rows: Run[][] = [];
  for (const run of sorted) {
    const row = rows.find(r => {
      const last = r[r.length - 1];
      const height = last.bottom - last.top;
      return Math.abs(run.top - last.top) < height * 0.5 && run.x0 - last.x1 < height * SAME_LINE_GAP && run.x0 >= last.x0;
    });
    if (row) row.push(run);
    else rows.push([run]);
  }
  return rows.map(row => ({
    text: row.reduce((s, r, i) => (i === 0 ? r.str : s + (r.x0 - row[i - 1].x1 > 1 && !/\s$/.test(s) && !/^\s/.test(r.str) ? ' ' : '') + r.str), '').normalize('NFKC'),
    box: {
      x0: Math.min(...row.map(r => r.x0)),
      y0: Math.min(...row.map(r => r.top)),
      x1: Math.max(...row.map(r => r.x1)),
      y1: Math.max(...row.map(r => r.bottom)),
    },
  }));
}

function paragraphs(runs: Run[]): Block[] {
  const out: Block[] = [];
  for (const line of lines(runs)) {
    const height = line.box.y1 - line.box.y0;
    // Columns interleave line by line, so look back for the paragraph this line continues.
    const open = [...out].reverse().find(
      p =>
        line.box.y0 >= p.box.y0 &&
        line.box.y0 - p.box.y1 < height * SAME_PARAGRAPH_GAP &&
        line.box.x0 < p.box.x1 &&
        line.box.x1 > p.box.x0,
    );
    if (open) {
      open.text += `\n${line.text}`;
      open.box = {
        x0: Math.min(open.box.x0, line.box.x0),
        y0: open.box.y0,
        x1: Math.max(open.box.x1, line.box.x1),
        y1: Math.max(open.box.y1, line.box.y1),
      };
    } else {
      out.push({ text: line.text, box: { ...line.box } });
    }
  }
  return out;
}
