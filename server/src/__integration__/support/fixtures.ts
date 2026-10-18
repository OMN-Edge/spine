/**
 * Invented clinical text for the flows: no real person, clinic or number. Written without diacritics, as a clinic's plain-text export
 * often is. Each document says what the tests below look for in plain words, so a model that reads it correctly gets the facts, and the
 * facts are chosen to be unambiguous (one date, one provider, a value with its unit and range).
 */
export const PATIENT = 'Pacient: Exemplu Andrei    Data nasterii: 14.05.1980';

/** A laboratory report of two pages, numbered. */
export const LAB_REPORT: string[][] = [
  [
    'Laborator Exemplu SRL', 'Buletin de analize nr. LAB-2026-00417  Pagina 1 din 2', PATIENT,
    'Data recoltarii: 12.03.2026    Data rezultatului: 12.03.2026', 'Medic trimitator: Dr. Popescu Ion, cardiologie',
    '', 'HEMATOLOGIE', 'Hemoglobina            13.5 g/dL      (12.0 - 16.0)', 'Leucocite              6.2 x10^9/L    (4.0 - 10.0)', 'Trombocite             250 x10^9/L    (150 - 400)',
  ],
  [
    'Laborator Exemplu SRL', 'Buletin de analize nr. LAB-2026-00417  Pagina 2 din 2', PATIENT,
    '', 'BIOCHIMIE', 'Colesterol total        5.9 mmol/L     (< 5.2)  CRESCUT', 'LDL colesterol          3.8 mmol/L     (< 3.0)  CRESCUT', 'Glucoza                5.1 mmol/L     (3.9 - 5.6)',
    '', 'Rezultate validate de: Dr. Marinescu Elena, medic de laborator, cod parafa M45821', 'Laborator Exemplu SRL, Strada Exemplului 1, Bucuresti',
  ],
];

/** A cardiology consultation that asks for tests, a month before the report above. */
export const CONSULTATION: string[][] = [[
  'Clinica Exemplu - Cardiologie', 'Fisa de consultatie', PATIENT, 'Data consultatiei: 20.02.2026',
  'Medic: Dr. Popescu Ion, medic specialist cardiologie, cod parafa A12345',
  '', 'Motivul prezentarii: dureri toracice la efort, control.', 'Diagnostic: dislipidemie mixta, suspiciune.',
  'Recomandari: hemoleucograma si profil lipidic complet (colesterol total, LDL, HDL), control in 3 saptamani cu rezultatele.',
  'Tratament: regim alimentar, activitate fizica.',
]];

/** A hospital discharge note of two pages. */
export const DISCHARGE: string[][] = [
  [
    'Spital Exemplu - Sectia Medicina Interna', 'Foaie de externare nr. ADM-884201  Pagina 1 din 2', PATIENT,
    'Data internarii: 02.04.2026    Data externarii: 06.04.2026', 'Diagnostic principal: pneumonie comunitara.',
    'Istoric: febra, tuse productiva de 4 zile.', 'Evolutie: favorabila sub tratament antibiotic intravenos.',
  ],
  [
    'Spital Exemplu - Sectia Medicina Interna', 'Foaie de externare nr. ADM-884201  Pagina 2 din 2', PATIENT,
    'Recomandari la externare: repaus 7 zile, amoxicilina 500 mg de 3 ori pe zi 7 zile, control la medicul de familie.',
    'Medic curant: Dr. Ionescu Maria, medic primar medicina interna, cod parafa B22222',
  ],
];

/** A prescription of one page. */
export const PRESCRIPTION: string[][] = [[
  'Reteta electronica RX-5530917', PATIENT, 'Emisa la: 20.05.2026', 'Medicina de familie - Dr. Ionescu Maria', 'Amoxicilina 500 mg - 1 capsula de 3 ori pe zi, 7 zile',
]];

/** The facts above, for the assertions. */
export const FACTS = {
  lab: { date: '2026-03-12', provider: /laborator exemplu/i, hemoglobin: '13.5', hemoglobinUnit: /g\/dl/i, requester: /popescu/i },
  consultation: { date: '2026-02-20', provider: /clinica exemplu/i },
  discharge: { from: '2026-04-02', to: '2026-04-06', provider: /spital exemplu/i, diagnosis: /pneumonie/i },
};
