import { describe, it, expect } from 'vitest';
import { CardError, EMPTY_CARD, OFFLINE_BYTES, cardIsEmpty, cardText, normaliseCard } from '../emergency.js';

const card = (over: Record<string, unknown> = {}) => normaliseCard({ ...EMPTY_CARD, name: 'Jane Example', ...over });

describe('what is on the card', () => {
  it('is cleaned: trimmed, empty items and empty contacts dropped', () => {
    const c = card({ allergies: [' penicillin ', '', '  '], contacts: [{ name: '', relation: '', phone: '' }, { name: 'Sam', relation: 'partner', phone: '+40 700 000 000' }] });
    expect(c.allergies).toEqual(['penicillin']);
    expect(c.contacts).toEqual([{ name: 'Sam', relation: 'partner', phone: '+40 700 000 000' }]);
  });

  it('refuses what is too long or too many, in words', () => {
    expect(() => card({ name: 'x'.repeat(121) })).toThrow(CardError);
    expect(() => card({ allergies: Array.from({ length: 21 }, (_, n) => `a${n}`) })).toThrow(/allergies/);
    expect(() => normaliseCard('not a card')).toThrow(CardError);
  });

  it('knows when it is empty', () => {
    expect(cardIsEmpty(EMPTY_CARD)).toBe(true);
    expect(cardIsEmpty(card())).toBe(false);
  });
});

describe('the text an offline code holds', () => {
  it('puts what is urgent first and says it is a card', () => {
    const { text, omitted } = cardText(card({ allergies: ['penicillin'], medications: ['warfarin 5 mg'], conditions: ['asthma'], contacts: [{ name: 'Sam', relation: 'partner', phone: '+40 700 000 000' }], blood_type: 'A+' }));
    expect(text.split('\n')).toEqual(['EMERGENCY CARD', 'Name: Jane Example', 'Blood: A+', 'Allergies: penicillin', 'Medicines: warfarin 5 mg', 'Conditions: asthma', 'Contact: Sam (partner) +40 700 000 000']);
    expect(omitted).toBe(0);
  });

  it('fits the limit and counts what it left out instead of cutting it silently', () => {
    const many = Array.from({ length: 30 }, (_, n) => `medicine number ${n} with a long name and dose`);
    const { text, omitted } = cardText(card({ allergies: ['penicillin'], medications: many }));
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(OFFLINE_BYTES);
    expect(omitted).toBeGreaterThan(0);
    expect(text).toContain('Allergies: penicillin');
    expect(text).toContain(`(+${omitted} more)`);
  });

  it('counts bytes, not characters', () => {
    const { text } = cardText(card({ notes: 'ă'.repeat(400) }), 120);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(120);
  });
});
