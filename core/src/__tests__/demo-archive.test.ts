import { describe, expect, it } from 'vitest';
import { manifestSchema, EXPORT_FORMAT } from '../archive/manifest.js';
import { KNOWN_FIELD_LABELS } from '../llm/doc-types.js';
import { demoArchiveOf } from '../testing/clinic/restore.js';
import { clinicDemoSource } from '../testing/clinic/source.js';
import { DOCS, GROUND_TRUTH } from '../testing/clinic/specs.js';
import { DEMO_LANGUAGES } from '../demo/archive.js';

/** The sample archive the demo loads: valid records, complete translations, links and episodes that hold together and match what is true of the archive. */
const archive = demoArchiveOf();
const specs = new Map(DOCS.map(d => [d.id, d]));
const ro = (iso: string) => iso.split('-').reverse().join('.');
const DAY = 86_400_000;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const keys = new Set(archive.records.map(r => r.key));

describe('the sample archive', () => {
  it('is every document but the copies, each a record the importer would accept', () => {
    expect(archive.records).toHaveLength(DOCS.filter(d => !d.duplicateOf).length);
    expect(keys.size).toBe(archive.records.length);
    const manifest = { format: EXPORT_FORMAT, version: 3, exported_at: '2026-11-16T00:00:00Z', kind: 'archive', files: archive.records.map(r => r.file) };
    const parsed = manifestSchema.safeParse(manifest);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  });

  it('reads each document as what its date, provider, kind and doctor say, with the date printed on its pages', () => {
    for (const r of archive.records) {
      const spec = specs.get(r.key)!;
      const doc = r.file.documents[0]!;
      expect(doc.doc_date, r.key).toBe(spec.date);
      expect(doc.language).toBe('ro');
      expect(doc.title && doc.ai_summary, r.key).toBeTruthy();
      expect(r.file.pages.map(p => p.raw_text).join('\n'), `${r.key} prints its date`).toContain(ro(spec.date));
      expect(r.file.page_count).toBe(r.file.pages.length);
      expect(doc.page_end).toBe(r.file.pages.length);
      if (spec.doctor) expect(doc.doctors, r.key).toHaveLength(1);
    }
  });

  it('keeps to the field labels the app has wording for, and flags each result by its range', () => {
    for (const r of archive.records) {
      const doc = r.file.documents[0]!;
      for (const f of doc.fields) expect(KNOWN_FIELD_LABELS.has(f.label), `${r.key}: ${f.label}`).toBe(true);
      for (const m of doc.measurements) {
        if (m.value_num === null) continue;
        const flag = m.ref_high !== null && m.value_num > m.ref_high ? 'high' : m.ref_low !== null && m.value_num < m.ref_low ? 'low' : 'normal';
        expect(m.flag, `${r.key}: ${m.name} ${m.value_text}`).toBe(flag);
      }
    }
  });

  it('is translated into English, French and German in full: the title, the summary, every fact, every test and the specialty, none left as the Romanian', () => {
    for (const r of archive.records) {
      const doc = r.file.documents[0]!;
      for (const lang of ['en', 'fr', 'de'] as const) {
        const t = r.translations[lang];
        expect(t, `${r.key} in ${lang}`).toBeTruthy();
        expect(t!.title && t!.summary).toBeTruthy();
        expect(t!.title, `${r.key}/${lang} title`).not.toBe(doc.title);
        expect(t!.summary, `${r.key}/${lang} summary`).not.toBe(doc.ai_summary);
        for (const f of doc.fields) expect(t!.fields[f.value], `${r.key}/${lang} ${f.label}`).toBeTruthy();
        for (const m of doc.measurements) expect(t!.measurements[m.name], `${r.key}/${lang} ${m.name}`).toBeTruthy();
        for (const d of doc.doctors) expect(t!.doctors[d.specialty!], `${r.key}/${lang} ${d.specialty}`).toBeTruthy();
      }
    }
  });

  it('has titles that tell the documents apart, in every language', () => {
    for (const lang of ['en', 'fr', 'de'] as const) {
      const titles = archive.records.map(r => r.translations[lang]!.title);
      expect(new Set(titles).size, lang).toBe(titles.length);
    }
    expect(new Set(archive.records.map(r => r.file.documents[0]!.title)).size).toBe(archive.records.length);
  });
});

describe('the sample’s links and episodes', () => {
  const cycleOf = (k: string) => specs.get(k)!.cycle;
  const pair = (a: string, b: string) => [a, b].sort().join('|');
  const never = new Set(GROUND_TRUTH.never.map(([a, b]) => pair(a, b)));
  const adjacent = (x: string, y: string) => GROUND_TRUTH.conditionChains.some(c => c.includes(x as never) && c.includes(y as never) && Math.abs(c.indexOf(x as never) - c.indexOf(y as never)) === 1);

  it('name only documents that are in it, run forward in time, and join only what is one story or a neighbouring cycle of one condition', () => {
    expect(archive.links.length).toBeGreaterThan(20);
    for (const l of archive.links) {
      expect(keys.has(l.from) && keys.has(l.to), `${l.from} -> ${l.to}`).toBe(true);
      expect(specs.get(l.from)!.date <= specs.get(l.to)!.date, `${l.from} -> ${l.to} runs forward`).toBe(true);
      expect(never.has(pair(l.from, l.to)), `${l.from} -> ${l.to} is never linked`).toBe(false);
      expect(cycleOf(l.from) === cycleOf(l.to) || adjacent(cycleOf(l.from), cycleOf(l.to)), `${l.from} -> ${l.to}`).toBe(true);
      expect(l.state === 'confirmed' ? l.source === 'owner' : l.source === 'auto').toBe(true);
    }
    expect(new Set(archive.links.map(l => `${l.from}|${l.to}|${l.kind}`)).size).toBe(archive.links.length);
    expect(archive.links.some(l => l.state === 'proposed')).toBe(true); // a few are left to decide
    expect(archive.links.filter(l => l.state === 'confirmed').length).toBeGreaterThan(archive.links.filter(l => l.state === 'proposed').length);
  });

  it('are care cycles, each document in at most one, none longer than 120 days, and named in every language when the owner confirmed them', () => {
    const seen = new Set<string>();
    for (const e of archive.episodes) {
      expect(e.documents.length).toBeGreaterThanOrEqual(2);
      const cycles = new Set(e.documents.map(cycleOf));
      expect(cycles.size, e.documents.join(',')).toBe(1);
      const dates = e.documents.map(k => day(specs.get(k)!.date));
      expect(Math.max(...dates) - Math.min(...dates)).toBeLessThanOrEqual(GROUND_TRUTH.maxEpisodeDays);
      for (const k of e.documents) { expect(seen.has(k), k).toBe(false); seen.add(k); }
      if (e.state === 'confirmed') for (const lang of DEMO_LANGUAGES) expect(e.title?.[lang], `${e.documents[0]} in ${lang}`).toBeTruthy();
      else expect(e.title).toBeNull();
    }
    expect(archive.episodes.filter(e => e.state === 'confirmed').length).toBeGreaterThanOrEqual(6);
    expect(archive.episodes.some(e => e.state === 'proposed')).toBe(true);
    // the three thyroid cycles are three episodes, not one
    expect(archive.episodes.filter(e => e.documents.some(k => k.startsWith('thy'))).length).toBe(3);
  });

  it('can be cut down to a few documents, keeping only what names no other', () => {
    const few = demoArchiveOf({ only: ['thy2-consult', 'thy2-lab', 'eye-consult'] });
    expect(few.records.map(r => r.key)).toEqual(['thy2-consult', 'thy2-lab', 'eye-consult']);
    expect(few.links).toEqual([expect.objectContaining({ from: 'thy2-consult', to: 'thy2-lab' })]);
    expect(few.episodes.map(e => e.documents)).toEqual([['thy2-consult', 'thy2-lab']]);
  });
});

describe('the sample’s files', () => {
  it('are a PDF for each document, made the same way every time and of a size a phone can fetch', async () => {
    const source = clinicDemoSource({ only: ['thy2-lab', 'pneu-discharge', 'card1-ecg'] });
    const archive2 = await source.archive();
    for (const r of archive2.records) {
      const bytes = await source.pdf(r.pdf);
      expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), r.key).toBe('%PDF-');
      expect(bytes.length, r.key).toBeLessThan(120_000);
      expect(Buffer.compare(Buffer.from(bytes), Buffer.from(await clinicDemoSource().pdf(r.pdf))), `${r.key} is the same again`).toBe(0);
    }
    await expect(source.pdf('nothing.pdf')).rejects.toThrow(/no sample document/);
  });
});
