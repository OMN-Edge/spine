/**
 * What identifies a value the owner removed, so that reading the document again does not bring it back. Case, spacing and
 * nothing else are ignored: a differently worded or different value is a new reading and may appear.
 */
const norm = (text: string | null | undefined): string => (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export const fieldKey = (label: string, value: string): string => `${norm(label)}|${norm(value)}`;

export const measurementKey = (canonical: string, valueText: string, takenOn: string | null): string =>
  `${norm(canonical)}|${norm(valueText)}|${takenOn ?? ''}`;

/** The place a value holds in a document: the same label in the same group, the same test on the same day. An owner's value there wins over a new reading's. */
export const fieldSlot = (label: string, groupNo: number | null | undefined): string => `${norm(label)}#${groupNo ?? ''}`;
export const measurementSlot = (canonical: string, takenOn: string | null): string => `${norm(canonical)}#${takenOn ?? ''}`;
