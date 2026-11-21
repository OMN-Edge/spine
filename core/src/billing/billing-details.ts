import { z } from 'zod';

/**
 * What an invoice needs to know of a buyer, collected by the app before a purchase where the operator issues the invoice (`SPINE_INVOICING_PROVIDER`, docs/billing.md): the
 * payment provider's own checkout asks a Romanian buyer for a city and a postal code and not for a county, which e-Factura cannot do without. The details are kept at
 * the payment provider, on the customer record, and never here (SECURITY.md **M-45**); this is only what they are and when they are complete.
 */

/** The counties of Romania, and Bucharest, by the code ANAF and the invoicing service take. */
export const RO_COUNTIES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'AB', name: 'Alba' }, { code: 'AR', name: 'Arad' }, { code: 'AG', name: 'Argeș' }, { code: 'BC', name: 'Bacău' }, { code: 'BH', name: 'Bihor' },
  { code: 'BN', name: 'Bistrița-Năsăud' }, { code: 'BT', name: 'Botoșani' }, { code: 'BV', name: 'Brașov' }, { code: 'BR', name: 'Brăila' }, { code: 'B', name: 'București' },
  { code: 'BZ', name: 'Buzău' }, { code: 'CL', name: 'Călărași' }, { code: 'CS', name: 'Caraș-Severin' }, { code: 'CJ', name: 'Cluj' }, { code: 'CT', name: 'Constanța' },
  { code: 'CV', name: 'Covasna' }, { code: 'DB', name: 'Dâmbovița' }, { code: 'DJ', name: 'Dolj' }, { code: 'GL', name: 'Galați' }, { code: 'GR', name: 'Giurgiu' },
  { code: 'GJ', name: 'Gorj' }, { code: 'HR', name: 'Harghita' }, { code: 'HD', name: 'Hunedoara' }, { code: 'IL', name: 'Ialomița' }, { code: 'IS', name: 'Iași' },
  { code: 'IF', name: 'Ilfov' }, { code: 'MM', name: 'Maramureș' }, { code: 'MH', name: 'Mehedinți' }, { code: 'MS', name: 'Mureș' }, { code: 'NT', name: 'Neamț' },
  { code: 'OT', name: 'Olt' }, { code: 'PH', name: 'Prahova' }, { code: 'SJ', name: 'Sălaj' }, { code: 'SM', name: 'Satu Mare' }, { code: 'SB', name: 'Sibiu' },
  { code: 'SV', name: 'Suceava' }, { code: 'TR', name: 'Teleorman' }, { code: 'TM', name: 'Timiș' }, { code: 'TL', name: 'Tulcea' }, { code: 'VL', name: 'Vâlcea' },
  { code: 'VS', name: 'Vaslui' }, { code: 'VN', name: 'Vrancea' },
];

/** The code of Bucharest, whose addresses also need a sector (1 to 6). */
export const BUCHAREST = 'B';

/** The countries a buyer can be from (ISO 3166-1 alpha-2); their names are the browser's (`Intl.DisplayNames`), in the language of the screen. */
export const COUNTRIES: readonly string[] = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM ' +
  'PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM ' +
  'US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

const text = (max: number) => z.string().trim().min(1).max(max);

export const billingDetailsSchema = z.object({
  /** Who is invoiced: a person, or a company's name. */
  name: text(200),
  country: z.string().refine(c => COUNTRIES.includes(c), 'not a country'),
  /** The county's code, for Romania (required there, and nowhere else asked). */
  county: z.string().optional(),
  /** Bucharest's sector, 1 to 6 (required for an address there). */
  sector: z.string().optional(),
  city: text(100),
  address: text(200),
  postalCode: z.string().trim().max(20).optional(),
  /** A company's tax id (a CUI, or a VAT id); a person has none. */
  taxId: z.string().trim().max(40).optional(),
}).superRefine((d, ctx) => {
  if (d.country === 'RO') {
    if (!d.county || !RO_COUNTIES.some(c => c.code === d.county)) ctx.addIssue({ code: 'custom', path: ['county'], message: 'a county is needed for an address in Romania' });
    else if (d.county === BUCHAREST && !/^[1-6]$/.test(d.sector ?? '')) ctx.addIssue({ code: 'custom', path: ['sector'], message: 'a sector from 1 to 6 is needed for an address in Bucharest' });
  } else if (d.county || d.sector) {
    ctx.addIssue({ code: 'custom', path: ['county'], message: 'a county is only asked for in Romania' });
  }
});

export type BillingDetails = z.infer<typeof billingDetailsSchema>;
