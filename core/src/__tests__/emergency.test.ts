import { describe, it, expect } from 'vitest';
import { CardError, EMPTY_CARD, OFFLINE_BYTES, cardIsEmpty, cardText, detailLabel, normaliseCard, publicCard } from '../emergency.js';

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

describe('official details', () => {
  const withDetails = () => card({
    allergies: ['penicillin'],
    details: [
      { kind: 'national_id', value: ' 1234567890123 ', on_card: true },
      { kind: 'insurance_number', value: 'HI-998877' },
      { kind: 'other', label: 'Blood donor card', value: 'D-42', on_card: true },
      { kind: 'passport', value: '   ' },
    ],
  });

  it('are kept, cleaned and off the card unless turned on; one with no value is dropped', () => {
    const c = withDetails();
    expect(c.details.map(d => [d.kind, d.value, d.on_card])).toEqual([['national_id', '1234567890123', true], ['insurance_number', 'HI-998877', false], ['other', 'D-42', true]]);
    expect(() => card({ details: Array.from({ length: 9 }, () => ({ kind: 'other', label: 'x', value: 'y' })) })).toThrow(CardError);
    expect(() => card({ details: [{ kind: 'ssn', value: '1' }] })).toThrow(CardError);
  });

  it('leave the device only if turned on: the card others read has the chosen ones and nothing else', () => {
    const shown = publicCard(withDetails());
    expect(shown.details.map(d => d.value)).toEqual(['1234567890123', 'D-42']);
    expect(JSON.stringify(shown)).not.toContain('HI-998877');
    const { text } = cardText(shown);
    expect(text).toContain('ID: National identification number 1234567890123; Blood donor card D-42');
    expect(text).not.toContain('HI-998877');
    // The text of a card that was not made public would leak what is off: that is why every path builds from publicCard.
    expect(cardText(withDetails()).text).not.toContain('HI-998877');
  });

  it('count as something written, but a card whose details are all off is empty to others', () => {
    const onlyOff = card({ name: '', details: [{ kind: 'insurer', value: 'Acme Health' }] });
    expect(cardIsEmpty(onlyOff)).toBe(false);
    expect(cardIsEmpty(publicCard(onlyOff))).toBe(true);
    expect(detailLabel({ kind: 'donor', label: '', value: 'yes', on_card: true })).toBe('Organ donor');
  });
});

