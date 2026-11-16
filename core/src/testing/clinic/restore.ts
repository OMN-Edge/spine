import type { ManifestDocument, ManifestFile } from '../../archive/manifest.js';
import type { DemoArchive, DemoEpisode, DemoLanguage, DemoLink, DemoRecord, DemoTranslation } from '../../demo/archive.js';
import type { Body, Page } from './render.js';
import { DOCS, PROVIDERS, pageOf, type DocSpec, DOCTORS } from './specs.js';
import { EPISODE_TITLES, SPECIALTY, TESTS, WORDS, type Quad } from './words.js';

/**
 * The sample archive as the demo loads it: for each document what reading it would have found (written from the values the document was drawn from, so it is exactly right), its pages' text,
 * the links and episodes a person would have curated (most confirmed, a few left as suggestions to show what deciding one is like), and the translations written by hand.
 * The two documents held twice are left out: a copy is a test of linking, not something to explore.
 */
const LANGS = ['en', 'fr', 'de'] as const;
const byId = new Map(DOCS.map(d => [d.id, d]));
const ro = (iso: string) => iso.split('-').reverse().join('.');

const TAGS: Record<string, string[]> = { thy1: ['thyroid'], thy2: ['thyroid'], thy3: ['thyroid'], eye: ['eye'], card1: ['heart'], card2: ['heart'], dental: ['dental'], pneu: ['lungs'], uro: ['urology'], derm: ['skin'], annual: ['check-up'] };
const DOC_TYPE: Record<Body['kind'], ManifestDocument['doc_type']> = { letter: 'consultation_note', lab: 'lab_result', imaging: 'imaging', ecg: 'imaging', rx: 'prescription', discharge: 'discharge_note', sickleave: 'other', invoice: 'other' };

/** The lines of each page, as the PDF prints them. */
function pagesText(page: Page): string[] {
  const head = [page.provider.name, page.provider.sub, `${page.provider.address} · ${page.provider.contact}`];
  const patient = [`Pacient: ${page.patient.name}`, `Data nașterii: ${page.patient.born}`, `Nr. fișă: ${page.patient.fileNo}`];
  const fields = (f: Array<[string, string]>) => f.map(([k, v]) => `${k}: ${v}`);
  const sections = (list: Array<{ heading: string; text: string }>) => list.flatMap(s => [s.heading.toUpperCase(), s.text]);
  const doctor = page.doctor ? [`Medic: ${page.doctor.name}, ${page.doctor.role}`, `cod parafă ${page.doctor.code}`] : [];
  const b = page.body;
  switch (b.kind) {
    case 'letter': return [[...head, b.title, ...patient, ...fields(b.fields), ...sections(b.sections), ...doctor].join('\n')];
    case 'ecg': return [[...head, b.title, ...patient, ...fields(b.fields), ...sections(b.sections), ...doctor].join('\n')];
    case 'imaging': return [[...head, b.title, ...patient, ...fields(b.fields), ...sections(b.sections), ...doctor].join('\n')];
    case 'lab': return [[...head, b.title, ...patient, ...fields(b.fields), ...b.groups.flatMap(g => [g.heading.toUpperCase(), ...g.rows.map(r => `${r.name}: ${r.value} ${r.unit}${r.ref ? ` (${r.ref})` : ''}${r.flag ? ` ${r.flag}` : ''}`)]), ...doctor].join('\n')];
    case 'rx': return [[...head, b.title, ...patient, ...fields(b.fields), 'Rp.', ...b.items.flatMap((i, n) => [`${n + 1}. ${i.drug}`, `${i.dose} — ${i.how}`]), ...(b.note ? [b.note] : []), ...doctor].join('\n')];
    case 'discharge': return b.pages.map((p, i) => [...head, ...(i === 0 ? [b.title, ...patient, ...fields(b.fields)] : []), ...sections(p), ...(i === b.pages.length - 1 ? doctor : [])].join('\n'));
    case 'sickleave': return [['CERTIFICAT DE CONCEDIU MEDICAL', `Seria ${b.series} Nr. ${page.docNo}`, ...patient, `Unitatea sanitară: ${page.provider.name}`, `Cod diagnostic (ICD-10): ${b.code}`, `Nr. zile: ${b.days}`, ...fields(b.fields), ...doctor].join('\n')];
    case 'invoice': return [[...head, b.title, ...patient, ...fields(b.fields), ...b.lines.map(([x, q, v]) => `${x} — ${q} × ${v} RON`), `TOTAL: ${b.total} RON`].join('\n')];
  }
}

const section = (b: Extract<Body, { sections: unknown }>, heading: string) => b.sections.find(s => s.heading === heading)?.text ?? '';

/** The short facts read from a document, by the label the app uses, in the document's own language. */
function factsOf(b: Body): Record<string, string> {
  switch (b.kind) {
    case 'letter': return { diagnosis: section(b, 'Diagnostic'), follow_up: section(b, 'Recomandări și plan') };
    case 'imaging': case 'ecg': return { impression: section(b, 'Concluzie') };
    case 'discharge': {
      const all = b.pages.flat();
      return { diagnosis: all.find(s => s.heading === 'Diagnostic la externare')?.text ?? '', follow_up: all.find(s => s.heading === 'Recomandări la externare')?.text ?? '' };
    }
    case 'sickleave': return { diagnosis: b.fields.find(([k]) => k === 'Motivul')?.[1] ?? '' };
    case 'rx': return { instructions: b.items.map(i => `${i.drug} — ${i.dose}, ${i.how}`).join('; ') };
    case 'invoice': return { summary: b.lines.map(([x]) => x).join('; ') };
    case 'lab': return {};
  }
}

const number = (v: string): number | null => { const n = Number(v.replace(',', '.').replace(/^[<>]\s*/, '')); return Number.isFinite(n) && /^[<>]?\s*[0-9]/.test(v) ? n : null; };
function bounds(ref: string): [number | null, number | null] {
  const range = ref.match(/^([0-9.]+)\s*[–-]\s*([0-9.]+)$/);
  if (range) return [Number(range[1]), Number(range[2])];
  const upper = ref.match(/^<\s*([0-9.]+)$/); if (upper) return [null, Number(upper[1])];
  const lower = ref.match(/^>\s*([0-9.]+)$/); if (lower) return [Number(lower[1]), null];
  return [null, null];
}

function documentOf(d: DocSpec, page: Page, texts: string[]): ManifestDocument {
  const base = byId.get(d.duplicateOf ?? d.id)!;
  const words = WORDS[d.id]!;
  const facts = factsOf(base.body);
  const doctorKey = base.doctor;
  const specialty = doctorKey ? SPECIALTY[doctorKey]![0] : null;
  const rows = base.body.kind === 'lab' ? base.body.groups.flatMap(g => g.rows) : [];
  return {
    page_start: 1, page_end: texts.length, title: words.title[0], doc_date: base.date, provider: PROVIDERS[base.provider]!.name, doc_type: DOC_TYPE[base.body.kind],
    ai_summary: words.summary[0], user_notes: null, language: 'ro', reviewed: d.id !== 'pneu-xray2', tags: TAGS[d.cycle] ?? [],
    doctors: page.doctor && specialty
      ? [{ name: page.doctor.name, specialty, clinic: PROVIDERS[base.provider]!.name, license_code: page.doctor.code, role: base.body.kind === 'rx' ? 'prescriber' : 'author', person: null, source: 'text', printed_code: page.doctor.code }]
      : [],
    fields: Object.entries(facts).filter(([, v]) => v).map(([label, value]) => ({ label, value, group_no: label === 'instructions' ? 1 : null, page: 1, source_snippet: null, bbox: null, confidence: 1, owner_edited: false })),
    measurements: rows.map(r => {
      const [low, high] = bounds(r.ref);
      return {
        name: r.name, canonical: (TESTS[r.name]?.canonical ?? r.name).toLowerCase(), value_text: r.value, value_num: number(r.value), unit: r.unit || null, ref_low: low, ref_high: high,
        flag: r.flag === 'H' ? 'high' as const : r.flag === 'L' ? 'low' as const : number(r.value) === null ? null : 'normal' as const,
        taken_on: base.date, page: 1, source_snippet: null, bbox: null, confidence: 1, owner_edited: false,
      };
    }),
    owner_edited: [], removed_fields: [], removed_measurements: [],
  };
}

function translationOf(d: DocSpec, doc: ManifestDocument, language: (typeof LANGS)[number]): DemoTranslation {
  const i = { en: 1, fr: 2, de: 3 }[language];
  const words = WORDS[d.id]!;
  const fields: Record<string, string> = {};
  for (const f of doc.fields) {
    const t = words.facts?.[f.label];
    if (!t) throw new Error(`${d.id}: no translation of the fact "${f.label}"`);
    fields[f.value] = t[i - 1]!;
  }
  const measurements: Record<string, string> = {};
  for (const m of doc.measurements) {
    const t = TESTS[m.name];
    if (!t) throw new Error(`${d.id}: no translation of the test "${m.name}"`);
    measurements[m.name] = t[language];
  }
  const doctors: Record<string, string> = {};
  const doctorKey = byId.get(d.duplicateOf ?? d.id)!.doctor;
  if (doctorKey) doctors[SPECIALTY[doctorKey]![0]] = SPECIALTY[doctorKey]![i]!;
  return { title: words.title[i]!, summary: words.summary[i]!, fields, measurements, doctors };
}

/** The links a person would have curated: a request names what it asked for, a follow-up leads on from the earlier document, the rest are one story. */
const CONFIRMED: Array<[string, string, DemoLink['kind']]> = [
  ['thy1-consult', 'thy1-lab', 'requests'], ['thy1-consult', 'thy1-control', 'follow_up'], ['thy1-control', 'thy1-rx', 'same_episode'],
  ['thy2-consult', 'thy2-lab', 'requests'], ['thy2-consult', 'thy2-control', 'follow_up'], ['thy2-control', 'thy2-rx', 'same_episode'],
  ['thy3-consult', 'thy3-lab', 'requests'], ['thy3-consult', 'thy3-control', 'follow_up'],
  ['thy1-control', 'thy2-consult', 'follow_up'], ['thy2-control', 'thy3-consult', 'follow_up'],
  ['eye-consult', 'eye-glasses', 'same_episode'],
  ['card1-consult', 'card1-ecg', 'requests'], ['card1-consult', 'card1-lab', 'requests'], ['card1-consult', 'card1-control', 'follow_up'], ['card1-control', 'card1-rx', 'same_episode'],
  ['card2-consult', 'card2-lab', 'requests'], ['card2-consult', 'card2-control', 'follow_up'], ['card1-control', 'card2-consult', 'follow_up'],
  ['pneu-gp', 'pneu-xray', 'requests'], ['pneu-gp', 'pneu-discharge', 'requests'], ['pneu-discharge', 'pneu-sick', 'same_episode'], ['pneu-discharge', 'pneu-gp-control', 'follow_up'],
  ['pneu-gp-control', 'pneu-xray2', 'requests'], ['pneu-xray', 'pneu-xray2', 'follow_up'],
  ['uro-consult', 'uro-culture', 'requests'], ['uro-consult', 'uro-echo', 'requests'], ['uro-consult', 'uro-control', 'follow_up'], ['uro-control', 'uro-rx', 'same_episode'],
  ['derm-consult', 'derm-rx', 'same_episode'],
];
/** Left as suggestions, so the demo shows what a suggestion is and what confirming or dismissing it does. */
const SUGGESTED: Array<[string, string, DemoLink['kind']]> = [['uro-consult', 'uro-claim', 'same_episode'], ['annual-lab', 'annual-gp', 'same_episode']];

const EPISODES: Array<{ cycle: string; state: 'proposed' | 'confirmed' }> = [
  { cycle: 'thy1', state: 'confirmed' }, { cycle: 'thy2', state: 'confirmed' }, { cycle: 'thy3', state: 'confirmed' }, { cycle: 'eye', state: 'confirmed' },
  { cycle: 'card1', state: 'confirmed' }, { cycle: 'card2', state: 'confirmed' }, { cycle: 'pneu', state: 'confirmed' }, { cycle: 'derm', state: 'confirmed' },
  { cycle: 'uro', state: 'proposed' }, { cycle: 'annual', state: 'proposed' },
];

/** The archive, with the files named as `<key>.pdf`. `only` keeps those documents (and what names only them), for a test that needs a few. */
export function demoArchiveOf(options: { only?: string[] } = {}): DemoArchive {
  const keep = (id: string) => !options.only || options.only.includes(id);
  const docs = DOCS.filter(d => !d.duplicateOf && keep(d.id));
  const records: DemoRecord[] = docs.map(d => {
    const page = pageOf(d, byId);
    const texts = pagesText(page);
    const doc = documentOf(d, page, texts);
    const file: ManifestFile = {
      path: `${d.id}.pdf`, original_filename: `${d.id}.pdf`, sha256: '0'.repeat(64), photo_set: false, page_count: texts.length,
      pages: texts.map((text, n) => ({ number: n + 1, source_page: n + 1, hidden: false, extraction_source: 'native_text' as const, raw_text: text, elements: [] })),
      documents: [doc],
    };
    return { key: d.id, pdf: `${d.id}.pdf`, file, translations: Object.fromEntries(LANGS.map(l => [l, translationOf(d, doc, l)])) };
  });
  const have = new Set(docs.map(d => d.id));
  const link = (state: DemoLink['state']) => ([from, to, kind]: [string, string, DemoLink['kind']]): DemoLink[] =>
    have.has(from) && have.has(to) ? [{ from, to, kind, state, source: state === 'confirmed' ? 'owner' : 'auto' }] : [];
  const links = [...CONFIRMED.flatMap(link('confirmed')), ...SUGGESTED.flatMap(link('proposed'))];
  const episodes: DemoEpisode[] = EPISODES.flatMap(e => {
    const documents = docs.filter(d => d.cycle === e.cycle).sort((a, b) => a.date.localeCompare(b.date)).map(d => d.id);
    if (documents.length < 2) return [];
    const t: Quad | undefined = EPISODE_TITLES[e.cycle];
    return [{ title: e.state === 'confirmed' && t ? ({ ro: t[0], en: t[1], fr: t[2], de: t[3] } as Record<DemoLanguage, string>) : null, state: e.state, documents }];
  });
  return { records, links, episodes };
}
