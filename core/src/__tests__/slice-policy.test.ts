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
      const spec = SLICE[name] as { copy: string[]; set?: Record<string, unknown>; text?: Record<string, unknown>; left: string[] };
      const said = [...spec.copy, ...Object.keys(spec.set ?? {}), ...Object.keys(spec.text ?? {}), ...spec.left];
      expect(new Set(said).size, `${name}: a column is named twice`).toBe(said.length);
      expect(said.sort(), name).toEqual(columnsOf(name).sort());
    }
  });

  it('keeps the owner’s file names, paths, checksums, word boxes and professional codes out', () => {
    const left = (t: SliceName) => (SLICE[t] as { left: string[] }).left;
    expect(left('source_files')).toEqual(expect.arrayContaining(['checksum']));
    expect(SLICE.source_files.copy).not.toContain('original_filename');
    expect(SLICE.source_files.copy).not.toContain('file_path');
    expect(left('doctors')).toContain('license_code');
    expect(left('document_doctors')).toContain('printed_code');
    expect(left('document_links')).toEqual(expect.arrayContaining(['reason']));
    for (const t of ['extracted_fields', 'measurements'] as const) expect(left(t)).toContain('bbox_x0');
  });
});

describe('a row as it leaves', () => {
  const row = { id: 'p1', user_id: 'u', source_file_id: 's', page_number: 2, image_width: 10, image_height: 20, rotation: 0, source_page: 1, extraction_source: 'native_text', raw_text: 'Jane Example, Hb 13.5', elements: '[{"x":1}]', hidden: 1, image_path: '/home/owner/p.png', reviewed: 1 };

  it('keeps the page text only when the recipient may ask questions, and never the boxes or the owner’s path', () => {
    const closed = sliceRow('pages', row, { includeText: false });
    const open = sliceRow('pages', row, { includeText: true });
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
    expect(sliceRow('pages', row, { includeText: false }, { image_path: '/share/pages/0.png' }).image_path).toBe('/share/pages/0.png');
    expect(sliceRow('measurements', { id: 'm', source_snippet: 'Hb 13.5', bbox_x0: 1 }, { includeText: false }).source_snippet).toBeNull();
    expect(sliceRow('measurements', { id: 'm', source_snippet: 'Hb 13.5', bbox_x0: 1 }, { includeText: true }).source_snippet).toBe('Hb 13.5');
  });

  it('never carries an uncopied column, whatever the row held', () => {
    const out = sliceRow('doctors', { id: 'd', user_id: 'u', name: 'Dr. Example', key: 'k', specialty: 's', clinic: 'c', license_code: 'X12345', created_at: 't' }, { includeText: true });
    expect(out).not.toHaveProperty('license_code');
    expect(Object.keys(out).sort()).toEqual([...SLICE.doctors.copy].sort());
  });
});
