import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';
import { cardSchema, cardText, OFFLINE_BYTES } from 'spine-core/emergency';

/**
 * The code that holds the card as text (for use with no signal) has to fit in a QR code at the lowest error correction, whatever the
 * owner wrote: the text is cut to OFFLINE_BYTES and says how much was left out, and a QR code that is too big for its largest version
 * is an exception that would leave the page with no code at all (CardQr shows nothing when drawing fails).
 */
const bytes = (s: string) => new TextEncoder().encode(s).length;
const long = (unit: string, n: number) => unit.repeat(n).slice(0, n);

describe('the code that holds the card with no signal', () => {
  const fullest = cardSchema.parse({
    name: long('Ștefănescu-Ionescu ', 120), born: '2012-03-04', blood_type: 'AB-',
    allergies: Array.from({ length: 20 }, (_, i) => long(`alergie ${i} la penicilină și ouă `, 120)),
    conditions: Array.from({ length: 20 }, (_, i) => long(`afecțiune ${i} — astm bronșic `, 120)),
    medications: Array.from({ length: 30 }, (_, i) => long(`medicament ${i} 5 mg dimineața `, 120)),
    contacts: Array.from({ length: 5 }, (_, i) => ({ name: long(`Părinte ${i} `, 80), relation: long('mamă ', 40), phone: '+40 700 000 00' + i })),
    details: Array.from({ length: 8 }, (_, i) => ({ kind: 'other', label: long('număr ', 40), value: long(`${i}`.repeat(60), 60), on_card: true })),
    notes: long('Poartă un aparat auditiv; 😀 vorbește română și engleză. ', 500),
    language: 'ro',
  });

  it('is cut to its limit, in bytes and not letters, and says that something was left out', () => {
    const { text, omitted } = cardText(fullest);
    expect(bytes(text)).toBeLessThanOrEqual(OFFLINE_BYTES);
    expect(omitted).toBeGreaterThan(0);
    expect(text).toMatch(/\(\+\d+ more\)$/);
  });

  it('fits in a QR code at the lowest error correction, the way the card page draws it', () => {
    const { text } = cardText(fullest);
    expect(() => QRCode.create(text, { errorCorrectionLevel: 'L' })).not.toThrow();
    // Well inside the largest version, so a phone with no signal can read it from a printed card.
    expect(QRCode.create(text, { errorCorrectionLevel: 'L' }).version).toBeLessThanOrEqual(20);
  });

  it('is shorter than the limit for an ordinary card, and holds all of it', () => {
    const card = cardSchema.parse({ name: 'Ana Exemplu', born: '1990', blood_type: 'A+', allergies: ['penicilină'], medications: ['insulină'], contacts: [{ name: 'Ion Exemplu', relation: 'soț', phone: '+40 700 000 000' }] });
    const { text, omitted } = cardText(card);
    expect(omitted).toBe(0);
    expect(text).toContain('Allergies: penicilină');
    expect(text).toContain('Contact: Ion Exemplu (soț) +40 700 000 000');
  });

  it('draws the address that opens the card, with its key, and the pairing link, at the level the page uses', () => {
    const address = `https://spine.example.test/share/${'a'.repeat(32)}#${'B'.repeat(43)}`;
    expect(() => QRCode.create(address, { errorCorrectionLevel: 'M' })).not.toThrow();
    const pairing = 'https://spine.example.test/pair#ABCD-EFGH-JKLM-NPQR-ST';
    expect(() => QRCode.create(pairing, { errorCorrectionLevel: 'M' })).not.toThrow();
  });
});
