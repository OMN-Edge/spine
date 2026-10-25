import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEALTH_CONSENT_VERSION, TERMS_VERSION } from 'spine-core/consent.js';

export { HEALTH_CONSENT_VERSION, TERMS_VERSION, consentCurrent, consentNeeded, type ConsentNeed } from 'spine-core/consent.js';

const here = path.dirname(fileURLToPath(import.meta.url));

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
