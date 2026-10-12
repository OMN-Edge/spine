import type { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Doctor } from '../../types.js';
import type { DoctorDocument, DoctorOnDocument, DoctorRepository, DoctorWithCounts } from '../types.js';
import { doctorDisplayName, doctorKey, normaliseLicenseCode } from '../../doctors.js';
import { owner } from './owner.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function doctorRepository(db: Database): DoctorRepository {
  const COLUMNS = 'id, name, specialty, clinic, license_code, created_at'; // not `key` or `user_id`: S-8

  const findByKey = db.prepare('SELECT id FROM doctors WHERE user_id = ? AND key = ?');
  const findByCode = db.prepare('SELECT id FROM doctors WHERE user_id = ? AND license_code = ?');
  const insert = db.prepare('INSERT INTO doctors (id, user_id, name, key, specialty, clinic, license_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const fill = db.prepare('UPDATE doctors SET specialty = COALESCE(specialty, ?), clinic = COALESCE(clinic, ?) WHERE id = ? AND user_id = ?');
  const fillCode = db.prepare('UPDATE doctors SET license_code = ? WHERE id = ? AND user_id = ? AND license_code IS NULL');
  const find = db.prepare(`SELECT ${COLUMNS} FROM doctors WHERE id = ? AND user_id = ?`);

  // Only if the document and the doctor are both the user's.
  const link = db.prepare(`
    INSERT OR IGNORE INTO document_doctors (user_id, document_id, doctor_id, role)
    SELECT ?, d.id, k.id, ? FROM documents d, doctors k
    WHERE d.id = ? AND d.user_id = ? AND k.id = ? AND k.user_id = ?
  `);
  const unlinkAll = db.prepare('DELETE FROM document_doctors WHERE document_id = ? AND user_id = ?');
  const forDocument = db.prepare(`
    SELECT k.id, k.name, k.specialty, k.clinic, k.license_code, k.created_at, l.role
    FROM document_doctors l JOIN doctors k ON k.id = l.doctor_id AND k.user_id = l.user_id
    WHERE l.document_id = ? AND l.user_id = ? ORDER BY l.rowid
  `);
  const moveLinks = db.prepare(`
    INSERT OR IGNORE INTO document_doctors (user_id, document_id, doctor_id, role)
    SELECT user_id, ?, doctor_id, role FROM document_doctors
    WHERE document_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND user_id = ?)
  `);
  const list = db.prepare(`
    SELECT k.id, k.name, k.specialty, k.clinic, k.license_code, k.created_at,
           COUNT(DISTINCT l.document_id) AS document_count, MAX(d.doc_date) AS last_seen
    FROM doctors k
    LEFT JOIN document_doctors l ON l.doctor_id = k.id AND l.user_id = k.user_id
    LEFT JOIN documents d ON d.id = l.document_id AND d.user_id = k.user_id
    WHERE k.user_id = ? GROUP BY k.id ORDER BY k.name COLLATE NOCASE
  `);
  const documentsFor = db.prepare(`
    SELECT d.id, d.title, d.doc_type, d.doc_date, d.provider, l.role
    FROM document_doctors l JOIN documents d ON d.id = l.document_id AND d.user_id = l.user_id
    WHERE l.doctor_id = ? AND l.user_id = ? ORDER BY d.doc_date DESC NULLS LAST, d.rowid DESC
  `);
  const keyTaken = db.prepare('SELECT id FROM doctors WHERE user_id = ? AND key = ? AND id <> ?');
  const rename = db.prepare('UPDATE doctors SET name = ?, key = ? WHERE id = ? AND user_id = ?');
  const setDetails = db.prepare('UPDATE doctors SET specialty = ?, clinic = ?, license_code = ? WHERE id = ? AND user_id = ?');
  const codeTaken = db.prepare('SELECT id FROM doctors WHERE user_id = ? AND license_code = ? AND id <> ?');
  const codeOf = db.prepare('SELECT license_code FROM doctors WHERE id = ? AND user_id = ?');
  const clearCode = db.prepare('UPDATE doctors SET license_code = NULL WHERE id = ? AND user_id = ?');
  const repoint = db.prepare('UPDATE OR IGNORE document_doctors SET doctor_id = ? WHERE doctor_id = ? AND user_id = ?');
  const dropLinks = db.prepare('DELETE FROM document_doctors WHERE doctor_id = ? AND user_id = ?');
  const removeDoctor = db.prepare('DELETE FROM doctors WHERE id = ? AND user_id = ?');
  const linked = db.prepare('SELECT 1 FROM document_doctors WHERE doctor_id = ? AND user_id = ? LIMIT 1');

  const mergeTx = db.transaction((uid: string, fromId: string, intoId: string) => {
    repoint.run(intoId, fromId, uid);
    dropLinks.run(fromId, uid); // what could not move would have duplicated an existing link
    // The code is unique, so it leaves with the entry that is going; the one that stays takes it if it has none.
    const code = (codeOf.get(fromId, uid) as { license_code: string | null } | undefined)?.license_code ?? null;
    clearCode.run(fromId, uid);
    removeDoctor.run(fromId, uid);
    if (code) fillCode.run(code, intoId, uid);
  });

  return {
    async upsert(userId, doctor, now) {
      const uid = owner(userId);
      const name = doctorDisplayName(doctor.name);
      const key = doctorKey(name);
      if (!name || !key) return null;

      const code = normaliseLicenseCode(doctor.licenseCode);
      // The code first: it names a person, where a name is only how this document spelled it.
      const byCode = code ? (findByCode.get(uid, code) as { id: string } | undefined) : undefined;
      const existing = byCode ?? (findByKey.get(uid, key) as { id: string } | undefined);
      if (existing) {
        fill.run(doctor.specialty?.trim() || null, doctor.clinic?.trim() || null, existing.id, uid);
        // Only a doctor with no code yet takes one: a name match whose code differs is left as it is.
        if (code) fillCode.run(code, existing.id, uid);
        return existing.id;
      }
      const id = uuidv4();
      insert.run(id, uid, name, key, doctor.specialty?.trim() || null, doctor.clinic?.trim() || null, code, now);
      return id;
    },

    async link(userId, documentId, doctorId, role) {
      const uid = owner(userId);
      // OR IGNORE makes a repeat a no-op, so "did it link" is "do the rows exist": check by the join.
      link.run(uid, role, documentId, uid, doctorId, uid);
      return forDocument.all(documentId, uid).some(d => (d as { id: string }).id === doctorId);
    },

    async unlinkAll(userId, documentId) {
      unlinkAll.run(documentId, owner(userId));
    },

    async forDocument(userId, documentId) {
      return forDocument.all(documentId, owner(userId)) as DoctorOnDocument[];
    },

    async moveLinks(userId, fromDocumentId, toDocumentId) {
      const uid = owner(userId);
      moveLinks.run(toDocumentId, fromDocumentId, uid, toDocumentId, uid);
      unlinkAll.run(fromDocumentId, uid);
    },

    async copyLinks(userId, fromDocumentId, toDocumentId) {
      const uid = owner(userId);
      moveLinks.run(toDocumentId, fromDocumentId, uid, toDocumentId, uid);
    },

    async listFor(userId) {
      return list.all(owner(userId)) as DoctorWithCounts[];
    },

    async find(userId, id) {
      return (find.get(id, owner(userId)) as Doctor | undefined) ?? null;
    },

    async documentsFor(userId, doctorId) {
      return documentsFor.all(doctorId, owner(userId)) as DoctorDocument[];
    },

    async update(userId, id, change) {
      const uid = owner(userId);
      const current = find.get(id, uid) as Doctor | undefined;
      if (!current) return 'not_found';

      if (change.name !== undefined) {
        const name = doctorDisplayName(change.name);
        const key = doctorKey(name);
        if (!name || !key) return 'name_taken';
        if (keyTaken.get(uid, key, id)) return 'name_taken';
        rename.run(name, key, id, uid);
      }
      if (change.specialty !== undefined || change.clinic !== undefined || change.licenseCode !== undefined) {
        const code = change.licenseCode === undefined ? current.license_code : normaliseLicenseCode(change.licenseCode);
        if (code && codeTaken.get(uid, code, id)) return 'code_taken';
        setDetails.run(
          change.specialty === undefined ? current.specialty : change.specialty?.trim() || null,
          change.clinic === undefined ? current.clinic : change.clinic?.trim() || null,
          code, id, uid,
        );
      }
      return 'ok';
    },

    async merge(userId, fromId, intoId) {
      const uid = owner(userId);
      if (fromId === intoId || !find.get(fromId, uid) || !find.get(intoId, uid)) return false;
      mergeTx(uid, fromId, intoId);
      return true;
    },

    async remove(userId, id) {
      const uid = owner(userId);
      if (linked.get(id, uid)) return false;
      return removeDoctor.run(id, uid).changes === 1;
    },
  };
}
