import { getStore } from '../store/index.js';
import type { Store } from '../store/index.js';
import { pairKey } from '../matching/index.js';
import type { Manifest } from './manifest.js';

/**
 * What the owner keeps beside the documents: the doctors' directory (those no document names too, and two people of one
 * name as two), every tag, the tests merged under another name, and the answers to "are these the same?". Ids are made again on
 * import, so each is carried by something that survives: a doctor by position in `people`, a tag by its name.
 */
export interface Directory {
  people: Manifest['people'];
  tags: string[];
  test_aliases: Manifest['test_aliases'];
  decisions: Manifest['decisions'];
  /** Where each doctor of the directory is in `people`. */
  personOf: Map<string, number>;
}

const DECISION_KINDS = ['doctor', 'code', 'tag', 'test', 'provider'] as const;

export async function exportDirectory(store: Store, userId: string): Promise<Directory> {
  const directory = await store.doctors.listFor(userId);
  const personOf = new Map(directory.map((d, i) => [d.id, i]));
  const tagList = await store.tags.listFor(userId);
  const tagName = new Map(tagList.map(t => [String(t.id), t.name]));

  const decisions: Manifest['decisions'] = [];
  for (const kind of DECISION_KINDS) {
    for (const key of await store.matchDecisions.list(userId, kind)) {
      const cut = key.indexOf('|');
      if (cut < 0) continue;
      const a = key.slice(0, cut); const b = key.slice(cut + 1);
      if (kind === 'doctor') {
        const x = personOf.get(a); const y = personOf.get(b);
        if (x !== undefined && y !== undefined) decisions.push({ kind, a: String(x), b: String(y) });
      } else if (kind === 'code') {
        const x = personOf.get(a);
        if (x !== undefined) decisions.push({ kind, a: String(x), b });
      } else if (kind === 'tag') {
        const x = tagName.get(a); const y = tagName.get(b);
        if (x !== undefined && y !== undefined) decisions.push({ kind, a: x, b: y });
      } else if (!b.includes('|')) {
        decisions.push({ kind, a, b });
      }
    }
  }

  return {
    people: directory.map(d => ({ name: d.name, specialty: d.specialty, clinic: d.clinic, license_code: d.license_code })),
    tags: tagList.map(t => t.name),
    test_aliases: await store.measurements.aliases(userId),
    decisions,
    personOf,
  };
}

/**
 * Puts the directory back before the files are restored, and says which doctor of this archive each person of the export is. A
 * person already held (the same code, or the same name where nothing says they differ) is that doctor; a second of one name
 * in the export that matched the same one is another person.
 */
export async function restoreDirectory(userId: string, manifest: Manifest): Promise<Array<string | null>> {
  const store = getStore();
  const now = new Date().toISOString();
  const ids: Array<string | null> = [];
  await store.transaction(async tx => {
    const taken = new Set<string>();
    for (const p of manifest.people) {
      const entry = { name: p.name, specialty: p.specialty, clinic: p.clinic, licenseCode: p.license_code, exactCode: true };
      let id = await tx.doctors.upsert(userId, entry, now);
      if (id && taken.has(id)) id = await tx.doctors.upsert(userId, { ...entry, newPerson: true }, now);
      if (id) taken.add(id);
      ids.push(id);
    }
    await tx.tags.ensure(userId, manifest.tags);
    for (const a of manifest.test_aliases) {
      const canonical = await tx.measurements.resolveCanonical(userId, a.canonical.trim().toLowerCase());
      if (a.alias.trim() && a.alias !== canonical) await tx.measurements.addAlias(userId, a.alias.trim().toLowerCase(), canonical);
    }
    const tagIds = new Map((await tx.tags.listFor(userId)).map(t => [t.name, String(t.id)]));
    for (const d of manifest.decisions) {
      let key: string | null = null;
      if (d.kind === 'doctor') {
        const x = ids[Number(d.a)]; const y = ids[Number(d.b)];
        if (x && y) key = pairKey(x, y);
      } else if (d.kind === 'code') {
        const x = ids[Number(d.a)];
        if (x) key = `${x}|${d.b}`;
      } else if (d.kind === 'tag') {
        const x = tagIds.get(d.a); const y = tagIds.get(d.b);
        if (x && y) key = pairKey(x, y);
      } else {
        key = pairKey(d.a, d.b);
      }
      if (key) await tx.matchDecisions.add(userId, d.kind, key, now);
    }
  });
  return ids;
}
