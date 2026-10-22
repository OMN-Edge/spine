import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserRecord } from './store/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The texts a person agrees to, and which version of each they were shown (GDPR Art. 7 and 9(2)(a); the consent is a record, not
 * a checkbox that is gone). Change the text in `docs/legal/` and raise the version, and everyone is asked again at their next
 * sign-in, because the consent they gave was to the old words.
 */
export const HEALTH_CONSENT_VERSION = '2026-10-22';
export const TERMS_VERSION = '2026-10-22';

export const LEGAL_DOCS = ['privacy', 'terms', 'purpose'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

/** Where the texts are: `SPINE_LEGAL_DIR` for an operator who has written their own, else the ones shipped in `docs/legal/`. */
export function legalDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPINE_LEGAL_DIR ? path.resolve(env.SPINE_LEGAL_DIR) : path.resolve(here, '../../docs/legal');
}

/**
 * A text with the operator filled in: `SPINE_OPERATOR_NAME` (who is the controller) and `SPINE_OPERATOR_CONTACT` (an address for
 * privacy requests). Unset, they read as "the operator of this instance" and the contact line says to ask them, so a text is never
 * published with a blank where a name should be.
 */
export function legalText(doc: LegalDoc, env: NodeJS.ProcessEnv = process.env): { version: string; markdown: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(legalDir(env), `${doc}.md`), 'utf8');
  } catch {
    return null;
  }
  const name = env.SPINE_OPERATOR_NAME?.trim() || 'the operator of this instance';
  const contact = env.SPINE_OPERATOR_CONTACT?.trim() || 'the operator of this instance';
  return {
    version: doc === 'terms' ? TERMS_VERSION : HEALTH_CONSENT_VERSION,
    markdown: raw.replaceAll('{{operator}}', name).replaceAll('{{contact}}', contact),
  };
}

export type ConsentNeed = { health: boolean; terms: boolean };

/** What this account still has to agree to: nothing once it has agreed to the current text of both. */
export function consentNeeded(user: Pick<UserRecord, 'health_consent_version' | 'terms_version'>): ConsentNeed {
  return { health: user.health_consent_version !== HEALTH_CONSENT_VERSION, terms: user.terms_version !== TERMS_VERSION };
}

export const consentCurrent = (user: Pick<UserRecord, 'health_consent_version' | 'terms_version'>): boolean => {
  const need = consentNeeded(user);
  return !need.health && !need.terms;
};
