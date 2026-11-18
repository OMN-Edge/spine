import type { UblSeller } from 'spine-anaf/index.js';
import type { AccountsStore } from 'spine-core/store/types.js';

/**
 * Who the invoices are made out by, kept in the database and changed from the admin page (`routes/admin.ts`), so it works on a host with no disk and changes without a
 * release. It is what Spine's own PDF of an invoice a service issued shows (`document.ts`) and is copied into each invoice's document when it is made, so a later change
 * does not touch an invoice already issued. With none saved, no document is kept and the service's own PDF is the one served. Spine's own e-Factura link (`SPINE_INVOICING=efactura`)
 * takes the seller from the environment, since it must have it at start-up to write the XML.
 */
const KEY = 'invoice.seller';

export interface SellerAccount { iban: string; bank?: string; bic?: string; currency?: string }

const text = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** What the admin page sent, checked like the environment's seller (`config.ts`): the seller, or what is wrong with it. */
export function readSeller(input: unknown): { ok: true; seller: UblSeller } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'the seller is missing' };
  const o = input as Record<string, unknown>;
  const name = text(o.name);
  const cif = text(o.cif, 20).toUpperCase().replace(/^RO/, '').replace(/\s/g, '');
  const street = text(o.street);
  const city = text(o.city);
  const county = text(o.county, 5).toUpperCase().replace(/^RO-/, '');
  const postalCode = text(o.postalCode, 12);
  const sector = text(o.sector, 2);
  if (!name) return { ok: false, error: 'the company name is needed' };
  if (!/^\d{2,10}$/.test(cif)) return { ok: false, error: 'the tax number is digits only (2 to 10), without RO' };
  if (!street) return { ok: false, error: 'the street is needed' };
  if (!city) return { ok: false, error: 'the city is needed' };
  if (!/^[A-Z]{1,2}$/.test(county)) return { ok: false, error: 'the county is its code ("B", "CJ", "IS")' };
  if (county === 'B' && !/^[1-6]$/.test(sector)) return { ok: false, error: 'Bucharest needs the sector, 1 to 6' };
  if (!postalCode) return { ok: false, error: 'the postal code is needed' };
  const vatId = text(o.vatId, 20).toUpperCase().replace(/\s/g, '');
  const email = text(o.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'the email is not an address' };
  const accounts: SellerAccount[] = [];
  for (const raw of Array.isArray(o.accounts) ? o.accounts.slice(0, 6) : []) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const iban = text(a.iban, 40).replace(/\s+/g, ' ').toUpperCase();
    if (!iban) continue;
    if (!/^[A-Z]{2}\d{2}[A-Z0-9 ]{8,30}$/.test(iban)) return { ok: false, error: `${iban} is not an IBAN` };
    const bic = text(a.bic, 11).toUpperCase().replace(/\s/g, '');
    if (bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) return { ok: false, error: `${bic} is not a BIC` };
    const currency = text(a.currency, 3).toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) return { ok: false, error: `${currency} is not a currency code` };
    const bank = text(a.bank);
    accounts.push({ iban, ...(bank ? { bank } : {}), ...(bic ? { bic } : {}), ...(currency ? { currency } : {}) });
  }
  const optional = (key: string, max = 200) => { const v = text(o[key], max); return v ? { [key]: v } : {}; };
  return {
    ok: true,
    seller: {
      name, cif, street, city, county, postalCode,
      ...(sector ? { sector } : {}), ...(vatId ? { vatId } : {}), ...optional('registerNo', 40), ...optional('tradeName'), ...(email ? { email } : {}), ...optional('phone', 40),
      ...(accounts.length > 0 ? { accounts } : {}),
    },
  };
}

export async function sellerOf(store: Pick<AccountsStore, 'settings'>): Promise<UblSeller | null> {
  const row = (await store.settings.all()).find(r => r.key === KEY);
  if (!row) return null;
  try {
    const read = readSeller(JSON.parse(row.value));
    return read.ok ? read.seller : null;
  } catch { return null; }
}

/** Keeps what the administrator typed once it checks out; answers what is wrong, or null. */
export async function changeSeller(store: Pick<AccountsStore, 'settings'>, input: unknown, at: string): Promise<string | null> {
  const read = readSeller(input);
  if (!read.ok) return read.error;
  await store.settings.set(KEY, JSON.stringify(read.seller), at);
  return null;
}
