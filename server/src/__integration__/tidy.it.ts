import { beforeAll, expect, it } from 'vitest';
import { describeLive } from './support/live.js';
import { addResult } from './support/archive.js';
import { OWNER_ID, ask, proposalOf, startWorld, type World } from './support/world.js';
import { getStore } from 'spine-core/store/index.js';
import { seedDocument } from '../__tests__/helpers/seed.js';

/**
 * Tidying what was extracted several ways: the same doctor, test, tag or clinic written differently. The real model groups them and
 * proposes one final form; it must not join two doctors with different professional codes, and it proposes (Confirm merges).
 */
describeLive('asking the assistant to tidy duplicates', () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld();
    const store = getStore();
    const a = await seedDocument({ docDate: '2026-01-10', provider: 'Regina Maria', aiSummary: 'Cardiology visit', tags: ['cardiology'], docType: 'consultation_note' });
    const b = await seedDocument({ docDate: '2026-02-10', provider: 'REGINA MARIA SRL', aiSummary: 'Cardiology control', tags: ['cardio'], docType: 'consultation_note' });
    const c = await seedDocument({ docDate: '2026-03-10', provider: 'Spital Exemplu', aiSummary: 'Neurology visit', tags: ['neurology'], docType: 'consultation_note' });
    // One cardiologist written three ways (the third carries his code), a neurologist with the same surname and her own code.
    const p1 = await store.doctors.upsert(OWNER_ID, { name: 'Popescu I.', specialty: 'cardiology' }, '2026-01-10T00:00:00Z');
    const p2 = await store.doctors.upsert(OWNER_ID, { name: 'Popescu Ion', specialty: 'cardiology', clinic: 'Regina Maria', licenseCode: 'A12345' }, '2026-02-10T00:00:00Z');
    const q = await store.doctors.upsert(OWNER_ID, { name: 'Popescu Irina', specialty: 'neurology', licenseCode: 'N77777' }, '2026-03-10T00:00:00Z');
    await store.doctors.link(OWNER_ID, a.id, p1!, 'author'); await store.doctors.link(OWNER_ID, b.id, p2!, 'author'); await store.doctors.link(OWNER_ID, c.id, q!, 'author');
    await addResult(a.id, a.pageId!, { name: 'Hemoglobin', canonical: 'hemoglobin', value: '13.5', unit: 'g/dL', on: '2026-01-10' });
    await addResult(b.id, b.pageId!, { name: 'Hemoglobina', canonical: 'hemoglobina', value: '13.9', unit: 'g/dL', on: '2026-02-10' });
    await addResult(c.id, c.pageId!, { name: 'Glucose', canonical: 'glucose', value: '5.0', unit: 'mmol/L', on: '2026-03-10' });
  });

  it('groups the cardiologist’s entries into one final form and leaves the neurologist alone', async () => {
    const reply = await ask(w, 'Some of my doctors are in the directory more than once. Please tidy them.');
    const merge = proposalOf(reply, 'merge_doctors');
    const names = merge.groups.map(g => [g.keep, ...g.merge].map(d => d.name).sort());
    console.log('[tidy] doctor groups:', JSON.stringify(names), 'final:', JSON.stringify(merge.groups.map(g => g.final)));
    expect(names.some(n => n.includes('Popescu I.') && n.includes('Popescu Ion'))).toBe(true);
    // Two different professional codes are two people, whatever the surname.
    expect(names.every(n => !(n.includes('Popescu Irina') && (n.includes('Popescu Ion') || n.includes('Popescu I.'))))).toBe(true);
    const final = merge.groups.find(g => [g.keep, ...g.merge].some(d => d.name === 'Popescu Ion'))!.final;
    expect(final.name).toBe('Popescu Ion');
    expect(final.license_code).toBe('A12345');
    expect(final.specialty).toBe('cardiology');
    // Nothing merged before Confirm.
    expect((await getStore().doctors.listFor(OWNER_ID)).length).toBe(3);
  });

  it('proposes the test written two ways as one, with the units shown', async () => {
    const reply = await ask(w, 'My hemoglobin test is named in two ways. Merge those names.');
    const merge = proposalOf(reply, 'merge_tests');
    const group = merge.groups[0];
    expect([group.into.canonical, ...group.from.map(f => f.canonical)].sort()).toEqual(['hemoglobin', 'hemoglobina']);
    expect(group.into.units).toContain('g/dL');
  });

  it('proposes the clinic and the tag written two ways, as separate cards', async () => {
    const providers = proposalOf(await ask(w, 'Regina Maria appears with different spellings in my documents. Tidy my providers.'), 'merge_library');
    expect(providers.library).toBe('providers');
    expect(providers.groups[0].final_name.toLowerCase()).toContain('regina maria');
    const tags = proposalOf(await ask(w, 'I have a "cardio" tag and a "cardiology" tag. Merge them into "cardiology".'), 'merge_library');
    expect(tags.library).toBe('tags');
    expect(tags.groups[0].final_name).toBe('cardiology');
  });
});
