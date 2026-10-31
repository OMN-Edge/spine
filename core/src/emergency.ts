import { z } from 'zod';

/**
 * The emergency card (FR-EMG, CR-EMG-01): a short card the owner writes of what someone helping them needs to know at once. It is kept
 * with the records (never in a share, not exported) and published as a sealed bundle of its own kind that anyone with its address and key
 * can open without asking. What it says is the owner's own text, entered on purpose; nothing is taken from the documents.
 */
const line = (max: number) => z.string().trim().max(max).default('');
const items = (max: number, count: number) => z.array(z.string().trim().max(max)).max(count).default([]).transform(list => list.filter(item => item.length > 0));

export const cardSchema = z.object({
  v: z.literal(1).default(1),
  name: line(120),
  /** A year or a date, as the owner writes it. */
  born: line(10),
  blood_type: line(5),
  allergies: items(120, 20),
  conditions: items(120, 20),
  medications: items(120, 30),
  contacts: z.array(z.object({ name: line(80), relation: line(40), phone: line(40) })).max(5).default([])
    .transform(list => list.filter(c => c.name.length > 0 || c.phone.length > 0)),
  notes: line(500),
  /** The language the owner wrote it in (a code like `ro`), so a reader can be told. */
  language: line(5),
});

export type CardContent = z.infer<typeof cardSchema>;

export class CardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardError';
  }
}

export const EMPTY_CARD: CardContent = { v: 1, name: '', born: '', blood_type: '', allergies: [], conditions: [], medications: [], contacts: [], notes: '', language: '' };

/** The card as stored, from anything a request or an old row held; throws `CardError` in words when it cannot be. */
export function normaliseCard(input: unknown): CardContent {
  const parsed = cardSchema.safeParse(input);
  if (!parsed.success) throw new CardError(`the card is not in the expected form: ${parsed.error.issues[0]?.path.join('.') || 'card'} ${parsed.error.issues[0]?.message ?? ''}`.trim());
  return parsed.data;
}

/** Whether there is anything on it to show. */
export const cardIsEmpty = (c: CardContent): boolean =>
  !c.name && !c.born && !c.blood_type && !c.notes && c.allergies.length + c.conditions.length + c.medications.length + c.contacts.length === 0;

/** What fits in a QR code that anyone's phone reads with no network, with margin to scan quickly. */
export const OFFLINE_BYTES = 800;

const bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * The card as plain text for a QR code that holds the card itself (so it is readable with no network, and by any scanner). It can hold
 * little: the most urgent come first (allergies, medicines, conditions, a contact) and what does not fit is counted, not silently cut.
 * **Anyone who sees such a code reads the card**; the page says so.
 */
export function cardText(c: CardContent, limit = OFFLINE_BYTES): { text: string; omitted: number } {
  const first = fit(c, limit);
  if (first.omitted === 0) return first;
  // Room for the line that says some did not fit, so the reader knows the card is longer than the code.
  const second = fit(c, limit - bytes(`(+${first.omitted + 9} more)`) - 1);
  return { text: `${second.text}\n(+${second.omitted} more)`, omitted: second.omitted };
}

function fit(c: CardContent, limit: number): { text: string; omitted: number } {
  const head = ['EMERGENCY CARD', c.name && `Name: ${c.name}`, c.born && `Born: ${c.born}`, c.blood_type && `Blood: ${c.blood_type}`].filter(Boolean) as string[];
  const sections: Array<[string, string[]]> = [
    ['Allergies', c.allergies], ['Medicines', c.medications], ['Conditions', c.conditions],
    ['Contact', c.contacts.map(x => [x.name, x.relation && `(${x.relation})`, x.phone].filter(Boolean).join(' '))],
    ['Notes', c.notes ? [c.notes] : []],
  ];
  const lines = [...head];
  let omitted = 0;
  for (const [label, list] of sections) {
    const kept: string[] = [];
    for (const item of list) {
      const next = [...lines, `${label}: ${[...kept, item].join('; ')}`].join('\n');
      if (bytes(next) <= limit) kept.push(item); else omitted++;
    }
    if (kept.length > 0) lines.push(`${label}: ${kept.join('; ')}`);
  }
  return { text: lines.join('\n'), omitted };
}
