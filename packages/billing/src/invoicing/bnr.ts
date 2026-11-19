/**
 * The rate of the National Bank of Romania (RON for one unit of a currency), for an invoice in a currency other than RON. The bank publishes a file each business day
 * (https://curs.bnr.ro/nbrfxrates.xml, the latest) and one for each year (https://curs.bnr.ro/files/xml/years/nbrfxrates2026.xml, every day published). The rate an invoice carries
 * is the one in force on the day it is dated, which the accountant confirmed (2026-11-19: "curs BNR valabil in ziua emiterii facturii, nu are legatura data incasarii"): the newest
 * published on or before that day, so a Saturday takes Friday's, and an invoice made days after its date still takes its own day's rate. With no date, the latest. Kept for an hour.
 */
// The file moved from www.bnr.ro (where the same address now answers with the bank's web page) to curs.bnr.ro; found by a real payment, 2026-11-15.
const URL = 'https://curs.bnr.ro/nbrfxrates.xml';
const yearUrl = (year: number): string => `https://curs.bnr.ro/files/xml/years/nbrfxrates${year}.xml`;
const KEEP_MS = 3_600_000;
type Day = { date: string; rates: Map<string, number> };
let kept: { at: number; days: Day[] } | null = null;
const keptYears = new Map<number, { at: number; days: Day[] }>();

/** The rates in the file: `<Rate currency="EUR">4.9772</Rate>`, with a `multiplier="100"` where the quote is for a hundred units. */
export function parseRates(xml: string): Map<string, number> {
  const rates = new Map<string, number>();
  for (const m of xml.matchAll(/<Rate\s+currency="([A-Z]{3})"(?:\s+multiplier="(\d+)")?\s*>([0-9.]+)<\/Rate>/g)) {
    const value = Number(m[3]) / Number(m[2] ?? 1);
    if (Number.isFinite(value) && value > 0) rates.set(m[1]!, value);
  }
  return rates;
}

/** Each day of a file: `<Cube date="2026-11-13">` with its rates; a year's file has one for each business day, the latest has one. */
export function parseDays(xml: string): Day[] {
  return [...xml.matchAll(/<Cube\s+date="(\d{4}-\d{2}-\d{2})"\s*>([\s\S]*?)<\/Cube>/g)].map(m => ({ date: m[1]!, rates: parseRates(m[2]!) }));
}

async function read(url: string, fetcher: typeof fetch): Promise<Day[]> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`the National Bank's rates could not be read (${res.status})`);
  const text = await res.text();
  // An address the bank has moved answers with its web page, not an error: say what it is rather than "no rate for EUR".
  if (!/<DataSet[\s>]/.test(text)) throw new Error('the National Bank\'s rates file is not at the address it was (it answered with something other than the rates)');
  return parseDays(text);
}

export async function bnrRate(currency: string, fetcher: typeof fetch = fetch, now = Date.now(), onDate?: string): Promise<number> {
  const code = currency.toUpperCase();
  if (code === 'RON') return 1;
  if (!kept || now - kept.at > KEEP_MS) kept = { at: now, days: await read(URL, fetcher) };
  let day: Day | undefined = kept.days[kept.days.length - 1];
  // A day before the latest published: the newest rate on or before it, from that year's file (the year before's where the year had none yet).
  if (onDate && day && onDate < day.date) {
    day = undefined;
    for (let year = Number(onDate.slice(0, 4)); year >= Number(onDate.slice(0, 4)) - 1 && !day; year--) {
      let file = keptYears.get(year);
      if (!file || now - file.at > KEEP_MS) { file = { at: now, days: await read(yearUrl(year), fetcher) }; keptYears.set(year, file); }
      day = file.days.filter(d => d.date <= onDate).pop();
    }
  }
  const rate = day?.rates.get(code);
  if (rate === undefined) throw new Error(`the National Bank publishes no rate for ${code}${onDate ? ` on or before ${onDate}` : ''}`);
  return rate;
}

/** For the tests: forget the kept file. */
export function forgetRates(): void { kept = null; keptYears.clear(); }
