import type { VatSettings } from 'spine-anaf/index.js';
import { NOT_REGISTERED } from 'spine-anaf/index.js';
import type { AccountsStore } from 'spine-core/store/types.js';
import { sellerOf } from './seller.js';

/**
 * Whether the company is registered for VAT, kept in the database and changed from the invoices page (`routes/admin.ts`), like the seller (`seller.ts`): from which day an invoice carries VAT, and whether the
 * company has joined the One Stop Shop, so that a person in another EU country is charged their own country's VAT (`spine-anaf`, `vat.ts`, which says what each buyer is charged). None saved is a company not
 * registered. It is read each time an invoice is made, so a change applies to the next one; an invoice made is not changed. Spine's own e-Factura link and an invoicing service both use it; the service takes
 * only Romania's rates, so the One Stop Shop is for the own link.
 */
const KEY = 'invoice.vat';

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** What the administrator sent, checked: the settings, or what is wrong with them. */
export function readVat(input: unknown): { ok: true; vat: VatSettings } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'the VAT settings are missing' };
  const o = input as Record<string, unknown>;
  const registered = o.registered === true;
  if (!registered) return { ok: true, vat: { ...NOT_REGISTERED } };
  const from = typeof o.from === 'string' ? o.from.trim() : '';
  if (!DAY.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`))) return { ok: false, error: 'the day the company is registered from is needed, as YYYY-MM-DD' };
  return { ok: true, vat: { registered: true, from, oss: o.oss === true } };
}

export async function vatOf(store: Pick<AccountsStore, 'settings'>): Promise<VatSettings> {
  const row = (await store.settings.all()).find(r => r.key === KEY);
  if (!row) return { ...NOT_REGISTERED };
  try {
    const read = readVat(JSON.parse(row.value));
    return read.ok ? read.vat : { ...NOT_REGISTERED };
  } catch { return { ...NOT_REGISTERED }; }
}

/** Keeps what the administrator typed once it checks out, and the company can charge VAT (the seller has a VAT id); answers what is wrong, or null. */
export async function changeVat(store: Pick<AccountsStore, 'settings'>, input: unknown, at: string, options: { oss?: boolean } = {}): Promise<string | null> {
  const read = readVat(input);
  if (!read.ok) return read.error;
  if (read.vat.oss && options.oss === false) return 'the One Stop Shop needs Spine\'s own e-Factura link: an invoicing service takes only Romania\'s rates';
  if (read.vat.registered && !(await sellerOf(store))?.vatId) return 'save the company\'s VAT id with the seller first: an invoice with VAT carries it';
  await store.settings.set(KEY, JSON.stringify(read.vat), at);
  return null;
}
