import type { Database } from './driver.js';

/**
 * What a share contains (docs/crypto-design.md, stage 4): a copy, in a database of its own, of the documents a link shares and what
 * the recipient may read of them, made on the owner's device and sealed there. **Everything in it is readable by the recipient**: the
 * browser that opens it holds the whole file, not only what a route would send, so this is the one place that decides what leaves.
 *
 * It is an allow-list. Each table lists the columns that are copied; every other column is left at its default (empty), which is how
 * the owner's e-mail, the file names and paths of the uploads, word boxes, the doctors' professional codes, the reasons the app gave for
 * a link between documents and everything else stay out. Page text, snippets and the questions' source are copied only if the recipient
 * may ask questions (`includeText`), page images only if the owner allowed scans (`includeScans`), and then as the files named in
 * the result, not here. A new table or column is out of a share until it is named below.
 */
export interface SliceOptions {
  userId: string;
  /** What `documents.listForShare` gave for the link on the owner's device: the documents the link shares. */
  documentIds: string[];
  includeText: boolean;
  includeScans: boolean;
  link: { id: string; label: string | null; createdAt: string; expiresAt: string; language: string | null; allowChat: boolean };
  /** sha256 of the fixed address the recipient's core answers to (`LOCAL_SHARE_TOKEN`). */
  tokenHash: string;
  /** Where a page's image is in the share's own file system (when scans are included). */
  imagePathOf: (pageId: string) => string;
}

export interface SliceResult {
  images: Array<{ pageId: string; from: string; to: string }>;
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export function copySlice(source: Database, dest: Database, o: SliceOptions): SliceResult {
  const docs = [...new Set(o.documentIds)];
  const inDocs = marks(docs.length);
  const rows = (sql: string, ...params: unknown[]) => source.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    dest.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${marks(cols.length)})`).run(...cols.map(c => row[c]));
  };
  const pick = (row: Record<string, unknown>, cols: string[], extra: Record<string, unknown> = {}) => ({ ...Object.fromEntries(cols.map(c => [c, row[c]])), ...extra });

  const images: SliceResult['images'] = [];
  const copy = dest.transaction(() => {
    insert('users', { id: o.userId, email: 'shared@invalid.example', password_hash: 'x', created_at: o.link.createdAt, email_verified_at: o.link.createdAt });
    if (docs.length === 0) return;

    const documents = rows(`SELECT * FROM documents WHERE user_id = ? AND id IN (${inDocs})`, o.userId, ...docs);
    const uploads = [...new Set(documents.map(d => d.source_file_id as string))];
    for (const u of rows(`SELECT * FROM source_files WHERE user_id = ? AND id IN (${marks(uploads.length)})`, o.userId, ...uploads)) {
      // No file name, no path, no checksum: the recipient is shown a document, not an upload.
      insert('source_files', pick(u, ['id', 'user_id', 'uploaded_at', 'mime_type', 'page_count'], { original_filename: 'shared', file_path: '', status: 'done', grouping_confirmed: 1 }));
    }

    // Only the pages a document covers, and only those the owner has not set aside.
    const pageIds = new Set<string>();
    for (const d of documents) {
      for (const p of rows('SELECT * FROM pages WHERE user_id = ? AND source_file_id = ? AND page_number BETWEEN ? AND ? AND hidden = 0', o.userId, d.source_file_id, d.page_start, d.page_end)) {
        if (pageIds.has(p.id as string)) continue;
        pageIds.add(p.id as string);
        const to = o.includeScans ? o.imagePathOf(p.id as string) : '';
        if (o.includeScans) images.push({ pageId: p.id as string, from: p.image_path as string, to });
        insert('pages', pick(p, ['id', 'user_id', 'source_file_id', 'page_number', 'image_width', 'image_height', 'rotation', 'source_page', 'extraction_source'], {
          image_path: to, raw_text: o.includeText ? p.raw_text : '', elements: '[]', hidden: 0,
        }));
      }
    }

    for (const d of documents) {
      insert('documents', pick(d, ['id', 'user_id', 'source_file_id', 'page_start', 'page_end', 'title', 'doc_date', 'provider', 'doc_type', 'ai_summary', 'user_notes', 'reviewed', 'language', 'owner_edited'], { needs_reading: 0 }));
    }

    const onPage = (r: Record<string, unknown>) => pageIds.has(r.page_id as string);
    for (const f of rows(`SELECT * FROM extracted_fields WHERE user_id = ? AND document_id IN (${inDocs})`, o.userId, ...docs).filter(onPage)) {
      insert('extracted_fields', pick(f, ['id', 'user_id', 'document_id', 'page_id', 'label', 'value', 'group_no', 'owner_edited'], { source_snippet: o.includeText ? f.source_snippet : null }));
    }
    for (const m of rows(`SELECT * FROM measurements WHERE user_id = ? AND document_id IN (${inDocs})`, o.userId, ...docs).filter(onPage)) {
      insert('measurements', pick(m, ['id', 'user_id', 'document_id', 'page_id', 'name', 'canonical', 'value_text', 'value_num', 'unit', 'ref_low', 'ref_high', 'flag', 'taken_on', 'owner_edited'], { source_snippet: o.includeText ? m.source_snippet : null }));
    }

    const links = rows(`SELECT * FROM document_doctors WHERE user_id = ? AND document_id IN (${inDocs})`, o.userId, ...docs);
    const doctorIds = [...new Set(links.map(l => l.doctor_id as string))];
    if (doctorIds.length > 0) {
      for (const d of rows(`SELECT * FROM doctors WHERE user_id = ? AND id IN (${marks(doctorIds.length)})`, o.userId, ...doctorIds)) {
        insert('doctors', pick(d, ['id', 'user_id', 'name', 'key', 'specialty', 'clinic', 'created_at']));
      }
    }
    for (const l of links) insert('document_doctors', pick(l, ['user_id', 'document_id', 'doctor_id', 'role', 'source']));

    const tagLinks = rows(`SELECT * FROM document_tags WHERE user_id = ? AND document_id IN (${inDocs})`, o.userId, ...docs);
    const tagIds = [...new Set(tagLinks.map(l => l.tag_id as number))];
    if (tagIds.length > 0) {
      for (const t of rows(`SELECT * FROM tags WHERE user_id = ? AND id IN (${marks(tagIds.length)})`, o.userId, ...tagIds)) insert('tags', pick(t, ['id', 'user_id', 'name']));
    }
    for (const l of tagLinks) insert('document_tags', pick(l, ['user_id', 'document_id', 'tag_id']));

    // A link between two documents both shared, as the owner confirmed it. Neither the reason the app gave nor how sure it was.
    for (const l of rows(`SELECT * FROM document_links WHERE user_id = ? AND state = 'confirmed' AND from_document_id IN (${inDocs}) AND to_document_id IN (${inDocs})`, o.userId, ...docs, ...docs)) {
      insert('document_links', pick(l, ['user_id', 'from_document_id', 'to_document_id', 'kind', 'source', 'state', 'created_at']));
    }

    // Closeness in meaning among the shared documents only: numbers, never text.
    for (const e of rows(`SELECT * FROM document_embeddings WHERE user_id = ? AND document_id IN (${inDocs})`, o.userId, ...docs)) {
      insert('document_embeddings', pick(e, ['user_id', 'document_id', 'model', 'dims', 'text_hash', 'vector', 'created_at']));
    }
  });
  copy();

  // The link as the recipient's core knows it: the documents named one by one, no approval (the key is the approval), chat as the owner set it.
  insert('share_links', {
    id: o.link.id, user_id: o.userId, token: o.tokenHash, label: o.link.label, scope: 'document_ids', scope_value: JSON.stringify(docs),
    created_at: o.link.createdAt, expires_at: o.link.expiresAt, include_scans: o.includeScans ? 1 : 0, language: o.link.language,
    require_approval: 0, allow_chat: o.link.allowChat ? 1 : 0,
  });
  return { images };
}
