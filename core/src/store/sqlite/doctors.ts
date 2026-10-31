import type { Database } from './driver.js';
import { v4 as uuidv4 } from 'uuid';
import type { Doctor, DoctorRole } from '../../types.js';
import type { DoctorDocument, DoctorOnDocument, DoctorRepository, DoctorWithCounts } from '../types.js';
import { doctorDisplayName, doctorKey, MAX_DOCTOR_TEXT, normaliseLicenseCode } from '../../doctors.js';
import { owner } from '../owner.js';
import { VISIBLE } from './visibility.js';

/** Every statement filters by `user_id` (SECURITY.md P12). */
export function doctorRepository(db: Database): DoctorRepository {
  const COLUMNS = 'id, name, specialty, clinic, license_code, created_at'; // not `key` or `user_id`: S-8

  // `key` is an identity, not the name: the first "Ion Popescu" is `ion popescu`, a second person of that name `ion popescu#2`.
  // The unique index stays, and a name is looked for as its key and every numbered one.
  const findByName = db.prepare("SELECT id, license_code FROM doctors WHERE user_id = ? AND (key = ? OR key LIKE ? || '#%') ORDER BY created_at, rowid");
  const keyHeld = db.prepare('SELECT 1 FROM doctors WHERE user_id = ? AND key = ? AND id <> ?');
  const keyFor = (uid: string, base: string, exceptId: string): string => {
    for (let n = 1; ; n++) {
      const key = n === 1 ? base : `${base}#${n}`;
      if (!keyHeld.get(uid, key, exceptId)) return key;
    }
  };
  const findByCode = db.prepare('SELECT id FROM doctors WHERE user_id = ? AND license_code = ?');
  const insert = db.prepare('INSERT INTO doctors (id, user_id, name, key, specialty, clinic, license_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const fill = db.prepare('UPDATE doctors SET specialty = COALESCE(specialty, ?), clinic = COALESCE(clinic, ?) WHERE id = ? AND user_id = ?');
  const fillCode = db.prepare('UPDATE doctors SET license_code = ? WHERE id = ? AND user_id = ? AND license_code IS NULL');
  const find = db.prepare(`SELECT ${COLUMNS} FROM doctors WHERE id = ? AND user_id = ?`);

  // Only if the document and the doctor are both the user's.
  const link = db.prepare(`
    INSERT INTO document_doctors (user_id, document_id, doctor_id, role, source, printed_code)
    SELECT ?, d.id, k.id, ?, ?, ? FROM documents d, doctors k
    WHERE d.id = ? AND d.user_id = ? AND k.id = ? AND k.user_id = ?
    ON CONFLICT (document_id, doctor_id, role) DO UPDATE SET
      source = CASE WHEN excluded.source <> 'text' THEN excluded.source ELSE source END,
      printed_code = COALESCE(excluded.printed_code, printed_code)
  `);
  // Documents that printed a code for a doctor other than the one the directory holds for them.
  const clashes = db.prepare(`
    SELECT k.id AS doctor_id, k.name, k.license_code AS directory_code, l.printed_code, l.document_id
    FROM document_doctors l JOIN doctors k ON k.id = l.doctor_id AND k.user_id = l.user_id
    WHERE l.user_id = ? AND l.printed_code IS NOT NULL AND k.license_code IS NOT NULL AND l.printed_code <> k.license_code
  `);
  const unlinkAll = db.prepare('DELETE FROM document_doctors WHERE document_id = ? AND user_id = ?');
  const linkInfo = db.prepare('SELECT doctor_id, role, source, printed_code FROM document_doctors WHERE document_id = ? AND user_id = ? ORDER BY rowid');
  const unlinkRead = db.prepare("DELETE FROM document_doctors WHERE document_id = ? AND user_id = ? AND source = 'text'");
  const forDocument = db.prepare(`
    SELECT k.id, k.name, k.specialty, k.clinic, k.license_code, k.created_at, l.role, l.source = 'verified_signature' AS signature_verified
    FROM document_doctors l JOIN doctors k ON k.id = l.doctor_id AND k.user_id = l.user_id
    WHERE l.document_id = ? AND l.user_id = ? ORDER BY l.rowid
  `);
  const moveLinks = db.prepare(`
    INSERT OR IGNORE INTO document_doctors (user_id, document_id, doctor_id, role, source)
    SELECT user_id, ?, doctor_id, role, source FROM document_doctors
    WHERE document_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM documents WHERE id = ? AND user_id = ?)
  `);
  const list = db.prepare(`
    SELECT k.id, k.name, k.specialty, k.clinic, k.license_code, k.created_at,
           COUNT(DISTINCT d.id) AS document_count, MAX(d.doc_date) AS last_seen
    FROM doctors k
    LEFT JOIN document_doctors l ON l.doctor_id = k.id AND l.user_id = k.user_id
    LEFT JOIN documents d ON d.id = l.document_id AND d.user_id = k.user_id AND ${VISIBLE}
    WHERE k.user_id = ? GROUP BY k.id ORDER BY k.name COLLATE NOCASE
  `);
  const documentsFor = db.prepare(`
    SELECT d.id, d.title, d.doc_type, d.doc_date, d.provider, l.role
    FROM document_doctors l JOIN documents d ON d.id = l.document_id AND d.user_id = l.user_id
    WHERE l.doctor_id = ? AND l.user_id = ? AND ${VISIBLE} ORDER BY d.doc_date DESC NULLS LAST, d.rowid DESC
  `);
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
      const specialty = doctor.specialty?.trim().slice(0, MAX_DOCTOR_TEXT) || null;
      const clinic = doctor.clinic?.trim().slice(0, MAX_DOCTOR_TEXT) || null;
      const code = normaliseLicenseCode(doctor.licenseCode);

      // This very entry, chosen by the owner: nothing is looked up by name.
      if (doctor.id) {
        if (!find.get(doctor.id, uid)) return null;
        fill.run(specialty, clinic, doctor.id, uid);
        if (code) fillCode.run(code, doctor.id, uid);
        return doctor.id;
      }

      const name = doctorDisplayName(doctor.name).slice(0, MAX_DOCTOR_TEXT).trim();
      const base = doctorKey(name);
      if (!name || !base) return null;

      // The code first: it names a person, where a name is only how this document spelled it.
      const byCode = code ? (findByCode.get(uid, code) as { id: string } | undefined) : undefined;
      if (byCode) {
        fill.run(specialty, clinic, byCode.id, uid);
        return byCode.id;
      }
      if (!doctor.newPerson) {
        const named = findByName.all(uid, base, base) as Array<{ id: string; license_code: string | null }>;
        // Of several people with one name, one who has no code yet is the likeliest, then the oldest. A code that differs from the
        // only one held is left to the report's question, unless the caller knows the codes are exact (a restore).
        const open = named.find(n => !n.license_code) ?? (doctor.exactCode && code ? undefined : named[0]);
        if (open) {
          fill.run(specialty, clinic, open.id, uid);
          if (code) fillCode.run(code, open.id, uid);
          return open.id;
        }
      }
      const id = uuidv4();
      insert.run(id, uid, name, keyFor(uid, base, id), specialty, clinic, code, now);
      return id;
    },

    async link(userId, documentId, doctorId, role, source = 'text', printedCode = null) {
      const uid = owner(userId);
      // A repeat changes nothing (except a stamp taking over from text), so "did it link" is "do the rows exist".
      link.run(uid, role, source, printedCode, documentId, uid, doctorId, uid);
      return forDocument.all(documentId, uid).some(d => (d as { id: string }).id === doctorId);
    },

    async codeClashes(userId, documentIds) {
      const wanted = new Set(documentIds);
      const found = (clashes.all(owner(userId)) as Array<{ doctor_id: string; name: string; directory_code: string; printed_code: string; document_id: string }>).filter(r => wanted.has(r.document_id));
      const byPair = new Map<string, { doctor_id: string; name: string; directory_code: string; printed_code: string; document_ids: string[] }>();
      for (const r of found) {
        const key = `${r.doctor_id}|${r.printed_code}`;
        const held = byPair.get(key);
        if (held) held.document_ids.push(r.document_id); else byPair.set(key, { doctor_id: r.doctor_id, name: r.name, directory_code: r.directory_code, printed_code: r.printed_code, document_ids: [r.document_id] });
      }
      return [...byPair.values()];
    },

    async linkInfo(userId, documentId) {
      return linkInfo.all(documentId, owner(userId)) as Array<{ doctor_id: string; role: DoctorRole; source: 'text' | 'stamp' | 'signature' | 'verified_signature'; printed_code: string | null }>;
    },

    async unlinkAll(userId, documentId) {
      unlinkAll.run(documentId, owner(userId));
    },

    async unlinkRead(userId, documentId) {
      unlinkRead.run(documentId, owner(userId));
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
        const base = doctorKey(name);
        if (!name || !base) return 'not_found';
        rename.run(name, keyFor(uid, base, id), id, uid);
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
