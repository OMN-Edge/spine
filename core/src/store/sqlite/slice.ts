import type { Database } from './driver.js';
import { sliceRow } from '../slice-policy.js';
import type { SliceOptions, SliceResult } from '../types.js';

export type { SliceOptions, SliceResult };

/**
 * What a share contains (docs/crypto-design.md, stage 4): a copy, in a database of its own, of the documents a link shares and what
 * the recipient may read of them, made on the owner's device and sealed there. **Everything in it is readable by the recipient**: the
 * browser that opens it holds the whole file, not only what a route would send, so this is the one place that decides what leaves.
 *
 * It is an allow-list, and the list is `../slice-policy.ts`, which does not depend on the engine: this file chooses the rows (which
 * documents, which pages) and has SQLite read and write them; the columns that leave are the policy's. Page images are copied only if the
 * owner allowed scans (`includeScans`), and then as the files named in the result, not here.
 */
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export function copySlice(source: Database, dest: Database, o: SliceOptions): SliceResult {
  const docs = [...new Set(o.documentIds)];
  const inDocs = marks(docs.length);
  const rows = (sql: string, ...params: unknown[]) => source.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    dest.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${marks(cols.length)})`).run(...cols.map(c => row[c]));
  };
  const cut = (table: Parameters<typeof sliceRow>[0], row: Record<string, unknown>, extra: Record<string, unknown> = {}) => sliceRow(table, row, { includeText: o.includeText }, extra);

  const images: SliceResult['images'] = [];
  const copy = dest.transaction(() => {
    insert('users', { id: o.userId, email: 'shared@invalid.example', password_hash: 'x', created_at: o.link.createdAt, email_verified_at: o.link.createdAt });
    if (docs.length === 0) return;

    const documents = rows(`SELECT * FROM documents WHERE user_id = ? AND id IN (${inDocs})`, o.userId, ...docs);
    const uploads = [...new Set(documents.map(d => d.source_file_id as string))];
    for (const u of rows(`SELECT * FROM source_files WHERE user_id = ? AND id IN (${marks(uploads.length)})`, o.userId, ...uploads)) {
      insert('source_files', cut('source_files', u));
    }

    // Only the pages a document covers, and only those the owner has not set aside.
    const pageIds = new Set<string>();
    for (const d of documents) {
      for (const p of rows('SELECT * FROM pages WHERE user_id = ? AND source_file_id = ? AND page_number BETWEEN ? AND ? AND hidden = 0', o.userId, d.source_file_id, d.page_start, d.page_end)) {
        if (pageIds.has(p.id as string)) continue;
        pageIds.add(p.id as string);
        const to = o.includeScans ? o.imagePathOf(p.id as string) : '';
        if (o.includeScans) images.push({ pageId: p.id as string, from: p.image_path as string, to });
        insert('pages', cut('pages', p, { image_path: to }));
      }
    }

    for (const d of documents) {
      insert('documents', cut('documents', d));
    }

    const onPage = (r: Record<string, unknown>) => pageIds.has(r.page_id as string);
    for (const f of rows(`SELECT * FROM extracted_fields WHERE user_id = ? AND document_id IN (${inDocs})`, o.userId, ...docs).filter(onPage)) {
      insert('extracted_fields', cut('extracted_fields', f));
    }
    for (const m of rows(`SELECT * FROM measurements WHERE user_id = ? AND document_id IN (${inDocs})`, o.userId, ...docs).filter(onPage)) {
      insert('measurements', cut('measurements', m));
    }

    const links = rows(`SELECT * FROM document_doctors WHERE user_id = ? AND document_id IN (${inDocs})`, o.userId, ...docs);
    const doctorIds = [...new Set(links.map(l => l.doctor_id as string))];
    if (doctorIds.length > 0) {
      for (const d of rows(`SELECT * FROM doctors WHERE user_id = ? AND id IN (${marks(doctorIds.length)})`, o.userId, ...doctorIds)) {
        insert('doctors', cut('doctors', d));
      }
    }
    for (const l of links) insert('document_doctors', cut('document_doctors', l));

    const tagLinks = rows(`SELECT * FROM document_tags WHERE user_id = ? AND document_id IN (${inDocs})`, o.userId, ...docs);
    const tagIds = [...new Set(tagLinks.map(l => l.tag_id as number))];
    if (tagIds.length > 0) {
      for (const t of rows(`SELECT * FROM tags WHERE user_id = ? AND id IN (${marks(tagIds.length)})`, o.userId, ...tagIds)) insert('tags', cut('tags', t));
    }
    for (const l of tagLinks) insert('document_tags', cut('document_tags', l));

    // Only the confirmed links between two documents both shared.
    for (const l of rows(`SELECT * FROM document_links WHERE user_id = ? AND state = 'confirmed' AND from_document_id IN (${inDocs}) AND to_document_id IN (${inDocs})`, o.userId, ...docs, ...docs)) {
      insert('document_links', cut('document_links', l));
    }

    for (const e of rows(`SELECT * FROM document_embeddings WHERE user_id = ? AND document_id IN (${inDocs})`, o.userId, ...docs)) {
      insert('document_embeddings', cut('document_embeddings', e));
    }
  });
  copy();

  // The link as the recipient's core knows it: the documents named one by one, no approval (the key is the approval), chat as the owner set it.
  insert('share_links', {
    id: o.link.id, user_id: o.userId, label: o.link.label, scope: 'document_ids', scope_value: JSON.stringify(docs),
    created_at: o.link.createdAt, expires_at: o.link.expiresAt, include_scans: o.includeScans ? 1 : 0, language: o.link.language,
    require_approval: 0, allow_chat: o.link.allowChat ? 1 : 0,
  });
  return { images };
}
