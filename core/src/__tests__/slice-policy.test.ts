import { describe, it, expect } from 'vitest';
import { accountsSchema } from '../store/sqlite/schema-accounts.js';
import { recordsSchema } from '../store/sqlite/schema-records.js';
import { readFileSync } from 'fs';
import path from 'path';
import { openDatabase } from '../store/sqlite/connection.js';
import { openNative } from '../testing/driver-native.js';
import { SLICE, SLICE_BUILT, SLICE_NEVER, sliceRow, type SliceName } from '../store/slice-policy.js';
import { REPLICATED } from '../store/sync.js';

/**
 * What a share copy may hold is a list (store/slice-policy.ts), and the recipient's browser holds all of it. This keeps the list and the
 * schema in step: nothing in the records is out of the list without someone having said it should not leave.
 */
const SCHEMA = `${accountsSchema}\n${recordsSchema}`;
const db = openDatabase(':memory:', openNative, SCHEMA, 'full');
const columnsOf = (table: string) => (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map(c => c.name);

describe('the share policy', () => {
  it('names every table of the records: copied, built by hand, or never shared', () => {
    const named = [...Object.keys(SLICE), ...SLICE_BUILT, ...SLICE_NEVER].sort();
    expect(named).toEqual([...REPLICATED].sort());
  });

  it('says what happens to every column of a table that is copied, and only columns that exist', () => {
    for (const name of Object.keys(SLICE) as SliceName[]) {
      const spec = SLICE[name] as { copy: string[]; set?: Record<string, unknown>; text?: Record<string, unknown>; scans?: Record<string, unknown>; left: string[] };
      const said = [...spec.copy, ...Object.keys(spec.set ?? {}), ...Object.keys(spec.text ?? {}), ...Object.keys(spec.scans ?? {}), ...spec.left];
      expect(new Set(said).size, `${name}: a column is named twice`).toBe(said.length);
      expect(said.sort(), name).toEqual(columnsOf(name).sort());
    }
  });

  it('keeps the owner’s file names, paths, checksums and the pages’ word boxes out', () => {
    const left = (t: SliceName) => (SLICE[t] as { left: string[] }).left;
    expect(left('source_files')).toEqual(expect.arrayContaining(['checksum']));
    expect(SLICE.source_files.copy).not.toContain('original_filename');
    expect(SLICE.source_files.copy).not.toContain('file_path');
    expect(SLICE.pages.set.elements).toBe('[]');
    expect(left('document_links')).toEqual(expect.arrayContaining(['reason']));
  });

  it('carries a doctor’s professional code, which the documents print, and where a detail sits on a page only with the scans', () => {
    expect(SLICE.doctors.copy).toContain('license_code');
    expect(SLICE.document_doctors.copy).toContain('printed_code');
    for (const t of ['extracted_fields', 'measurements'] as const) expect(Object.keys(SLICE[t].scans)).toEqual(['bbox_x0', 'bbox_y0', 'bbox_x1', 'bbox_y1']);
  });
});

describe('a row as it leaves', () => {
  const row = { id: 'p1', user_id: 'u', source_file_id: 's', page_number: 2, image_width: 10, image_height: 20, rotation: 0, source_page: 1, extraction_source: 'native_text', raw_text: 'Jane Example, Hb 13.5', elements: '[{"x":1}]', hidden: 1, image_path: '/home/owner/p.png', reviewed: 1 };

  it('keeps the page text only when the recipient may ask questions, and never the boxes or the owner’s path', () => {
    const closed = sliceRow('pages', row, { includeText: false, includeScans: false });
    const open = sliceRow('pages', row, { includeText: true, includeScans: false });
    expect(closed.raw_text).toBe('');
    expect(open.raw_text).toBe('Jane Example, Hb 13.5');
    for (const out of [closed, open]) {
      expect(out.elements).toBe('[]');
      expect(out.hidden).toBe(0);
      expect(out).not.toHaveProperty('image_path');
      expect(out).not.toHaveProperty('reviewed');
    }
  });

  it('takes a column the caller sets, and a blank snippet is null', () => {
    expect(sliceRow('pages', row, { includeText: false, includeScans: false }, { image_path: '/share/pages/0.png' }).image_path).toBe('/share/pages/0.png');
    expect(sliceRow('measurements', { id: 'm', source_snippet: 'Hb 13.5', bbox_x0: 1 }, { includeText: false, includeScans: false }).source_snippet).toBeNull();
    expect(sliceRow('measurements', { id: 'm', source_snippet: 'Hb 13.5', bbox_x0: 1 }, { includeText: true, includeScans: false }).source_snippet).toBe('Hb 13.5');
  });

  it('carries a position on the page only with the page images, and never an uncopied column, whatever the row held', () => {
    const m = { id: 'm', bbox_x0: 0.1, bbox_y0: 0.2, bbox_x1: 0.3, bbox_y1: 0.4, confidence: 0.9 };
    expect(sliceRow('measurements', m, { includeText: false, includeScans: false })).toMatchObject({ bbox_x0: null, bbox_y1: null });
    expect(sliceRow('measurements', m, { includeText: false, includeScans: true })).toMatchObject({ bbox_x0: 0.1, bbox_y1: 0.4 });
    expect(sliceRow('measurements', m, { includeText: true, includeScans: true })).not.toHaveProperty('confidence');
  });
});
