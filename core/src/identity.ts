/**
 * Who the open person is, as the person's own record says (the profile: its name and, where known, its birth date). The device knows it (the profile is a sealed record opened
 * there) and registers it; the card and a share link start from it, so a name is written once, in the profile, and not again on each of them. A process that registered none
 * has nobody open: both are empty, and what the card or link holds itself stands alone. Optional like `ShareHost`: null means nothing is taken from anywhere.
 */
export interface PersonIdentity {
  /** The profile's name, or empty: "Me", which is what an account calls its own first records, is not a name anyone is known by. */
  name: string;
  /** The profile's birth date as written there (year-month-day), or empty. */
  born: string;
}

export const NOBODY: PersonIdentity = { name: '', born: '' };

let current: (() => PersonIdentity) | null = null;

export const useIdentity = (identity: (() => PersonIdentity) | null): void => { current = identity; };

/** The open person's identity now; empty where none was registered. */
export const personIdentity = (): PersonIdentity => current?.() ?? NOBODY;
