/**
 * What the sample archive says about each document in the app's own words, and the translations of it that were written by hand, so the demo shows translation working with no model: the
 * title and summary of each document, the short facts read from it (the diagnosis, the plan), the names of the tests, the doctors' specialties. The Romanian is the original (the documents are
 * Romanian); English, French and German are what the app would show a reader in those languages. The app keeps a translation under a digest of exactly these texts (`translation.ts`), so the
 * demo stores these as what a translation made it would be.
 */
export type Lang = 'ro' | 'en' | 'fr' | 'de';
export type Quad = [ro: string, en: string, fr: string, de: string];
export type Trio = [en: string, fr: string, de: string];

export interface DocWords {
  title: Quad;
  summary: Quad;
  /** The facts read from the document, by label; the Romanian is the document's own text, so only the translations are given. */
  facts?: Record<string, Trio>;
}
const d = (title: Quad, summary: Quad, facts?: Record<string, Trio>): DocWords => ({ title, summary, ...(facts ? { facts } : {}) });

export const WORDS: Record<string, DocWords> = {
  // ——— thyroid, first cycle ———
  'thy1-consult': d(
    ['Consultație endocrinologie — suspiciune de hipotiroidism', 'Endocrinology consultation — suspected hypothyroidism', 'Consultation d’endocrinologie — hypothyroïdie suspectée', 'Endokrinologische Konsultation — Verdacht auf Hypothyreose'],
    ['Oboseală, creștere în greutate și frilozitate; medicul suspectează hipotiroidism și cere TSH, FT4 și anticorpi anti-TPO.', 'Tiredness, weight gain and feeling cold; the doctor suspects hypothyroidism and asks for TSH, FT4 and anti-TPO antibodies.', 'Fatigue, prise de poids et frilosité ; le médecin suspecte une hypothyroïdie et demande TSH, FT4 et anticorps anti-TPO.', 'Müdigkeit, Gewichtszunahme und Kälteempfindlichkeit; die Ärztin vermutet eine Hypothyreose und bittet um TSH, fT4 und Anti-TPO-Antikörper.'],
    { diagnosis: ['Suspected hypothyroidism. Laboratory confirmation needed.', 'Suspicion d’hypothyroïdie. Confirmation par le laboratoire nécessaire.', 'Verdacht auf Hypothyreose. Laborbestätigung erforderlich.'],
      follow_up: ['TSH, FT4 and anti-TPO antibodies, drawn in the morning on an empty stomach. Return with the results in 1–2 weeks.', 'TSH, FT4 et anticorps anti-TPO, prélevés le matin à jeun. Revenir avec les résultats dans 1 à 2 semaines.', 'TSH, fT4 und Anti-TPO-Antikörper, morgens nüchtern abgenommen. Wiedervorstellung mit den Ergebnissen in 1–2 Wochen.'] }),
  'thy1-lab': d(
    ['Analize hormoni tiroidieni — TSH crescut', 'Thyroid hormone tests — TSH high', 'Bilan des hormones thyroïdiennes — TSH élevée', 'Schilddrüsenwerte — TSH erhöht'],
    ['TSH 9,80 µUI/mL (crescut) și FT4 0,71 ng/dL (scăzut); anticorpi anti-TPO în limite.', 'TSH 9.80 µIU/mL (high) and FT4 0.71 ng/dL (low); anti-TPO antibodies within range.', 'TSH 9,80 µUI/mL (élevée) et FT4 0,71 ng/dL (basse) ; anticorps anti-TPO dans les limites.', 'TSH 9,80 µIE/mL (erhöht) und fT4 0,71 ng/dL (erniedrigt); Anti-TPO-Antikörper im Normbereich.']),
  'thy1-control': d(
    ['Control endocrinologie — începe tratamentul cu levotiroxină', 'Endocrinology follow-up — levothyroxine started', 'Contrôle d’endocrinologie — début de la lévothyroxine', 'Endokrinologische Kontrolle — Beginn von Levothyroxin'],
    ['Cu rezultatele în față, medicul pune diagnosticul de hipotiroidism primar și începe levotiroxină 50 mcg; control peste 3 luni.', 'With the results in hand, the doctor diagnoses primary hypothyroidism and starts levothyroxine 50 mcg; review in 3 months.', 'Les résultats en main, le médecin pose le diagnostic d’hypothyroïdie primaire et commence la lévothyroxine 50 mcg ; contrôle dans 3 mois.', 'Mit den Ergebnissen stellt der Arzt die Diagnose primäre Hypothyreose und beginnt Levothyroxin 50 mcg; Kontrolle in 3 Monaten.'],
    { diagnosis: ['Primary hypothyroidism (TSH 9.80 µIU/mL). Replacement treatment started.', 'Hypothyroïdie primaire (TSH 9,80 µUI/mL). Traitement substitutif commencé.', 'Primäre Hypothyreose (TSH 9,80 µIE/mL). Substitutionstherapie begonnen.'],
      follow_up: ['Levothyroxine 50 mcg in the morning on an empty stomach. Review in 3 months with TSH and FT4.', 'Lévothyroxine 50 mcg le matin à jeun. Contrôle dans 3 mois avec TSH et FT4.', 'Levothyroxin 50 mcg morgens nüchtern. Kontrolle in 3 Monaten mit TSH und fT4.'] }),
  'thy1-rx': d(
    ['Rețetă — levotiroxină 50 mcg', 'Prescription — levothyroxine 50 mcg', 'Ordonnance — lévothyroxine 50 mcg', 'Rezept — Levothyroxin 50 mcg'],
    ['Levotiroxină sodică 50 mcg, un comprimat dimineața pe nemâncate, 90 de zile.', 'Levothyroxine sodium 50 mcg, one tablet in the morning on an empty stomach, 90 days.', 'Lévothyroxine sodique 50 mcg, un comprimé le matin à jeun, 90 jours.', 'Levothyroxin-Natrium 50 mcg, eine Tablette morgens nüchtern, 90 Tage.'],
    { instructions: ['Levothyroxine sodium 50 mcg tablets — 1 tablet in the morning, on an empty stomach, 30 minutes before breakfast, 90 days', 'Lévothyroxine sodique 50 mcg comprimés — 1 comprimé le matin, à jeun, 30 minutes avant le petit-déjeuner, 90 jours', 'Levothyroxin-Natrium 50 mcg Tabletten — 1 Tablette morgens, nüchtern, 30 Minuten vor dem Frühstück, 90 Tage'] }),
  // ——— thyroid, second cycle ———
  'thy2-consult': d(
    ['Control endocrinologie — la 3 luni de tratament', 'Endocrinology follow-up — 3 months into treatment', 'Contrôle d’endocrinologie — à 3 mois de traitement', 'Endokrinologische Kontrolle — nach 3 Monaten Behandlung'],
    ['Pacientul se simte mai bine sub levotiroxină 50 mcg; medicul cere TSH și FT4 înainte de următorul control.', 'The patient feels better on levothyroxine 50 mcg; the doctor asks for TSH and FT4 before the next review.', 'Le patient se sent mieux sous lévothyroxine 50 mcg ; le médecin demande TSH et FT4 avant le prochain contrôle.', 'Der Patient fühlt sich unter Levothyroxin 50 mcg besser; der Arzt bittet vor der nächsten Kontrolle um TSH und fT4.'],
    { diagnosis: ['Primary hypothyroidism on treatment, favourable course.', 'Hypothyroïdie primaire sous traitement, évolution favorable.', 'Primäre Hypothyreose unter Therapie, günstiger Verlauf.'],
      follow_up: ['Continue levothyroxine 50 mcg. TSH and FT4 before the next review, in about a week.', 'Poursuivre la lévothyroxine 50 mcg. TSH et FT4 avant le prochain contrôle, dans environ une semaine.', 'Levothyroxin 50 mcg fortsetzen. TSH und fT4 vor der nächsten Kontrolle, in etwa einer Woche.'] }),
  'thy2-lab': d(
    ['Analize hormoni tiroidieni — TSH încă ușor crescut', 'Thyroid hormone tests — TSH still slightly high', 'Bilan des hormones thyroïdiennes — TSH encore légèrement élevée', 'Schilddrüsenwerte — TSH noch leicht erhöht'],
    ['TSH 5,10 µUI/mL, încă ușor crescut; FT4 normal; recoltat la laboratorul propriu al policlinicii.', 'TSH 5.10 µIU/mL, still slightly high; FT4 normal; drawn at the polyclinic’s own laboratory.', 'TSH 5,10 µUI/mL, encore légèrement élevée ; FT4 normale ; prélevé au laboratoire de la polyclinique.', 'TSH 5,10 µIE/mL, noch leicht erhöht; fT4 normal; in dem poliklinikeigenen Labor abgenommen.']),
  'thy2-control': d(
    ['Control endocrinologie — doza crește la 75 mcg', 'Endocrinology follow-up — dose raised to 75 mcg', 'Contrôle d’endocrinologie — dose portée à 75 mcg', 'Endokrinologische Kontrolle — Dosis auf 75 mcg erhöht'],
    ['TSH încă ușor crescut; medicul crește levotiroxina la 75 mcg și programează controlul peste 5 luni.', 'TSH is still slightly high; the doctor raises levothyroxine to 75 mcg and schedules the next review in 5 months.', 'La TSH reste légèrement élevée ; le médecin augmente la lévothyroxine à 75 mcg et prévoit le contrôle dans 5 mois.', 'Die TSH ist noch leicht erhöht; der Arzt erhöht Levothyroxin auf 75 mcg und plant die Kontrolle in 5 Monaten.'],
    { diagnosis: ['Primary hypothyroidism, TSH still slightly high (5.10 µIU/mL).', 'Hypothyroïdie primaire, TSH encore légèrement élevée (5,10 µUI/mL).', 'Primäre Hypothyreose, TSH noch leicht erhöht (5,10 µIE/mL).'],
      follow_up: ['Raise levothyroxine to 75 mcg in the morning. Review in 5 months with TSH and FT4.', 'Porter la lévothyroxine à 75 mcg le matin. Contrôle dans 5 mois avec TSH et FT4.', 'Levothyroxin auf 75 mcg morgens erhöhen. Kontrolle in 5 Monaten mit TSH und fT4.'] }),
  'thy2-rx': d(
    ['Rețetă — levotiroxină 75 mcg', 'Prescription — levothyroxine 75 mcg', 'Ordonnance — lévothyroxine 75 mcg', 'Rezept — Levothyroxin 75 mcg'],
    ['Levotiroxină sodică 75 mcg, un comprimat dimineața, 150 de zile; înlocuiește doza de 50 mcg.', 'Levothyroxine sodium 75 mcg, one tablet in the morning, 150 days; replaces the 50 mcg dose.', 'Lévothyroxine sodique 75 mcg, un comprimé le matin, 150 jours ; remplace la dose de 50 mcg.', 'Levothyroxin-Natrium 75 mcg, eine Tablette morgens, 150 Tage; ersetzt die 50-mcg-Dosis.'],
    { instructions: ['Levothyroxine sodium 75 mcg tablets — 1 tablet in the morning, on an empty stomach, 150 days', 'Lévothyroxine sodique 75 mcg comprimés — 1 comprimé le matin, à jeun, 150 jours', 'Levothyroxin-Natrium 75 mcg Tabletten — 1 Tablette morgens, nüchtern, 150 Tage'] }),
  // ——— thyroid, third cycle ———
  'thy3-consult': d(
    ['Control endocrinologie — la 5 luni', 'Endocrinology follow-up — at 5 months', 'Contrôle d’endocrinologie — à 5 mois', 'Endokrinologische Kontrolle — nach 5 Monaten'],
    ['Control programat sub levotiroxină 75 mcg; stare clinică bună, medicul cere TSH și FT4 cu o săptămână înainte de reevaluare.', 'Scheduled review on levothyroxine 75 mcg; good clinical state, the doctor asks for TSH and FT4 a week before the reassessment.', 'Contrôle programmé sous lévothyroxine 75 mcg ; bon état clinique, le médecin demande TSH et FT4 une semaine avant la réévaluation.', 'Geplante Kontrolle unter Levothyroxin 75 mcg; guter klinischer Zustand, der Arzt bittet eine Woche vor der Neubeurteilung um TSH und fT4.'],
    { diagnosis: ['Primary hypothyroidism, clinically compensated.', 'Hypothyroïdie primaire, compensée cliniquement.', 'Primäre Hypothyreose, klinisch kompensiert.'],
      follow_up: ['Continue levothyroxine 75 mcg. TSH and FT4 one week before the reassessment.', 'Poursuivre la lévothyroxine 75 mcg. TSH et FT4 une semaine avant la réévaluation.', 'Levothyroxin 75 mcg fortsetzen. TSH und fT4 eine Woche vor der Neubeurteilung.'] }),
  'thy3-lab': d(
    ['Analize hormoni tiroidieni — în limite normale', 'Thyroid hormone tests — within normal limits', 'Bilan des hormones thyroïdiennes — dans les limites normales', 'Schilddrüsenwerte — im Normbereich'],
    ['TSH 2,30 µUI/mL și FT4 1,21 ng/dL, ambele în limite normale.', 'TSH 2.30 µIU/mL and FT4 1.21 ng/dL, both within normal limits.', 'TSH 2,30 µUI/mL et FT4 1,21 ng/dL, toutes deux dans les limites normales.', 'TSH 2,30 µIE/mL und fT4 1,21 ng/dL, beide im Normbereich.']),
  'thy3-control': d(
    ['Control endocrinologie — hipotiroidism compensat', 'Endocrinology follow-up — hypothyroidism compensated', 'Contrôle d’endocrinologie — hypothyroïdie compensée', 'Endokrinologische Kontrolle — Hypothyreose kompensiert'],
    ['TSH 2,30 µUI/mL; tratamentul rămâne neschimbat, următorul control peste 12 luni.', 'TSH 2.30 µIU/mL; treatment unchanged, next review in 12 months.', 'TSH 2,30 µUI/mL ; traitement inchangé, prochain contrôle dans 12 mois.', 'TSH 2,30 µIE/mL; Behandlung unverändert, nächste Kontrolle in 12 Monaten.'],
    { diagnosis: ['Primary hypothyroidism compensated (TSH 2.30 µIU/mL).', 'Hypothyroïdie primaire compensée (TSH 2,30 µUI/mL).', 'Primäre Hypothyreose kompensiert (TSH 2,30 µIE/mL).'],
      follow_up: ['Continue the same treatment. Review in 12 months or if symptoms appear.', 'Poursuivre le même traitement. Contrôle dans 12 mois ou si des symptômes apparaissent.', 'Dieselbe Behandlung fortsetzen. Kontrolle in 12 Monaten oder bei neuen Beschwerden.'] }),
  // ——— the eye ———
  'eye-consult': d(
    ['Consultație oftalmologie — miopie ușoară', 'Ophthalmology consultation — mild myopia', 'Consultation d’ophtalmologie — myopie légère', 'Augenärztliche Untersuchung — leichte Myopie'],
    ['Control de rutină pentru vedere încețoșată la distanță; miopie ușoară, fund de ochi normal, corecție optică prescrisă.', 'Routine check for blurred distance vision; mild myopia, normal fundus, optical correction prescribed.', 'Contrôle de routine pour une vision floue de loin ; myopie légère, fond d’œil normal, correction optique prescrite.', 'Routinekontrolle wegen verschwommenem Sehen in der Ferne; leichte Myopie, Augenhintergrund unauffällig, Brillenkorrektur verordnet.'],
    { diagnosis: ['Mild myopia, no signs of retinal damage.', 'Myopie légère, sans signe d’atteinte rétinienne.', 'Leichte Myopie, keine Anzeichen einer Netzhautschädigung.'],
      follow_up: ['Optical correction prescribed. Review in 24 months.', 'Correction optique prescrite. Contrôle dans 24 mois.', 'Brillenkorrektur verordnet. Kontrolle in 24 Monaten.'] }),
  'eye-glasses': d(
    ['Prescripție optică — ochelari pentru distanță', 'Optical prescription — glasses for distance', 'Prescription optique — lunettes pour la vision de loin', 'Brillenrezept — Fernbrille'],
    ['Corecție pentru distanță: ochiul drept −1,50 D, ochiul stâng −1,75 D, purtare permanentă.', 'Distance correction: right eye −1.50 D, left eye −1.75 D, to be worn all the time.', 'Correction de loin : œil droit −1,50 D, œil gauche −1,75 D, port permanent.', 'Fernkorrektur: rechtes Auge −1,50 dpt, linkes Auge −1,75 dpt, dauerhaft zu tragen.'],
    { instructions: ['Right eye: sphere −1.50 D, cylinder −0.25 D, axis 90°; left eye: sphere −1.75 D, cylinder −0.25 D, axis 85°; for distance, permanent wear', 'Œil droit : sphère −1,50 D, cylindre −0,25 D, axe 90° ; œil gauche : sphère −1,75 D, cylindre −0,25 D, axe 85° ; pour la vision de loin, port permanent', 'Rechtes Auge: Sphäre −1,50 dpt, Zylinder −0,25 dpt, Achse 90°; linkes Auge: Sphäre −1,75 dpt, Zylinder −0,25 dpt, Achse 85°; für die Ferne, dauerhaft zu tragen'] }),
  // ——— cardiology ———
  'card1-consult': d(
    ['Consultație cardiologie — durere toracică la efort', 'Cardiology consultation — chest pain on exertion', 'Consultation de cardiologie — douleur thoracique à l’effort', 'Kardiologische Konsultation — Brustschmerzen bei Belastung'],
    ['Dureri toracice la efort, cedează în repaus; medicul suspectează dislipidemie și cere EKG, profil lipidic și glicemie.', 'Chest pain on exertion that settles at rest; the doctor suspects dyslipidaemia and asks for an ECG, a lipid profile and glucose.', 'Douleurs thoraciques à l’effort qui cèdent au repos ; le médecin suspecte une dyslipidémie et demande un ECG, un bilan lipidique et la glycémie.', 'Brustschmerzen bei Belastung, die in Ruhe nachlassen; der Arzt vermutet eine Dyslipidämie und bittet um EKG, Lipidprofil und Glukose.'],
    { diagnosis: ['Atypical chest pain. Dyslipidaemia suspected. Cardiovascular risk to be assessed.', 'Douleur thoracique atypique. Dyslipidémie suspectée. Risque cardiovasculaire à évaluer.', 'Atypischer Brustschmerz. Verdacht auf Dyslipidämie. Kardiovaskuläres Risiko abzuklären.'],
      follow_up: ['Resting ECG and a full lipid profile (total cholesterol, LDL, HDL, triglycerides), glucose. Review with the results in 3–4 weeks.', 'ECG de repos et bilan lipidique complet (cholestérol total, LDL, HDL, triglycérides), glycémie. Contrôle avec les résultats dans 3 à 4 semaines.', 'Ruhe-EKG und vollständiges Lipidprofil (Gesamtcholesterin, LDL, HDL, Triglyceride), Glukose. Kontrolle mit den Ergebnissen in 3–4 Wochen.'] }),
  'card1-ecg': d(
    ['Electrocardiogramă de repaus — normală', 'Resting electrocardiogram — normal', 'Électrocardiogramme de repos — normal', 'Ruhe-Elektrokardiogramm — unauffällig'],
    ['Ritm sinusal 76/min, intervale normale, fără modificări ST-T.', 'Sinus rhythm 76/min, normal intervals, no ST-T changes.', 'Rythme sinusal 76/min, intervalles normaux, sans modification ST-T.', 'Sinusrhythmus 76/min, normale Intervalle, keine ST-T-Veränderungen.'],
    { impression: ['Normal resting ECG.', 'ECG de repos normal.', 'Unauffälliges Ruhe-EKG.'] }),
  'card1-lab': d(
    ['Profil lipidic — LDL crescut', 'Lipid profile — LDL high', 'Bilan lipidique — LDL élevé', 'Lipidprofil — LDL erhöht'],
    ['Colesterol total 5,9 și LDL 3,8 mmol/L, ambele crescute, trigliceride ușor crescute; glicemie și creatinină normale.', 'Total cholesterol 5.9 and LDL 3.8 mmol/L, both high, triglycerides slightly high; glucose and creatinine normal.', 'Cholestérol total 5,9 et LDL 3,8 mmol/L, tous deux élevés, triglycérides légèrement élevés ; glycémie et créatinine normales.', 'Gesamtcholesterin 5,9 und LDL 3,8 mmol/L, beide erhöht, Triglyceride leicht erhöht; Glukose und Kreatinin normal.']),
  'card1-control': d(
    ['Control cardiologie — începe rosuvastatina', 'Cardiology follow-up — rosuvastatin started', 'Contrôle de cardiologie — début de la rosuvastatine', 'Kardiologische Kontrolle — Beginn von Rosuvastatin'],
    ['Dislipidemie mixtă (LDL 3,8 mmol/L); medicul începe rosuvastatină 10 mg seara și programează control peste 6 luni.', 'Mixed dyslipidaemia (LDL 3.8 mmol/L); the doctor starts rosuvastatin 10 mg in the evening and schedules a review in 6 months.', 'Dyslipidémie mixte (LDL 3,8 mmol/L) ; le médecin commence la rosuvastatine 10 mg le soir et prévoit un contrôle dans 6 mois.', 'Gemischte Dyslipidämie (LDL 3,8 mmol/L); der Arzt beginnt Rosuvastatin 10 mg abends und plant eine Kontrolle in 6 Monaten.'],
    { diagnosis: ['Mixed dyslipidaemia (LDL 3.8 mmol/L). Moderate cardiovascular risk.', 'Dyslipidémie mixte (LDL 3,8 mmol/L). Risque cardiovasculaire modéré.', 'Gemischte Dyslipidämie (LDL 3,8 mmol/L). Mäßiges kardiovaskuläres Risiko.'],
      follow_up: ['Start rosuvastatin 10 mg in the evening. Lipid-lowering diet. Review in 6 months with a lipid profile.', 'Commencer la rosuvastatine 10 mg le soir. Régime hypolipémiant. Contrôle dans 6 mois avec un bilan lipidique.', 'Rosuvastatin 10 mg abends beginnen. Lipidsenkende Ernährung. Kontrolle in 6 Monaten mit Lipidprofil.'] }),
  'card1-rx': d(
    ['Rețetă — rosuvastatină 10 mg', 'Prescription — rosuvastatin 10 mg', 'Ordonnance — rosuvastatine 10 mg', 'Rezept — Rosuvastatin 10 mg'],
    ['Rosuvastatină 10 mg, un comprimat seara, 90 de zile.', 'Rosuvastatin 10 mg, one tablet in the evening, 90 days.', 'Rosuvastatine 10 mg, un comprimé le soir, 90 jours.', 'Rosuvastatin 10 mg, eine Tablette abends, 90 Tage.'],
    { instructions: ['Rosuvastatin 10 mg tablets — 1 tablet in the evening, 90 days', 'Rosuvastatine 10 mg comprimés — 1 comprimé le soir, 90 jours', 'Rosuvastatin 10 mg Tabletten — 1 Tablette abends, 90 Tage'] }),
  'card2-consult': d(
    ['Control cardiologie — la 6 luni de statină', 'Cardiology follow-up — 6 months on a statin', 'Contrôle de cardiologie — à 6 mois de statine', 'Kardiologische Kontrolle — 6 Monate unter Statin'],
    ['Fără dureri toracice sub rosuvastatină; medicul cere profil lipidic și transaminaze înainte de reevaluare.', 'No chest pain on rosuvastatin; the doctor asks for a lipid profile and transaminases before the reassessment.', 'Plus de douleurs thoraciques sous rosuvastatine ; le médecin demande un bilan lipidique et les transaminases avant la réévaluation.', 'Keine Brustschmerzen unter Rosuvastatin; der Arzt bittet vor der Neubeurteilung um Lipidprofil und Transaminasen.'],
    { diagnosis: ['Dyslipidaemia on statin treatment, clinically favourable course.', 'Dyslipidémie sous statine, évolution clinique favorable.', 'Dyslipidämie unter Statintherapie, klinisch günstiger Verlauf.'],
      follow_up: ['Lipid profile and transaminases before the reassessment, in about a week.', 'Bilan lipidique et transaminases avant la réévaluation, dans environ une semaine.', 'Lipidprofil und Transaminasen vor der Neubeurteilung, in etwa einer Woche.'] }),
  'card2-lab': d(
    ['Profil lipidic sub statină — îmbunătățit', 'Lipid profile on a statin — improved', 'Bilan lipidique sous statine — amélioré', 'Lipidprofil unter Statin — gebessert'],
    ['Colesterol total 4,4 și LDL 2,4 mmol/L, acum în limite; trigliceride normale; ALT și AST normale.', 'Total cholesterol 4.4 and LDL 2.4 mmol/L, now within range; triglycerides normal; ALT and AST normal.', 'Cholestérol total 4,4 et LDL 2,4 mmol/L, maintenant dans les limites ; triglycérides normaux ; ALAT et ASAT normales.', 'Gesamtcholesterin 4,4 und LDL 2,4 mmol/L, jetzt im Normbereich; Triglyceride normal; ALT und AST normal.']),
  'card2-control': d(
    ['Control cardiologie — dislipidemie controlată', 'Cardiology follow-up — dyslipidaemia controlled', 'Contrôle de cardiologie — dyslipidémie contrôlée', 'Kardiologische Kontrolle — Dyslipidämie kontrolliert'],
    ['LDL 2,4 mmol/L sub rosuvastatină; se continuă tratamentul, control anual.', 'LDL 2.4 mmol/L on rosuvastatin; treatment continues, yearly review.', 'LDL 2,4 mmol/L sous rosuvastatine ; le traitement se poursuit, contrôle annuel.', 'LDL 2,4 mmol/L unter Rosuvastatin; die Behandlung wird fortgesetzt, jährliche Kontrolle.'],
    { diagnosis: ['Dyslipidaemia controlled on rosuvastatin (LDL 2.4 mmol/L).', 'Dyslipidémie contrôlée sous rosuvastatine (LDL 2,4 mmol/L).', 'Dyslipidämie unter Rosuvastatin kontrolliert (LDL 2,4 mmol/L).'],
      follow_up: ['Continue rosuvastatin 10 mg. Yearly review.', 'Poursuivre la rosuvastatine 10 mg. Contrôle annuel.', 'Rosuvastatin 10 mg fortsetzen. Jährliche Kontrolle.'] }),
  'dental-invoice': d(
    ['Factură stomatologie — detartraj', 'Dental invoice — scaling', 'Facture dentaire — détartrage', 'Zahnarztrechnung — Zahnreinigung'],
    ['Detartraj ultrasonic, periaj profesional și fluorizare; total 330,00 RON.', 'Ultrasonic scaling, professional polishing and fluoride; total 330.00 RON.', 'Détartrage aux ultrasons, polissage professionnel et fluoration ; total 330,00 RON.', 'Ultraschall-Zahnsteinentfernung, professionelle Politur und Fluoridierung; Gesamtbetrag 330,00 RON.'],
    { summary: ['Ultrasonic scaling and professional polishing; fluoride application', 'Détartrage aux ultrasons et polissage professionnel ; application de fluor', 'Ultraschall-Zahnsteinentfernung und professionelle Politur; Fluoridierung'] }),
  // ——— pneumonia ———
  'pneu-gp': d(
    ['Consultație medic de familie — suspiciune de pneumonie', 'Family doctor visit — suspected pneumonia', 'Consultation du médecin de famille — suspicion de pneumonie', 'Hausarztbesuch — Verdacht auf Lungenentzündung'],
    ['Febră 39°C și tuse productivă de 3 zile; medicul suspectează pneumonie, cere radiografie de urgență, trimite la spital și dă concediu medical.', 'Fever 39°C and a productive cough for 3 days; the doctor suspects pneumonia, orders an urgent X-ray, refers to the hospital and gives sick leave.', 'Fièvre à 39°C et toux productive depuis 3 jours ; le médecin suspecte une pneumonie, demande une radiographie en urgence, adresse à l’hôpital et délivre un arrêt maladie.', 'Fieber 39°C und produktiver Husten seit 3 Tagen; der Arzt vermutet eine Lungenentzündung, ordnet ein dringendes Röntgen an, überweist ins Krankenhaus und schreibt krank.'],
    { diagnosis: ['Suspected community-acquired pneumonia.', 'Suspicion de pneumonie communautaire.', 'Verdacht auf ambulant erworbene Lungenentzündung.'],
      follow_up: ['Urgent chest X-ray. Referral to the County Hospital for assessment and admission. Sick leave.', 'Radiographie pulmonaire en urgence. Adressage à l’hôpital départemental pour évaluation et hospitalisation. Arrêt maladie.', 'Dringendes Thoraxröntgen. Überweisung ins Kreiskrankenhaus zur Abklärung und Aufnahme. Krankschreibung.'] }),
  'pneu-xray': d(
    ['Radiografie pulmonară — condensare lobul inferior stâng', 'Chest X-ray — left lower lobe consolidation', 'Radiographie pulmonaire — condensation du lobe inférieur gauche', 'Thoraxröntgen — Verdichtung im linken Unterlappen'],
    ['Opacitate alveolară în lobul inferior stâng, compatibilă cu pneumonie; control radiologic în 4–6 săptămâni.', 'Alveolar opacity in the left lower lobe, consistent with pneumonia; follow-up X-ray in 4–6 weeks.', 'Opacité alvéolaire du lobe inférieur gauche, compatible avec une pneumonie ; radiographie de contrôle dans 4 à 6 semaines.', 'Alveoläre Verdichtung im linken Unterlappen, vereinbar mit einer Lungenentzündung; Röntgenkontrolle in 4–6 Wochen.'],
    { impression: ['Radiological appearance consistent with left lower lobar pneumonia. Follow-up X-ray in 4–6 weeks.', 'Aspect radiologique compatible avec une pneumonie lobaire inférieure gauche. Radiographie de contrôle dans 4 à 6 semaines.', 'Röntgenbefund vereinbar mit einer Pneumonie des linken Unterlappens. Röntgenkontrolle in 4–6 Wochen.'] }),
  'pneu-discharge': d(
    ['Foaie de externare — pneumonie, 3–8 septembrie', 'Hospital discharge note — pneumonia, 3–8 September', 'Compte rendu d’hospitalisation — pneumonie, du 3 au 8 septembre', 'Entlassungsbrief — Lungenentzündung, 3.–8. September'],
    ['Internat cinci zile pentru pneumonie lobară inferioară stângă; evoluție favorabilă sub ceftriaxonă, externat vindecat clinic.', 'Admitted for five days with left lower lobe pneumonia; favourable course on ceftriaxone, discharged clinically cured.', 'Hospitalisé cinq jours pour une pneumonie du lobe inférieur gauche ; évolution favorable sous ceftriaxone, sorti cliniquement guéri.', 'Fünf Tage stationär wegen Pneumonie des linken Unterlappens; günstiger Verlauf unter Ceftriaxon, klinisch geheilt entlassen.'],
    { diagnosis: ['Community-acquired left lower lobe pneumonia, clinical recovery.', 'Pneumonie communautaire du lobe inférieur gauche, guérison clinique.', 'Ambulant erworbene Pneumonie des linken Unterlappens, klinische Heilung.'],
      follow_up: ['Amoxicillin-clavulanic acid 1 g twice a day for 7 days. Rest for 10 days. Family doctor review in 2 weeks. Control chest X-ray in 4–6 weeks.', 'Amoxicilline-acide clavulanique 1 g deux fois par jour pendant 7 jours. Repos 10 jours. Contrôle chez le médecin de famille dans 2 semaines. Radiographie pulmonaire de contrôle dans 4 à 6 semaines.', 'Amoxicillin-Clavulansäure 1 g zweimal täglich für 7 Tage. Ruhe für 10 Tage. Kontrolle beim Hausarzt in 2 Wochen. Röntgenkontrolle des Thorax in 4–6 Wochen.'] }),
  'pneu-sick': d(
    ['Certificat de concediu medical — 17 zile', 'Sick-leave certificate — 17 days', 'Certificat d’arrêt maladie — 17 jours', 'Krankschreibung — 17 Tage'],
    ['Concediu medical de 17 zile (1–17 septembrie 2025) pentru pneumonie lobară, cu internare între 3 și 8 septembrie.', 'Sick leave of 17 days (1–17 September 2025) for lobar pneumonia, with admission between 3 and 8 September.', 'Arrêt maladie de 17 jours (du 1er au 17 septembre 2025) pour pneumonie lobaire, avec hospitalisation du 3 au 8 septembre.', 'Krankschreibung für 17 Tage (1.–17. September 2025) wegen Lobärpneumonie, mit stationärem Aufenthalt vom 3. bis 8. September.'],
    { diagnosis: ['Lobar pneumonia, admission 3–8 September 2025', 'Pneumonie lobaire, hospitalisation du 3 au 8 septembre 2025', 'Lobärpneumonie, stationäre Aufnahme 3.–8. September 2025'] }),
  'pneu-gp-control': d(
    ['Control medic de familie — convalescență după pneumonie', 'Family doctor follow-up — recovering from pneumonia', 'Contrôle du médecin de famille — convalescence après la pneumonie', 'Hausarztkontrolle — Erholung nach der Lungenentzündung'],
    ['Evoluție bună după externare; medicul cere radiografie pulmonară de control și reluarea treptată a activității.', 'Good progress after discharge; the doctor asks for a control chest X-ray and a gradual return to activity.', 'Bonne évolution après la sortie ; le médecin demande une radiographie pulmonaire de contrôle et une reprise progressive de l’activité.', 'Guter Verlauf nach der Entlassung; der Arzt bittet um eine Röntgenkontrolle des Thorax und eine schrittweise Wiederaufnahme der Aktivität.'],
    { diagnosis: ['Left lower lobe pneumonia in convalescence, good course.', 'Pneumonie du lobe inférieur gauche en convalescence, bonne évolution.', 'Pneumonie des linken Unterlappens in der Erholungsphase, guter Verlauf.'],
      follow_up: ['Control chest X-ray at 6 weeks from the episode. Gradual return to activity.', 'Radiographie pulmonaire de contrôle 6 semaines après l’épisode. Reprise progressive de l’activité.', 'Röntgenkontrolle des Thorax 6 Wochen nach der Episode. Schrittweise Wiederaufnahme der Aktivität.'] }),
  'pneu-xray2': d(
    ['Radiografie pulmonară de control — rezoluție completă', 'Control chest X-ray — complete resolution', 'Radiographie pulmonaire de contrôle — résolution complète', 'Röntgenkontrolle des Thorax — vollständige Rückbildung'],
    ['Opacitatea din lobul inferior stâng a dispărut; sinusuri libere, cord și mediastin normale.', 'The opacity in the left lower lobe has gone; clear costophrenic angles, normal heart and mediastinum.', 'L’opacité du lobe inférieur gauche a disparu ; culs-de-sac libres, cœur et médiastin normaux.', 'Die Verdichtung im linken Unterlappen ist verschwunden; freie Rezessus, Herz und Mediastinum unauffällig.'],
    { impression: ['Complete resolution of the lung consolidation.', 'Résolution complète de l’image de condensation pulmonaire.', 'Vollständige Rückbildung der Lungenverdichtung.'] }),
  // ——— urology ———
  'uro-consult': d(
    ['Consultație urologie — disurie', 'Urology consultation — painful urination', 'Consultation d’urologie — dysurie', 'Urologische Konsultation — Dysurie'],
    ['Usturimi la urinare și urinări dese de 5 zile, fără febră; suspiciune de infecție urinară, se cer urocultură și ecografie.', 'Burning on urination and frequent urination for 5 days, no fever; urinary tract infection suspected, a urine culture and an ultrasound are requested.', 'Brûlures mictionnelles et mictions fréquentes depuis 5 jours, sans fièvre ; infection urinaire suspectée, une uroculture et une échographie sont demandées.', 'Brennen beim Wasserlassen und häufiger Harndrang seit 5 Tagen, kein Fieber; Verdacht auf Harnwegsinfekt, Urinkultur und Ultraschall werden angefordert.'],
    { diagnosis: ['Suspected lower urinary tract infection.', 'Suspicion d’infection urinaire basse.', 'Verdacht auf unteren Harnwegsinfekt.'],
      follow_up: ['Urine culture with antibiogram and a renal and bladder ultrasound. Review with the results.', 'Uroculture avec antibiogramme et échographie rénale et vésicale. Contrôle avec les résultats.', 'Urinkultur mit Antibiogramm und Ultraschall von Nieren und Blase. Kontrolle mit den Ergebnissen.'] }),
  'uro-culture': d(
    ['Urocultură cu antibiogramă — E. coli', 'Urine culture with antibiogram — E. coli', 'Uroculture avec antibiogramme — E. coli', 'Urinkultur mit Antibiogramm — E. coli'],
    ['Escherichia coli peste 100.000 UFC/mL; sensibil la nitrofurantoin și ciprofloxacină, rezistent la trimetoprim-sulfametoxazol.', 'Escherichia coli above 100,000 CFU/mL; sensitive to nitrofurantoin and ciprofloxacin, resistant to trimethoprim-sulfamethoxazole.', 'Escherichia coli au-dessus de 100 000 UFC/mL ; sensible à la nitrofurantoïne et à la ciprofloxacine, résistant au triméthoprime-sulfaméthoxazole.', 'Escherichia coli über 100.000 KBE/mL; empfindlich gegen Nitrofurantoin und Ciprofloxacin, resistent gegen Trimethoprim-Sulfamethoxazol.']),
  'uro-echo': d(
    ['Ecografie renală și vezicală — fără litiază', 'Renal and bladder ultrasound — no stones', 'Échographie rénale et vésicale — sans lithiase', 'Nieren- und Blasenultraschall — keine Steine'],
    ['Rinichi normali, fără dilatații sau calculi; pereți vezicali ușor îngroșați, compatibil cu cistită.', 'Normal kidneys, no dilation or stones; slightly thickened bladder wall, consistent with cystitis.', 'Reins normaux, sans dilatation ni calcul ; paroi vésicale légèrement épaissie, compatible avec une cystite.', 'Unauffällige Nieren, keine Erweiterung oder Steine; leicht verdickte Blasenwand, vereinbar mit einer Zystitis.'],
    { impression: ['Ultrasound appearance consistent with cystitis. No lithiasis or obstructive uropathy.', 'Aspect échographique compatible avec une cystite. Pas de lithiase ni d’uropathie obstructive.', 'Sonografischer Befund vereinbar mit einer Zystitis. Keine Lithiasis oder obstruktive Uropathie.'] }),
  'uro-control': d(
    ['Control urologie — antibiotic după antibiogramă', 'Urology follow-up — antibiotic chosen by the antibiogram', 'Contrôle d’urologie — antibiotique choisi d’après l’antibiogramme', 'Urologische Kontrolle — Antibiotikum nach Antibiogramm'],
    ['Cistită acută cu E. coli, fără complicații; nitrofurantoin 100 mg de două ori pe zi, 7 zile.', 'Acute E. coli cystitis, uncomplicated; nitrofurantoin 100 mg twice a day for 7 days.', 'Cystite aiguë à E. coli, sans complication ; nitrofurantoïne 100 mg deux fois par jour pendant 7 jours.', 'Akute E.-coli-Zystitis, unkompliziert; Nitrofurantoin 100 mg zweimal täglich für 7 Tage.'],
    { diagnosis: ['Acute E. coli cystitis, uncomplicated.', 'Cystite aiguë à E. coli, sans complication.', 'Akute E.-coli-Zystitis, unkompliziert.'],
      follow_up: ['Nitrofurantoin 100 mg twice a day, 7 days. Hydration. Review only if symptoms return.', 'Nitrofurantoïne 100 mg deux fois par jour, 7 jours. Hydratation. Contrôle seulement si les symptômes reviennent.', 'Nitrofurantoin 100 mg zweimal täglich, 7 Tage. Ausreichend trinken. Kontrolle nur bei erneuten Beschwerden.'] }),
  'uro-rx': d(
    ['Rețetă — nitrofurantoin 100 mg', 'Prescription — nitrofurantoin 100 mg', 'Ordonnance — nitrofurantoïne 100 mg', 'Rezept — Nitrofurantoin 100 mg'],
    ['Nitrofurantoin 100 mg capsule, una de două ori pe zi, 7 zile, după mese.', 'Nitrofurantoin 100 mg capsules, one twice a day, 7 days, after meals.', 'Nitrofurantoïne 100 mg gélules, une deux fois par jour, 7 jours, après les repas.', 'Nitrofurantoin 100 mg Kapseln, eine zweimal täglich, 7 Tage, nach den Mahlzeiten.'],
    { instructions: ['Nitrofurantoin 100 mg capsules — 1 capsule twice a day, 7 days, after meals', 'Nitrofurantoïne 100 mg gélules — 1 gélule deux fois par jour, 7 jours, après les repas', 'Nitrofurantoin 100 mg Kapseln — 1 Kapsel zweimal täglich, 7 Tage, nach den Mahlzeiten'] }),
  'uro-claim': d(
    ['Decont de cheltuieli — consultații urologie', 'Expense claim — urology consultations', 'Note de frais — consultations d’urologie', 'Kostenabrechnung — urologische Konsultationen'],
    ['Două consultații de urologie (4 și 18 martie 2026), total 550,00 RON.', 'Two urology consultations (4 and 18 March 2026), total 550.00 RON.', 'Deux consultations d’urologie (4 et 18 mars 2026), total 550,00 RON.', 'Zwei urologische Konsultationen (4. und 18. März 2026), Gesamtbetrag 550,00 RON.'],
    { summary: ['Urology consultation, 4 March 2026; follow-up urology consultation, 18 March 2026', 'Consultation d’urologie, 4 mars 2026 ; consultation de contrôle d’urologie, 18 mars 2026', 'Urologische Konsultation, 4. März 2026; urologische Kontrollkonsultation, 18. März 2026'] }),
  // ——— the skin ———
  'derm-consult': d(
    ['Consultație dermatologie — dermatită atopică', 'Dermatology consultation — atopic dermatitis', 'Consultation de dermatologie — dermatite atopique', 'Dermatologische Konsultation — atopische Dermatitis'],
    ['Plăci roșii și pruriginoase pe coate și mâini de 3 săptămâni; dermatită atopică ușoară, emolient și corticoid topic 7 zile.', 'Red itchy patches on the elbows and hands for 3 weeks; mild atopic dermatitis, emollient and a topical steroid for 7 days.', 'Plaques rouges et prurigineuses sur les coudes et les mains depuis 3 semaines ; dermatite atopique légère, émollient et corticoïde local pendant 7 jours.', 'Rote, juckende Stellen an Ellbogen und Händen seit 3 Wochen; leichte atopische Dermatitis, Pflegecreme und topisches Kortikoid für 7 Tage.'],
    { diagnosis: ['Atopic dermatitis, mild form.', 'Dermatite atopique, forme légère.', 'Atopische Dermatitis, leichte Form.'],
      follow_up: ['Daily emollient, topical corticosteroid for 7 days. Avoid irritating detergents. No follow-up scheduled.', 'Émollient quotidien, corticoïde local pendant 7 jours. Éviter les détergents irritants. Pas de contrôle prévu.', 'Täglich Pflegecreme, topisches Kortikoid für 7 Tage. Reizende Reinigungsmittel meiden. Keine Kontrolle geplant.'] }),
  'derm-rx': d(
    ['Rețetă — mometazonă și emolient', 'Prescription — mometasone and emollient', 'Ordonnance — mométasone et émollient', 'Rezept — Mometason und Pflegecreme'],
    ['Mometazonă 0,1% cremă o dată pe zi, 7 zile, și emolient cu uree 5% de două ori pe zi.', 'Mometasone 0.1% cream once a day for 7 days, and a 5% urea emollient twice a day.', 'Crème de mométasone 0,1 % une fois par jour pendant 7 jours, et émollient à l’urée 5 % deux fois par jour.', 'Mometason 0,1 % Creme einmal täglich für 7 Tage und Pflegecreme mit 5 % Harnstoff zweimal täglich.'],
    { instructions: ['Mometasone furoate 0.1% cream — thin layer once a day, 7 days, on the affected areas; urea 5% emollient — twice a day, on the whole body', 'Mométasone furoate 0,1 % crème — couche fine une fois par jour, 7 jours, sur les zones atteintes ; émollient à l’urée 5 % — deux fois par jour, sur tout le corps', 'Mometasonfuroat 0,1 % Creme — dünn einmal täglich, 7 Tage, auf die betroffenen Stellen; Pflegecreme mit 5 % Harnstoff — zweimal täglich, am ganzen Körper'] }),
  // ——— the annual check-up ———
  'annual-lab': d(
    ['Analize control anual — în limite normale', 'Annual check-up tests — within normal limits', 'Bilan du contrôle annuel — dans les limites normales', 'Jahreskontrolle Laborwerte — im Normbereich'],
    ['Hemoleucogramă, glicemie, colesterol, creatinină și TSH, toate în limite normale.', 'Blood count, glucose, cholesterol, creatinine and TSH, all within normal limits.', 'Numération sanguine, glycémie, cholestérol, créatinine et TSH, tous dans les limites normales.', 'Blutbild, Glukose, Cholesterin, Kreatinin und TSH, alle im Normbereich.']),
  'annual-gp': d(
    ['Control anual medic de familie — sănătos', 'Annual family doctor check-up — healthy', 'Contrôle annuel du médecin de famille — en bonne santé', 'Jährliche Hausarztkontrolle — gesund'],
    ['Control anual fără acuze; analizele din 15.12.2025 în limite normale, reevaluare peste 12 luni.', 'Annual check-up with no complaints; the tests of 15.12.2025 within normal limits, reassessment in 12 months.', 'Contrôle annuel sans plainte ; les analyses du 15.12.2025 dans les limites normales, réévaluation dans 12 mois.', 'Jahreskontrolle ohne Beschwerden; die Laborwerte vom 15.12.2025 im Normbereich, Neubeurteilung in 12 Monaten.'],
    { diagnosis: ['Healthy person. Annual tests within normal limits.', 'Personne en bonne santé. Analyses annuelles dans les limites normales.', 'Gesunde Person. Jahreslaborwerte im Normbereich.'],
      follow_up: ['No further recommendations. Reassessment in 12 months.', 'Pas de recommandation supplémentaire. Réévaluation dans 12 mois.', 'Keine weiteren Empfehlungen. Neubeurteilung in 12 Monaten.'] }),
};

/** A test as the app names it: the name as printed, what it is called across documents, and the name in each language. */
export const TESTS: Record<string, { canonical: string; en: string; fr: string; de: string }> = {
  'TSH': { canonical: 'tsh', en: 'TSH (thyroid-stimulating hormone)', fr: 'TSH (thyréostimuline)', de: 'TSH (Thyreotropin)' },
  'FT4 (tiroxină liberă)': { canonical: 'free t4', en: 'FT4 (free thyroxine)', fr: 'FT4 (thyroxine libre)', de: 'fT4 (freies Thyroxin)' },
  'Anticorpi anti-TPO': { canonical: 'anti-tpo antibodies', en: 'Anti-TPO antibodies', fr: 'Anticorps anti-TPO', de: 'Anti-TPO-Antikörper' },
  'Colesterol total': { canonical: 'total cholesterol', en: 'Total cholesterol', fr: 'Cholestérol total', de: 'Gesamtcholesterin' },
  'LDL colesterol': { canonical: 'ldl cholesterol', en: 'LDL cholesterol', fr: 'Cholestérol LDL', de: 'LDL-Cholesterin' },
  'HDL colesterol': { canonical: 'hdl cholesterol', en: 'HDL cholesterol', fr: 'Cholestérol HDL', de: 'HDL-Cholesterin' },
  'Trigliceride': { canonical: 'triglycerides', en: 'Triglycerides', fr: 'Triglycérides', de: 'Triglyceride' },
  'Glucoză': { canonical: 'glucose', en: 'Glucose', fr: 'Glycémie', de: 'Glukose' },
  'Creatinină': { canonical: 'creatinine', en: 'Creatinine', fr: 'Créatinine', de: 'Kreatinin' },
  'ALT (TGP)': { canonical: 'alt', en: 'ALT', fr: 'ALAT', de: 'ALT (GPT)' },
  'AST (TGO)': { canonical: 'ast', en: 'AST', fr: 'ASAT', de: 'AST (GOT)' },
  'Hemoglobină': { canonical: 'hemoglobin', en: 'Hemoglobin', fr: 'Hémoglobine', de: 'Hämoglobin' },
  'Leucocite': { canonical: 'leukocytes', en: 'White blood cells', fr: 'Globules blancs', de: 'Leukozyten' },
  'Trombocite': { canonical: 'platelets', en: 'Platelets', fr: 'Plaquettes', de: 'Thrombozyten' },
  'Escherichia coli': { canonical: 'escherichia coli', en: 'Escherichia coli', fr: 'Escherichia coli', de: 'Escherichia coli' },
  'Leucocite în sediment': { canonical: 'urine leukocytes', en: 'Leukocytes in sediment', fr: 'Leucocytes dans le sédiment', de: 'Leukozyten im Sediment' },
  'Nitrofurantoin': { canonical: 'nitrofurantoin', en: 'Nitrofurantoin', fr: 'Nitrofurantoïne', de: 'Nitrofurantoin' },
  'Ciprofloxacină': { canonical: 'ciprofloxacin', en: 'Ciprofloxacin', fr: 'Ciprofloxacine', de: 'Ciprofloxacin' },
  'Trimetoprim-sulfametoxazol': { canonical: 'trimethoprim-sulfamethoxazole', en: 'Trimethoprim-sulfamethoxazole', fr: 'Triméthoprime-sulfaméthoxazole', de: 'Trimethoprim-Sulfamethoxazol' },
};

/** A doctor's specialty, in each language. */
export const SPECIALTY: Record<string, Quad> = {
  anghel: ['endocrinologie', 'endocrinology', 'endocrinologie', 'Endokrinologie'],
  vasile: ['oftalmologie', 'ophthalmology', 'ophtalmologie', 'Augenheilkunde'],
  popescu: ['cardiologie', 'cardiology', 'cardiologie', 'Kardiologie'],
  ionescu: ['medicină de familie', 'family medicine', 'médecine de famille', 'Allgemeinmedizin'],
  marinescu: ['medicină de laborator', 'laboratory medicine', 'médecine de laboratoire', 'Labormedizin'],
  stan: ['urologie', 'urology', 'urologie', 'Urologie'],
  dumitru: ['dermatovenerologie', 'dermatology', 'dermatologie', 'Dermatologie'],
  toma: ['radiologie', 'radiology', 'radiologie', 'Radiologie'],
  neagu: ['pneumologie', 'pulmonology', 'pneumologie', 'Pneumologie'],
};

/** The episodes of the curated archive, as their owner would name them, in each language. */
export const EPISODE_TITLES: Record<string, Quad> = {
  thy1: ['Hipotiroidism — diagnostic și start tratament (februarie 2025)', 'Hypothyroidism — diagnosis and start of treatment (February 2025)', 'Hypothyroïdie — diagnostic et début du traitement (février 2025)', 'Hypothyreose — Diagnose und Behandlungsbeginn (Februar 2025)'],
  thy2: ['Hipotiroidism — ajustarea dozei (mai–iunie 2025)', 'Hypothyroidism — dose adjustment (May–June 2025)', 'Hypothyroïdie — ajustement de la dose (mai–juin 2025)', 'Hypothyreose — Dosisanpassung (Mai–Juni 2025)'],
  thy3: ['Hipotiroidism — control compensat (noiembrie–decembrie 2025)', 'Hypothyroidism — compensated review (November–December 2025)', 'Hypothyroïdie — contrôle compensé (novembre–décembre 2025)', 'Hypothyreose — kompensierte Kontrolle (November–Dezember 2025)'],
  eye: ['Control oftalmologic și ochelari (iunie 2025)', 'Eye check and glasses (June 2025)', 'Contrôle ophtalmologique et lunettes (juin 2025)', 'Augenuntersuchung und Brille (Juni 2025)'],
  card1: ['Dureri toracice — evaluare și start statină (februarie–martie 2026)', 'Chest pain — assessment and statin start (February–March 2026)', 'Douleurs thoraciques — évaluation et début de la statine (février–mars 2026)', 'Brustschmerzen — Abklärung und Statinbeginn (Februar–März 2026)'],
  card2: ['Cardiologie — control la 6 luni (septembrie 2026)', 'Cardiology — 6-month review (September 2026)', 'Cardiologie — contrôle à 6 mois (septembre 2026)', 'Kardiologie — Kontrolle nach 6 Monaten (September 2026)'],
  pneu: ['Pneumonie — de la medicul de familie la spital și vindecare (septembrie–octombrie 2025)', 'Pneumonia — from the family doctor to hospital and recovery (September–October 2025)', 'Pneumonie — du médecin de famille à l’hôpital et la guérison (septembre–octobre 2025)', 'Lungenentzündung — vom Hausarzt über das Krankenhaus bis zur Genesung (September–Oktober 2025)'],
  uro: ['Infecție urinară — de la consultație la tratament (martie 2026)', 'Urinary infection — from consultation to treatment (March 2026)', 'Infection urinaire — de la consultation au traitement (mars 2026)', 'Harnwegsinfekt — von der Konsultation bis zur Behandlung (März 2026)'],
  derm: ['Dermatită atopică (aprilie 2026)', 'Atopic dermatitis (April 2026)', 'Dermatite atopique (avril 2026)', 'Atopische Dermatitis (April 2026)'],
  annual: ['Control anual (decembrie 2025)', 'Annual check-up (December 2025)', 'Contrôle annuel (décembre 2025)', 'Jahreskontrolle (Dezember 2025)'],
};
