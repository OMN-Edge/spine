import type { UserRecord } from './store/index.js';

/**
 * The texts a person agrees to, and which version of each they were shown (GDPR Art. 7 and 9(2)(a); the consent is a record, not
 * a checkbox that is gone). Change the text in `docs/legal/` and raise the version, and everyone is asked again at their next
 * sign-in, because the consent they gave was to the old words.
 */
export const HEALTH_CONSENT_VERSION = '2026-11-07';
export const TERMS_VERSION = '2026-11-06';

export type ConsentNeed = { health: boolean; terms: boolean };

/** What this account still has to agree to: nothing once it has agreed to the current text of both. */
export function consentNeeded(user: Pick<UserRecord, 'health_consent_version' | 'terms_version'>): ConsentNeed {
  return { health: user.health_consent_version !== HEALTH_CONSENT_VERSION, terms: user.terms_version !== TERMS_VERSION };
}

export const consentCurrent = (user: Pick<UserRecord, 'health_consent_version' | 'terms_version'>): boolean => {
  const need = consentNeeded(user);
  return !need.health && !need.terms;
};
