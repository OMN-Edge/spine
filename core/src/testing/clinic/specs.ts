import type { Body, Page, Patient, Provider, Row } from './render.js';

/**
 * An invented archive for one invented patient over two years, built to be hard for linking: the documents of a chronic condition arrive in three care cycles a year apart; a blood test and an
 * eye check happen the same day at the same clinic and have nothing to do with each other; a dental invoice falls on the day of a cardiology visit; a report and a sick-leave certificate are each
 * held twice; an annual panel repeats tests that belong to another story. `GROUND_TRUTH` says what is related and what must never be, so a run can be marked.
 *
 * Everything is invented: no real person, clinic, address or code.
 */
export const PATIENT: Patient = { name: 'Popa Mihai-Andrei', born: '12.09.1979', fileNo: 'F-20418' };

export const PROVIDERS: Record<string, Provider> = {
  poli: { key: 'poli', name: 'Policlinica Sănătatea', sub: 'Centru medical multi-specialitate', address: 'Str. Lalelelor 14, București', contact: 'tel. 021 555 0142', color: '#0f766e', tint: '#d9efec', logo: 'cross' },
  lab: { key: 'lab', name: 'MedisLab', sub: 'Laborator de analize medicale', address: 'Bd. Unirii 77, București', contact: 'tel. 021 555 0177 · rezultate online', color: '#1e3a8a', tint: '#dbe4f7', logo: 'hex' },
  spital: { key: 'spital', name: 'Spitalul Județean Exemplu', sub: 'Secția Pneumologie · Str. Spitalului 1, Ploiești', address: 'Str. Spitalului 1, Ploiești', contact: 'tel. 0244 555 011', color: '#9f1239', tint: '#f6dbe3', logo: 'shield' },
  cabinet: { key: 'cabinet', name: 'Cabinet Medicină de Familie Dr. Ionescu', sub: 'Medic de familie · contract cu CAS', address: 'Str. Teilor 5, București', contact: 'tel. 0722 555 018', color: '#166534', tint: '#dcefe0', logo: 'plain' },
  radio: { key: 'radio', name: 'Radio+ Imagistică', sub: 'Radiologie · Ecografie · Computer tomograf', address: 'Calea Victoriei 120, București', contact: 'tel. 021 555 0190', color: '#c2410c', tint: '#fbe3d6', logo: 'wave' },
  uro: { key: 'uro', name: 'Clinica UroMed', sub: 'Urologie și litotriție', address: 'Str. Fluturilor 3, București', contact: 'tel. 021 555 0166', color: '#6d28d9', tint: '#e8dffa', logo: 'drop' },
  dental: { key: 'dental', name: 'Dental Smile', sub: 'Stomatologie · Ortodonție', address: 'Str. Zâmbetului 9, București', contact: 'tel. 0733 555 044', color: '#be185d', tint: '#f9dcea', logo: 'tooth' },
  cas: { key: 'cas', name: 'Spitalul Județean Exemplu', sub: 'Certificate de concediu medical', address: 'Str. Spitalului 1, Ploiești', contact: 'tel. 0244 555 011', color: '#1e3a8a', tint: '#dbe4f7', logo: 'plain' },
};

export const DOCTORS = {
  anghel: { name: 'Dr. Anghel Carmen', role: 'medic primar endocrinologie', code: 'E48213' },
  vasile: { name: 'Dr. Vasile Radu', role: 'medic specialist oftalmologie', code: 'O30977' },
  popescu: { name: 'Dr. Popescu Ion', role: 'medic specialist cardiologie', code: 'A12345' },
  ionescu: { name: 'Dr. Ionescu Maria', role: 'medic de familie', code: 'F77120' },
  marinescu: { name: 'Dr. Marinescu Elena', role: 'medic de laborator', code: 'M45821' },
  stan: { name: 'Dr. Stan Gabriel', role: 'medic primar urologie', code: 'U20645' },
  dumitru: { name: 'Dr. Dumitru Ana', role: 'medic specialist dermatovenerologie', code: 'D55902' },
  toma: { name: 'Dr. Toma Victor', role: 'medic radiolog', code: 'R41873' },
  neagu: { name: 'Dr. Neagu Sorin', role: 'medic primar pneumologie', code: 'P60214' },
  dent: { name: 'Dr. Lupu Irina', role: 'medic stomatolog', code: 'S10388' },
};

export type Cycle = 'thy1' | 'thy2' | 'thy3' | 'eye' | 'card1' | 'card2' | 'dental' | 'pneu' | 'uro' | 'derm' | 'annual';

export interface DocSpec {
  id: string;
  /** The care cycle it belongs to: the story it is a part of. */
  cycle: Cycle;
  provider: keyof typeof PROVIDERS;
  doctor: keyof typeof DOCTORS | null;
  date: string;
  body: Body;
  /** A second copy of another document, scanned and sent again. */
  duplicateOf?: string;
  /** What a good reading would call it, for the log. */
  label: string;
  /** The certificate form carries its own number. */
  docNo?: string;
}

const f = (...pairs: Array<[string, string]>) => pairs;
const sec = (heading: string, text: string) => ({ heading, text });
const ro = (iso: string) => iso.split('-').reverse().join('.');
const row = (name: string, value: string, unit: string, ref: string, flag?: 'H' | 'L'): Row => ({ name, value, unit, ref, ...(flag ? { flag } : {}) });

const consult = (title: string, date: string, spec: string, motive: string, exam: string, dx: string, plan: string): Body => ({
  kind: 'letter', title, fields: f(['Data consultației', ro(date)], ['Specialitatea', spec]),
  sections: [sec('Motivul prezentării', motive), sec('Examen clinic', exam), sec('Diagnostic', dx), sec('Recomandări și plan', plan)],
});

const thyroidLab = (date: string, tsh: string, ft4: string, flagT?: 'H' | 'L', flagF?: 'H' | 'L'): Body => ({
  kind: 'lab', title: 'Buletin de analize medicale', fields: f(['Data recoltării', ro(date)], ['Data rezultatului', ro(date)], ['Medic trimițător', 'Dr. Anghel Carmen, endocrinologie']),
  groups: [{ heading: 'Hormoni tiroidieni', rows: [row('TSH', tsh, 'µUI/mL', '0.40 – 4.00', flagT), row('FT4 (tiroxină liberă)', ft4, 'ng/dL', '0.80 – 1.80', flagF), row('Anticorpi anti-TPO', '12', 'UI/mL', '< 35')] }],
});

export const DOCS: DocSpec[] = [
  // ——— the thyroid, three cycles a year apart ———————————————————————————————————————————————
  { id: 'thy1-consult', cycle: 'thy1', provider: 'poli', doctor: 'anghel', date: '2025-02-10', label: 'Endocrinology consult (thyroid), asks for TSH/FT4/anti-TPO',
    body: consult('Fișă de consultație — Endocrinologie', '2025-02-10', 'Endocrinologie', 'Oboseală, creștere în greutate de 5 kg în 4 luni, frilozitate, constipație.', 'Tegumente uscate, puls 58/min, TA 118/76 mmHg, tiroidă mărită ușor, nedureroasă.', 'Suspiciune de hipotiroidism. Necesită confirmare de laborator.', 'Recomand: TSH, FT4 și anticorpi anti-TPO, recoltate dimineața, pe nemâncate. Revine la control cu rezultatele în 1–2 săptămâni.') },
  { id: 'thy1-lab', cycle: 'thy1', provider: 'lab', doctor: 'marinescu', date: '2025-02-17', label: 'Thyroid panel: TSH high', body: thyroidLab('2025-02-17', '9.80', '0.71', 'H', 'L') },
  { id: 'thy1-control', cycle: 'thy1', provider: 'poli', doctor: 'anghel', date: '2025-02-24', label: 'Endocrinology control: starts levothyroxine',
    body: consult('Fișă de consultație — control endocrinologie', '2025-02-24', 'Endocrinologie', 'Control cu rezultatele analizelor recomandate la consultația din 10.02.2025.', 'Aceeași stare generală. TA 120/78 mmHg.', 'Hipotiroidism primar (TSH 9.80 µUI/mL). Se începe tratament substitutiv.', 'Levotiroxină 50 mcg dimineața pe nemâncate. Control peste 3 luni cu TSH și FT4.') },
  { id: 'thy1-rx', cycle: 'thy1', provider: 'poli', doctor: 'anghel', date: '2025-02-24', label: 'Prescription: levothyroxine 50',
    body: { kind: 'rx', title: 'Rețetă medicală', fields: f(['Data', '24.02.2025'], ['Diagnostic', 'Hipotiroidism primar']), items: [{ drug: 'Levotiroxină sodică 50 mcg comprimate', dose: '1 comprimat dimineața', how: 'pe nemâncate, 30 de minute înainte de mic dejun, 90 de zile' }], note: 'Rețetă compensată 90%.' } },

  { id: 'thy2-consult', cycle: 'thy2', provider: 'poli', doctor: 'anghel', date: '2025-05-26', label: 'Endocrinology control visit, asks repeat TSH',
    body: consult('Fișă de consultație — control endocrinologie', '2025-05-26', 'Endocrinologie', 'Control la 3 luni de la începerea levotiroxinei. Se simte mai bine, mai puțin obosit.', 'Puls 66/min, TA 119/77 mmHg, greutate stabilă.', 'Hipotiroidism primar sub tratament, evoluție favorabilă.', 'Se continuă levotiroxină 50 mcg. Recomand TSH și FT4 înainte de următorul control, în aproximativ o săptămână.') },
  { id: 'thy2-lab', cycle: 'thy2', provider: 'poli', doctor: 'marinescu', date: '2025-06-02', label: 'Thyroid panel at the clinic’s own lab (same day as the eye check)',
    body: { ...thyroidLab('2025-06-02', '5.10', '1.02', 'H'), fields: f(['Data recoltării', '02.06.2025'], ['Data rezultatului', '02.06.2025'], ['Medic trimițător', 'Dr. Anghel Carmen, endocrinologie'], ['Laborator', 'Laborator propriu — Policlinica Sănătatea']) } },
  { id: 'thy2-control', cycle: 'thy2', provider: 'poli', doctor: 'anghel', date: '2025-06-09', label: 'Endocrinology control: dose raised to 75',
    body: consult('Fișă de consultație — control endocrinologie', '2025-06-09', 'Endocrinologie', 'Control cu analizele recomandate la 26.05.2025.', 'Fără modificări semnificative.', 'Hipotiroidism primar, TSH încă ușor crescut (5.10 µUI/mL).', 'Se crește levotiroxina la 75 mcg dimineața. Control peste 5 luni cu TSH și FT4.') },
  { id: 'thy2-rx', cycle: 'thy2', provider: 'poli', doctor: 'anghel', date: '2025-06-09', label: 'Prescription: levothyroxine 75',
    body: { kind: 'rx', title: 'Rețetă medicală', fields: f(['Data', '09.06.2025'], ['Diagnostic', 'Hipotiroidism primar']), items: [{ drug: 'Levotiroxină sodică 75 mcg comprimate', dose: '1 comprimat dimineața', how: 'pe nemâncate, 150 de zile' }], note: 'Înlocuiește tratamentul cu 50 mcg.' } },

  { id: 'thy3-consult', cycle: 'thy3', provider: 'poli', doctor: 'anghel', date: '2025-11-17', label: 'Endocrinology control visit, asks repeat TSH',
    body: consult('Fișă de consultație — control endocrinologie', '2025-11-17', 'Endocrinologie', 'Control programat la 5 luni, sub levotiroxină 75 mcg.', 'Puls 68/min, TA 121/79 mmHg.', 'Hipotiroidism primar compensat clinic.', 'Continuă levotiroxină 75 mcg. Recomand TSH și FT4 la o săptămână înainte de reevaluare.') },
  { id: 'thy3-lab', cycle: 'thy3', provider: 'lab', doctor: 'marinescu', date: '2025-11-24', label: 'Thyroid panel: normal', body: thyroidLab('2025-11-24', '2.30', '1.21') },
  { id: 'thy3-control', cycle: 'thy3', provider: 'poli', doctor: 'anghel', date: '2025-12-01', label: 'Endocrinology control: stable',
    body: consult('Fișă de consultație — control endocrinologie', '2025-12-01', 'Endocrinologie', 'Reevaluare cu rezultatele recoltate la 24.11.2025.', 'Fără modificări.', 'Hipotiroidism primar compensat (TSH 2.30 µUI/mL).', 'Se continuă același tratament. Control peste 12 luni sau la apariția simptomelor.') },

  // ——— the eye, the same day and the same clinic as the thyroid panel ———————————————————————
  { id: 'eye-consult', cycle: 'eye', provider: 'poli', doctor: 'vasile', date: '2025-06-02', label: 'Ophthalmology: routine check, myopia',
    body: consult('Fișă de consultație — Oftalmologie', '2025-06-02', 'Oftalmologie', 'Control de rutină, vedere încețoșată la distanță la volan.', 'Acuitate vizuală OD 0.5, OS 0.6 fără corecție; cu corecție 1.0 bilateral. Tensiune oculară OD 15, OS 16 mmHg. Fund de ochi normal.', 'Miopie ușoară, fără semne de afectare retiniană.', 'Corecție optică prescrisă. Control peste 24 de luni.') },
  { id: 'eye-glasses', cycle: 'eye', provider: 'poli', doctor: 'vasile', date: '2025-06-02', label: 'Optical prescription (glasses)',
    body: { kind: 'rx', title: 'Prescripție optică', fields: f(['Data', '02.06.2025'], ['Distanța interpupilară', '63 mm']), items: [{ drug: 'OD: sferic −1.50 D, cilindru −0.25 D, ax 90°', dose: 'Pentru distanță', how: 'purtare permanentă' }, { drug: 'OS: sferic −1.75 D, cilindru −0.25 D, ax 85°', dose: 'Pentru distanță', how: 'purtare permanentă' }], note: 'Ochelari, lentile organice cu strat antireflex.' } },

  // ——— cardiology, with a dental invoice the same day and a duplicate lab ——————————————————————
  { id: 'card1-consult', cycle: 'card1', provider: 'poli', doctor: 'popescu', date: '2026-02-20', label: 'Cardiology consult: chest pain, asks ECG and lipids',
    body: consult('Fișă de consultație — Cardiologie', '2026-02-20', 'Cardiologie', 'Dureri toracice la efort, de aproximativ 10 minute, cedează în repaus. Fumător ocazional, tată cu infarct la 58 de ani.', 'TA 142/88 mmHg, AV 78/min, zgomote cardiace ritmice, fără sufluri. Abdomen suplu.', 'Durere toracică atipică. Dislipidemie suspectată. Risc cardiovascular de evaluat.', 'Recomand EKG de repaus și profil lipidic complet (colesterol total, LDL, HDL, trigliceride), glicemie. Control cu rezultatele în 3–4 săptămâni.') },
  { id: 'card1-ecg', cycle: 'card1', provider: 'poli', doctor: 'popescu', date: '2026-02-20', label: 'Resting ECG, same visit',
    body: { kind: 'ecg', title: 'Electrocardiogramă de repaus', fields: f(['Data', '20.02.2026'], ['Viteza', '25 mm/s'], ['Derivații', '12']), sections: [sec('Descriere', 'Ritm sinusal, frecvență 76/min, ax QRS normal, interval PR 160 ms, QRS 90 ms, QTc 410 ms. Fără modificări ST-T.'), sec('Concluzie', 'EKG normală în repaus.')] } },
  { id: 'card1-lab', cycle: 'card1', provider: 'lab', doctor: 'marinescu', date: '2026-03-12', label: 'Lipid panel: LDL high',
    body: { kind: 'lab', title: 'Buletin de analize medicale', fields: f(['Data recoltării', '12.03.2026'], ['Data rezultatului', '12.03.2026'], ['Medic trimițător', 'Dr. Popescu Ion, cardiologie']),
      groups: [{ heading: 'Profil lipidic', rows: [row('Colesterol total', '5.9', 'mmol/L', '< 5.2', 'H'), row('LDL colesterol', '3.8', 'mmol/L', '< 3.0', 'H'), row('HDL colesterol', '1.1', 'mmol/L', '> 1.0'), row('Trigliceride', '1.9', 'mmol/L', '< 1.7', 'H')] }, { heading: 'Biochimie', rows: [row('Glucoză', '5.1', 'mmol/L', '3.9 – 5.6'), row('Creatinină', '82', 'µmol/L', '60 – 110')] }] } },
  { id: 'card1-lab-dup', cycle: 'card1', provider: 'lab', doctor: 'marinescu', date: '2026-03-12', duplicateOf: 'card1-lab', label: 'The same lipid panel, scanned and sent again', body: { kind: 'letter', title: '', fields: [], sections: [] } },
  { id: 'card1-control', cycle: 'card1', provider: 'poli', doctor: 'popescu', date: '2026-03-26', label: 'Cardiology control: starts a statin',
    body: consult('Fișă de consultație — control cardiologie', '2026-03-26', 'Cardiologie', 'Control cu EKG din 20.02.2026 și profilul lipidic din 12.03.2026.', 'TA 136/84 mmHg, AV 74/min.', 'Dislipidemie mixtă (LDL 3.8 mmol/L). Risc cardiovascular moderat.', 'Se începe rosuvastatină 10 mg seara. Regim hipolipemiant. Control peste 6 luni cu profil lipidic.') },
  { id: 'card1-rx', cycle: 'card1', provider: 'poli', doctor: 'popescu', date: '2026-03-26', label: 'Prescription: rosuvastatin',
    body: { kind: 'rx', title: 'Rețetă medicală', fields: f(['Data', '26.03.2026'], ['Diagnostic', 'Dislipidemie mixtă']), items: [{ drug: 'Rosuvastatină 10 mg comprimate', dose: '1 comprimat seara', how: '90 de zile' }], note: 'Rețetă compensată 50%.' } },
  { id: 'card2-consult', cycle: 'card2', provider: 'poli', doctor: 'popescu', date: '2026-09-10', label: 'Cardiology control visit 6 months on, asks lipids',
    body: consult('Fișă de consultație — control cardiologie', '2026-09-10', 'Cardiologie', 'Control la 6 luni de la începerea rosuvastatinei. Nu mai are dureri toracice.', 'TA 128/80 mmHg, AV 70/min.', 'Dislipidemie sub tratament cu statină, evoluție favorabilă clinic.', 'Recomand profil lipidic și transaminaze înainte de reevaluare, în aproximativ o săptămână.') },
  { id: 'card2-lab', cycle: 'card2', provider: 'lab', doctor: 'marinescu', date: '2026-09-15', label: 'Lipid panel on a statin: improved',
    body: { kind: 'lab', title: 'Buletin de analize medicale', fields: f(['Data recoltării', '15.09.2026'], ['Data rezultatului', '15.09.2026'], ['Medic trimițător', 'Dr. Popescu Ion, cardiologie']),
      groups: [{ heading: 'Profil lipidic', rows: [row('Colesterol total', '4.4', 'mmol/L', '< 5.2'), row('LDL colesterol', '2.4', 'mmol/L', '< 3.0'), row('HDL colesterol', '1.3', 'mmol/L', '> 1.0'), row('Trigliceride', '1.4', 'mmol/L', '< 1.7')] }, { heading: 'Biochimie', rows: [row('ALT (TGP)', '28', 'U/L', '< 41'), row('AST (TGO)', '24', 'U/L', '< 40')] }] } },
  { id: 'card2-control', cycle: 'card2', provider: 'poli', doctor: 'popescu', date: '2026-09-17', label: 'Cardiology control: continue the statin',
    body: consult('Fișă de consultație — control cardiologie', '2026-09-17', 'Cardiologie', 'Reevaluare cu profilul lipidic din 15.09.2026.', 'Fără modificări.', 'Dislipidemie controlată sub rosuvastatină (LDL 2.4 mmol/L).', 'Se continuă rosuvastatină 10 mg. Control anual.') },
  { id: 'dental-invoice', cycle: 'dental', provider: 'dental', doctor: null, date: '2026-02-20', label: 'Dental cleaning invoice, the day of the cardiology visit',
    body: { kind: 'invoice', title: 'Factură fiscală', fields: f(['Data', '20.02.2026'], ['Nr. factură', 'DS-2026-0388']), lines: [['Detartraj ultrasonic și periaj profesional', '1', '250.00'], ['Fluorizare', '1', '80.00']], total: '330.00' } },

  // ——— pneumonia: the family doctor, a radiograph, the hospital, a sick-leave certificate held twice ——
  { id: 'pneu-gp', cycle: 'pneu', provider: 'cabinet', doctor: 'ionescu', date: '2025-09-01', label: 'GP visit: fever and cough, sends to X-ray and hospital',
    body: consult('Fișă de consultație — medicină de familie', '2025-09-01', 'Medicină de familie', 'Febră 39°C de 3 zile, tuse productivă, junghi toracic stâng, astenie.', 'Temperatură 38.9°C, SpO₂ 93%, raluri crepitante bazal stâng. TA 125/80 mmHg.', 'Suspiciune de pneumonie comunitară.', 'Radiografie pulmonară în regim de urgență. Trimitere la Spitalul Județean pentru evaluare și internare. Concediu medical.') },
  { id: 'pneu-xray', cycle: 'pneu', provider: 'radio', doctor: 'toma', date: '2025-09-02', label: 'Chest X-ray: left lower lobe consolidation',
    body: { kind: 'imaging', modality: 'xray', title: 'Radiografie pulmonară față', fields: f(['Data examinării', '02.09.2025'], ['Medic trimițător', 'Dr. Ionescu Maria'], ['Indicație', 'Suspiciune pneumonie']), sections: [sec('Tehnică', 'Radiografie toracică postero-anterioară, inspir profund.'), sec('Descriere', 'Opacitate alveolară sistematizată în lobul inferior stâng cu bronhogramă aerică. Sinus costofrenic stâng ușor șters. Cord și mediastin în limite normale.'), sec('Concluzie', 'Aspect radiologic compatibil cu pneumonie lobară inferioară stângă. Control radiologic în 4–6 săptămâni.')] } },
  { id: 'pneu-discharge', cycle: 'pneu', provider: 'spital', doctor: 'neagu', date: '2025-09-08', label: 'Hospital discharge note (2 pages), admitted 3 Sept',
    body: { kind: 'discharge', title: 'Foaie de externare', fields: f(['Data internării', '03.09.2025'], ['Data externării', '08.09.2025'], ['Secția', 'Pneumologie'], ['Nr. foaie', 'FO-2025-18244']), pages: [
      [sec('Diagnostic la internare', 'Pneumonie comunitară lobară inferioară stângă.'), sec('Istoric', 'Pacient de 46 de ani, febră și tuse productivă de 4 zile, trimis de medicul de familie. SpO₂ 92% în aer ambiant la internare.'), sec('Evoluție', 'Sub antibioterapie intravenoasă cu ceftriaxonă 2 g/zi și oxigen suplimentar, febra a cedat în 48 de ore, SpO₂ 97% la externare.')],
      [sec('Diagnostic la externare', 'Pneumonie comunitară lobară inferioară stângă, vindecare clinică.'), sec('Recomandări la externare', 'Amoxicilină-acid clavulanic 1 g de 2 ori pe zi, 7 zile. Repaus 10 zile. Control la medicul de familie în 2 săptămâni. Radiografie pulmonară de control în 4–6 săptămâni.')]] } },
  { id: 'pneu-sick', cycle: 'pneu', provider: 'cas', doctor: 'neagu', date: '2025-09-08', docNo: '4471920', label: 'Sick-leave certificate for the admission',
    body: { kind: 'sickleave', series: 'CCMAB', code: 'J18.1', days: '17', fields: f(['Data eliberării', '08.09.2025'], ['Perioada', '01.09.2025 – 17.09.2025'], ['Motivul', 'Pneumonie lobară, internare 03.09–08.09.2025']) } },
  { id: 'pneu-sick-dup', cycle: 'pneu', provider: 'cas', doctor: 'neagu', date: '2025-09-08', docNo: '4471920', duplicateOf: 'pneu-sick', label: 'The same certificate, scanned again', body: { kind: 'letter', title: '', fields: [], sections: [] } },
  { id: 'pneu-gp-control', cycle: 'pneu', provider: 'cabinet', doctor: 'ionescu', date: '2025-09-22', label: 'GP follow-up after discharge: asks a control X-ray',
    body: consult('Fișă de consultație — control medicină de familie', '2025-09-22', 'Medicină de familie', 'Control la 2 săptămâni după externare. Tuse rară, fără febră.', 'SpO₂ 98%, murmur vezicular prezent bilateral, raluri absente.', 'Pneumonie lobară inferioară stângă în convalescență, evoluție bună.', 'Radiografie pulmonară de control la 6 săptămâni de la episod. Reluarea activității treptat.') },
  { id: 'pneu-xray2', cycle: 'pneu', provider: 'radio', doctor: 'toma', date: '2025-10-20', label: 'Control chest X-ray: resolved',
    body: { kind: 'imaging', modality: 'xray', title: 'Radiografie pulmonară față — control', fields: f(['Data examinării', '20.10.2025'], ['Medic trimițător', 'Dr. Ionescu Maria'], ['Indicație', 'Control după pneumonie']), sections: [sec('Tehnică', 'Radiografie toracică postero-anterioară, inspir profund. Comparativ cu examinarea din 02.09.2025.'), sec('Descriere', 'Opacitatea din lobul inferior stâng a dispărut. Sinusuri costofrenice libere. Cord și mediastin normale.'), sec('Concluzie', 'Rezoluția completă a imaginii de condensare pulmonară.')] } },

  // ——— urology ————————————————————————————————————————————————————————————————————————————————
  { id: 'uro-consult', cycle: 'uro', provider: 'uro', doctor: 'stan', date: '2026-03-04', label: 'Urology consult: asks urine culture and ultrasound',
    body: consult('Fișă de consultație — Urologie', '2026-03-04', 'Urologie', 'Disurie și polachiurie de 5 zile, usturimi la urinare, fără febră.', 'Loje renale nedureroase, hipogastru sensibil la palpare, uretră fără secreții.', 'Suspiciune de infecție urinară joasă.', 'Recomand urocultură cu antibiogramă și ecografie renală și vezicală. Control cu rezultatele.') },
  { id: 'uro-culture', cycle: 'uro', provider: 'lab', doctor: 'marinescu', date: '2026-03-06', label: 'Urine culture: E. coli',
    body: { kind: 'lab', title: 'Urocultură cu antibiogramă', fields: f(['Data recoltării', '06.03.2026'], ['Data rezultatului', '08.03.2026'], ['Medic trimițător', 'Dr. Stan Gabriel, urologie']), groups: [{ heading: 'Urocultură', rows: [row('Escherichia coli', '> 100000', 'UFC/mL', '< 10000', 'H'), row('Leucocite în sediment', '28', '/câmp', '< 5', 'H')] }, { heading: 'Antibiogramă', rows: [row('Nitrofurantoin', 'Sensibil', '', ''), row('Ciprofloxacină', 'Sensibil', '', ''), row('Trimetoprim-sulfametoxazol', 'Rezistent', '', '')] }] } },
  { id: 'uro-echo', cycle: 'uro', provider: 'radio', doctor: 'toma', date: '2026-03-09', label: 'Renal and bladder ultrasound: normal',
    body: { kind: 'imaging', modality: 'echo', title: 'Ecografie renală și vezicală', fields: f(['Data examinării', '09.03.2026'], ['Medic trimițător', 'Dr. Stan Gabriel'], ['Indicație', 'Disurie']), sections: [sec('Descriere', 'Rinichi de dimensiuni și ecostructură normale bilateral, fără dilatații pielocaliceale sau calculi. Vezică urinară cu pereți ușor îngroșați, fără reziduu postmicțional semnificativ.'), sec('Concluzie', 'Aspect ecografic compatibil cu cistită. Fără litiază sau uropatie obstructivă.')] } },
  { id: 'uro-control', cycle: 'uro', provider: 'uro', doctor: 'stan', date: '2026-03-18', label: 'Urology control: antibiotic by the antibiogram',
    body: consult('Fișă de consultație — control urologie', '2026-03-18', 'Urologie', 'Control cu urocultura din 06.03.2026 și ecografia din 09.03.2026.', 'Hipogastru nedureros, simptomatologie în ameliorare.', 'Cistită acută cu E. coli, fără complicații.', 'Nitrofurantoin 100 mg de 2 ori pe zi, 7 zile. Hidratare. Control doar la reapariția simptomelor.') },
  { id: 'uro-rx', cycle: 'uro', provider: 'uro', doctor: 'stan', date: '2026-03-18', label: 'Prescription: nitrofurantoin',
    body: { kind: 'rx', title: 'Rețetă medicală', fields: f(['Data', '18.03.2026'], ['Diagnostic', 'Cistită acută']), items: [{ drug: 'Nitrofurantoin 100 mg capsule', dose: '1 capsulă de 2 ori pe zi', how: '7 zile, după mese' }] } },
  { id: 'uro-claim', cycle: 'uro', provider: 'uro', doctor: null, date: '2026-03-18', label: 'Invoice for the urology visits',
    body: { kind: 'invoice', title: 'Decont de cheltuieli', fields: f(['Data', '18.03.2026'], ['Nr.', 'UM-2026-0112']), lines: [['Consultație urologie, 04.03.2026', '1', '300.00'], ['Consultație control urologie, 18.03.2026', '1', '250.00']], total: '550.00' } },

  // ——— a skin visit, alone ————————————————————————————————————————————————————————————————————
  { id: 'derm-consult', cycle: 'derm', provider: 'poli', doctor: 'dumitru', date: '2026-04-14', label: 'Dermatology: eczema, one visit',
    body: consult('Fișă de consultație — Dermatologie', '2026-04-14', 'Dermatovenerologie', 'Plăci eritematoase și pruriginoase pe coate și pe fața dorsală a mâinilor, de 3 săptămâni.', 'Plăci eritemato-scuamoase ușor lichenificate, fără suprainfecție.', 'Dermatită atopică, forma ușoară.', 'Emolient zilnic, corticoid topic 7 zile. Evitarea detergenților iritanți. Fără control programat.') },
  { id: 'derm-rx', cycle: 'derm', provider: 'poli', doctor: 'dumitru', date: '2026-04-14', label: 'Prescription: topical steroid',
    body: { kind: 'rx', title: 'Rețetă medicală', fields: f(['Data', '14.04.2026'], ['Diagnostic', 'Dermatită atopică']), items: [{ drug: 'Mometazonă furoat 0.1% cremă', dose: 'strat subțire, o dată pe zi', how: '7 zile, pe zonele afectate' }, { drug: 'Emolient cu uree 5%', dose: 'de 2 ori pe zi', how: 'zilnic, pe tot corpul' }] } },

  // ——— an annual panel, with tests that belong to other stories ————————————————————————————————
  { id: 'annual-lab', cycle: 'annual', provider: 'lab', doctor: 'marinescu', date: '2025-12-15', label: 'Annual check-up panel (includes TSH, lipids, glucose)',
    body: { kind: 'lab', title: 'Buletin de analize medicale — control anual', fields: f(['Data recoltării', '15.12.2025'], ['Data rezultatului', '15.12.2025'], ['Medic trimițător', 'Dr. Ionescu Maria, medicină de familie']),
      groups: [{ heading: 'Hematologie', rows: [row('Hemoglobină', '14.8', 'g/dL', '13.5 – 17.5'), row('Leucocite', '6.1', '×10⁹/L', '4.0 – 10.0'), row('Trombocite', '238', '×10⁹/L', '150 – 400')] }, { heading: 'Biochimie', rows: [row('Glucoză', '5.0', 'mmol/L', '3.9 – 5.6'), row('Colesterol total', '5.1', 'mmol/L', '< 5.2'), row('Creatinină', '84', 'µmol/L', '60 – 110'), row('TSH', '2.1', 'µUI/mL', '0.40 – 4.00')] }] } },
  { id: 'annual-gp', cycle: 'annual', provider: 'cabinet', doctor: 'ionescu', date: '2025-12-19', label: 'GP annual review of that panel',
    body: consult('Fișă de consultație — control anual', '2025-12-19', 'Medicină de familie', 'Control anual, fără acuze. Analize recoltate la 15.12.2025.', 'TA 122/78 mmHg, AV 68/min, IMC 26.1. Examen clinic normal.', 'Persoană sănătoasă. Analizele anuale în limite normale.', 'Fără recomandări suplimentare. Reevaluare peste 12 luni.') },
];

/**
 * What is true of the archive. A care cycle is one story: a visit, what it asked for, what answered it, and the visit that read the answers. The three thyroid cycles are linked to each other as follow-ups
 * (each control visit leads to the next consult) but they are three episodes a year apart, not one. Pairs in `NEVER` are unrelated whatever the day, the clinic or the doctor say.
 */
export const GROUND_TRUTH = {
  /** The documents of each cycle, none counted twice. */
  cycles: (() => {
    const out: Record<string, string[]> = {};
    for (const d of DOCS) if (!d.duplicateOf) (out[d.cycle] ??= []).push(d.id);
    return out;
  })(),
  /**
   * The cycles of one chronic condition, in order. A document of one cycle may be linked to one of the next (the second visit follows up the first, a request for a test in five months is
   * answered by the next cycle's lab), but never to a cycle two steps away, and a cycle is never merged into the next as one episode.
   */
  conditionChains: [['thy1', 'thy2', 'thy3'], ['card1', 'card2']] as Cycle[][],
  /** Other links between cycles that are real. */
  crossCycle: [] as Array<[string, string]>,
  /** Never linked: the same day, the same clinic, the same lab, the same words, or a copy. */
  never: [
    ['eye-consult', 'thy2-lab'], ['eye-glasses', 'thy2-lab'], ['eye-consult', 'thy2-consult'], ['eye-consult', 'thy2-control'], ['eye-glasses', 'thy2-rx'],
    ['dental-invoice', 'card1-consult'], ['dental-invoice', 'card1-ecg'],
    ['derm-consult', 'card1-control'], ['derm-rx', 'thy2-rx'],
    ['annual-lab', 'card1-lab'], ['annual-lab', 'thy1-lab'], ['annual-lab', 'thy2-lab'], ['annual-gp', 'thy3-control'],
    ['pneu-gp', 'thy2-control'], ['pneu-xray', 'thy2-lab'], ['uro-culture', 'card1-lab'], ['uro-claim', 'dental-invoice'],
  ] as Array<[string, string]>,
  /** Pairs that are a matter of taste, and are not marked either way. */
  ambiguous: [['annual-lab', 'thy3-lab'], ['annual-lab', 'thy3-control'], ['uro-claim', 'uro-consult'], ['uro-claim', 'uro-control'], ['uro-claim', 'uro-rx']] as Array<[string, string]>,
  /** The longest a proposed episode may span, in days: a care cycle is weeks, a course of treatment a few months, never a year. */
  maxEpisodeDays: 120,
};

const providerOf = (d: DocSpec) => PROVIDERS[d.provider]!;
export function pageOf(d: DocSpec, byId: Map<string, DocSpec>): Page {
  const base = d.duplicateOf ? byId.get(d.duplicateOf)! : d;
  return {
    provider: providerOf(base), patient: PATIENT, date: base.date, doctor: base.doctor ? DOCTORS[base.doctor] : null, body: base.body,
    docNo: base.docNo ?? `${base.provider.toUpperCase().slice(0, 3)}-${base.date.replace(/-/g, '')}-${(base.id.length * 37 % 900) + 100}`,
    ...(d.duplicateOf ? { scan: true } : {}),
  };
}

export interface Expected {
  /** Any of these is right for the kind of document. */
  types: Array<'lab_result' | 'discharge_note' | 'vaccination' | 'imaging' | 'prescription' | 'consultation_note' | 'other'>;
  date: string;
  /** Words the provider's name must contain once accents and case are set aside. */
  providerWords: string[];
  doctorSurname: string | null;
  /** The numbers a lab report holds: the test's first word and the value as printed. */
  values: Array<{ test: string; value: string; flag: 'high' | 'low' | null }>;
}

const PROVIDER_WORDS: Record<string, string[]> = {
  poli: ['sanatatea'], lab: ['medislab'], spital: ['spitalul', 'exemplu'], cabinet: ['ionescu'], radio: ['radio'], uro: ['uromed'], dental: ['dental', 'smile'], cas: ['spitalul', 'exemplu'],
};

/** What a good reading of a document finds, from the values it was drawn from. */
export function expectedOf(d: DocSpec, byId: Map<string, DocSpec>): Expected {
  const base = d.duplicateOf ? byId.get(d.duplicateOf)! : d;
  const kind = base.body.kind;
  const types: Expected['types'] = kind === 'lab' ? ['lab_result'] : kind === 'imaging' || kind === 'ecg' ? ['imaging', 'other'] : kind === 'rx' ? ['prescription', 'other']
    : kind === 'discharge' ? ['discharge_note'] : kind === 'letter' ? ['consultation_note'] : ['other'];
  const values = base.body.kind === 'lab'
    ? base.body.groups.flatMap(g => g.rows).filter(r => /^[<>]?\s*[0-9]/.test(r.value)).map(r => ({ test: r.name, value: r.value.replace(/^[<>]\s*/, ''), flag: r.flag === 'H' ? ('high' as const) : r.flag === 'L' ? ('low' as const) : null }))
    : [];
  return { types, date: base.date, providerWords: PROVIDER_WORDS[base.provider] ?? [], doctorSurname: base.doctor ? DOCTORS[base.doctor].name.replace(/^Dr\.\s*/, '').split(' ')[0]!.toLowerCase() : null, values };
}
