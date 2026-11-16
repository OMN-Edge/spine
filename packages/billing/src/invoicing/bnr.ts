/**
 * The rate of the National Bank of Romania (RON for one unit of a currency), from the file it publishes each business day (https://curs.bnr.ro/nbrfxrates.xml),
 * for an invoice in a currency other than RON. The latest rate is used, which is the one in force on the day of the invoice for a payment made after it is
 * published; whether the accountant wants the rate of another day is for them to say. Kept for an hour.
 */
// The file moved from www.bnr.ro (where the same address now answers with the bank's web page) to curs.bnr.ro; found by a real payment, 2026-11-15.
const URL = 'https://curs.bnr.ro/nbrfxrates.xml';
const KEEP_MS = 3_600_000;
let kept: { at: number; rates: Map<string, number> } | null = null;

/** The rates in the file: `<Rate currency="EUR">4.9772</Rate>`, with a `multiplier="100"` where the quote is for a hundred units. */
export function parseRates(xml: string): Map<string, number> {
  const rates = new Map<string, number>();
  for (const m of xml.matchAll(/<Rate\s+currency="([A-Z]{3})"(?:\s+multiplier="(\d+)")?\s*>([0-9.]+)<\/Rate>/g)) {
    const value = Number(m[3]) / Number(m[2] ?? 1);
    if (Number.isFinite(value) && value > 0) rates.set(m[1]!, value);
  }
  return rates;
}

export async function bnrRate(currency: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<number> {
  const code = currency.toUpperCase();
  if (code === 'RON') return 1;
  if (!kept || now - kept.at > KEEP_MS) {
    const res = await fetcher(URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`the National Bank's rates could not be read (${res.status})`);
    const text = await res.text();
    // An address the bank has moved answers with its web page, not an error: say what it is rather than "no rate for EUR".
    if (!/<DataSet[\s>]/.test(text)) throw new Error('the National Bank\'s rates file is not at the address it was (it answered with something other than the rates)');
    kept = { at: now, rates: parseRates(text) };
  }
  const rate = kept.rates.get(code);
  if (rate === undefined) throw new Error(`the National Bank publishes no rate for ${code}`);
  return rate;
}

/** For the tests: forget the kept file. */
export function forgetRates(): void { kept = null; }
