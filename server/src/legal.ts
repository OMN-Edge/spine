import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEALTH_CONSENT_VERSION, TERMS_VERSION } from 'spine-core/consent.js';

export { HEALTH_CONSENT_VERSION, TERMS_VERSION, consentCurrent, consentNeeded, type ConsentNeed } from 'spine-core/consent.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const LEGAL_DOCS = ['privacy', 'terms', 'purpose', 'refunds'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

/** Where the texts are: `SPINE_LEGAL_DIR` for an operator who has written their own, else the ones shipped in `docs/legal/`. */
export function legalDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPINE_LEGAL_DIR ? path.resolve(env.SPINE_LEGAL_DIR) : path.resolve(here, '../../docs/legal');
}

/** Who runs this instance, as the footer and the terms say it: one reading of the settings, so the two cannot differ. */
export interface OperatorInfo {
  name: string;
  /** Registration and tax numbers, each as the operator wrote it ("Reg. no. ...", "VAT ..."): no country's way of numbering a company is assumed. */
  ids: string[];
  address: string | null;
  contact: string | null;
}

/** `SPINE_OPERATOR_NAME`, `SPINE_OPERATOR_IDS` (separated by `;`), `SPINE_OPERATOR_ADDRESS` and `SPINE_OPERATOR_CONTACT`; null while no name is set, so an instance that has not said who runs it shows nothing. */
export function operatorInfo(env: NodeJS.ProcessEnv = process.env): OperatorInfo | null {
  const name = env.SPINE_OPERATOR_NAME?.trim();
  if (!name) return null;
  return {
    name,
    ids: (env.SPINE_OPERATOR_IDS ?? '').split(';').map(id => id.trim()).filter(Boolean),
    address: env.SPINE_OPERATOR_ADDRESS?.trim() || null,
    contact: env.SPINE_OPERATOR_CONTACT?.trim() || null,
  };
}

/** The operator as a list for the terms' company section (`{{company}}`), or a plain line where none is named. */
function companyList(info: OperatorInfo | null): string {
  if (!info) return '- the operator of this instance';
  return [info.name, ...info.ids, ...(info.address ? [info.address] : []), ...(info.contact ? [info.contact] : [])].map(line => `- ${line}`).join('\n');
}

/**
 * A text with the operator filled in: `SPINE_OPERATOR_NAME` (who is the controller) and `SPINE_OPERATOR_CONTACT` (an address for
 * questions about the terms and a purchase) and `SPINE_OPERATOR_PRIVACY_CONTACT` (where requests about a person's data go, the contact when unset). Unset, they read as "the operator of this instance" and the contact line says to ask them, so a text is never
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
  // Where requests about a person's data go, when that is not the address for everything else; the one contact otherwise.
  const privacyContact = env.SPINE_OPERATOR_PRIVACY_CONTACT?.trim() || contact;
  return {
    // The refund policy explains the terms' section on paid plans, so it carries the terms' version; the other two are the health consent's.
    version: doc === 'terms' || doc === 'refunds' ? TERMS_VERSION : HEALTH_CONSENT_VERSION,
    markdown: raw.replaceAll('{{operator}}', name).replaceAll('{{contact}}', contact).replaceAll('{{privacy_contact}}', privacyContact).replaceAll('{{company}}', companyList(operatorInfo(env))),
  };
}
