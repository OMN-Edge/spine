import { describe, expect, it } from 'vitest';
import { BLOOD_TYPES, prescriptionLines, proposalsFrom } from './emergency-fill';

/** What the emergency card could start from in the records (T-20): offered, from the last twelve months, once each, and never silently. */
const NOW = new Date('2026-11-17T10:00:00Z');
const field = (label: string, value: string, group_no: number) => ({ label, value, group_no });
const levo = { doc_date: '2026-09-03', fields: [field('drug', 'Levothyroxine', 0), field('dose', '50 µg', 0), field('frequency', 'once a day', 0), field('drug', 'Vitamin D', 1), field('dose', '2000 IU', 1)] };

describe('the lines of a prescription', () => {
  it('are a drug with its dose and frequency as written, one to a group, and nothing for a group with no drug', () => {
    expect(prescriptionLines(levo.fields)).toEqual(['Levothyroxine 50 µg, once a day', 'Vitamin D 2000 IU']);
    expect(prescriptionLines([field('dose', '5 mg', 0)])).toEqual([]);
    expect(prescriptionLines([{ label: 'diagnosis', value: 'x', group_no: null }])).toEqual([]);
  });
});

describe('what the card is offered from the records', () => {
  it('is the medicines of prescriptions of the last twelve months, newest first, and the titles the owner gave to episodes', () => {
    const older = { doc_date: '2026-01-10', fields: [field('drug', 'Ibuprofen', 0), field('dose', '400 mg', 0)] };
    const tooOld = { doc_date: '2025-06-01', fields: [field('drug', 'Amoxicillin', 0)] };
    const found = proposalsFrom([older, levo, tooOld], [{ title: 'Pneumonia, March' }, { title: '' }, { title: 'Pneumonia, March' }], { medications: [], conditions: [] }, NOW);
    expect(found.medications).toEqual(['Levothyroxine 50 µg, once a day', 'Vitamin D 2000 IU', 'Ibuprofen 400 mg']);
    expect(found.conditions).toEqual(['Pneumonia, March']);
  });

  it('offers each medicine once, the newest prescription of it', () => {
    const newer = { doc_date: '2026-10-01', fields: [field('drug', 'Levothyroxine', 0), field('dose', '75 µg', 0)] };
    expect(proposalsFrom([levo, newer], [], { medications: [], conditions: [] }, NOW).medications).toEqual(['Levothyroxine 75 µg', 'Vitamin D 2000 IU']);
  });

  it('leaves out what is on the card already, without regard to case or accents', () => {
    const found = proposalsFrom([levo], [{ title: 'Pneumonie' }], { medications: ['levothyroxine 50 µg, once a day'], conditions: ['pneumonie'] }, NOW);
    expect(found.medications).toEqual(['Vitamin D 2000 IU']);
    expect(found.conditions).toEqual([]);
  });

  it('finds nothing for no prescriptions and no episodes, and never invents a line', () => {
    expect(proposalsFrom([], [], { medications: [], conditions: [] }, NOW)).toEqual({ medications: [], conditions: [] });
  });
});

describe('the blood types', () => {
  it('are the four groups with their Rh, and nothing else to type', () => {
    expect(BLOOD_TYPES).toEqual(['A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', '0+', '0−']);
    for (const type of BLOOD_TYPES) expect(type.length).toBeLessThanOrEqual(5);
  });
});
