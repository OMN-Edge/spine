/**
 * The ages that matter for a child's profile (CR-FAM-01, CR-FAM-02, GDPR Art. 8): sixteen is the age at which a person may have an account of
 * their own with their guardian's consent (Romania has not lowered it), and eighteen is when the records are theirs. A birth date is kept
 * sealed in the profile's record, so the server never knows it and these run on the device. Pure.
 */
export const OWN_ACCOUNT_AGE = 16;
export const ADULT_AGE = 18;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A birth date as `YYYY-MM-DD`, if it is a real day between 1900 and today; null otherwise. */
export function parseBorn(text: string, now = new Date()): string | null {
  const m = DATE.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  if (y < 1900 || date.getTime() > now.getTime()) return null;
  return text.trim();
}

/** Whole years on the day `now` (UTC), or null if there is no valid birth date. */
export function ageOn(born: string | undefined, now = new Date()): number | null {
  const ok = born ? parseBorn(born, now) : null;
  if (!ok) return null;
  const [y, m, d] = ok.split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age--;
  return age;
}

/** Whether a child may have an account of their own, with their guardian's consent. A child with no birth date may not. */
export const mayHaveOwnAccount = (born: string | undefined, now = new Date()): boolean => (ageOn(born, now) ?? -1) >= OWN_ACCOUNT_AGE;

/** Whether the records should now be the person's own. A profile with no birth date is not taken to be an adult's child profile. */
export const isAdult = (born: string | undefined, now = new Date()): boolean => (ageOn(born, now) ?? -1) >= ADULT_AGE;
