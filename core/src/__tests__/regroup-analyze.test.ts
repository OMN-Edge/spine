import { describe, it, expect } from 'vitest';
import { clusterPages, readingOrder } from '../regroup/cluster.js';
import { datesIn, featuresOf, markerIn, refsIn, similarityMatrix } from '../regroup/features.js';
import { groupPages, planRegrouping, type Judge } from '../regroup/analyze.js';
import type { GroupingJudgement } from '../llm/types.js';

/**
 * Finding which pages of a mixed export belong together. The text is invented. The judge stands in for the model and answers from
 * the truth the test knows, so what is tested is what is ours: the signals, the clustering, how a verdict is used and what is proposed.
 */
const text = (lines: string[]) => lines.join('\n') + '\nAdditional narrative text to make this page long enough to place by its words alone.';

// Three documents, their pages interleaved the way a bulk export of a clinic's file comes out.
const LAB = (n: number) => text([`Laborator Exemplu SRL Raport nr. LAB-2026-00417 Pagina ${n} din 3`, 'Data recoltarii 12.03.2026', n === 1 ? 'Hemoglobina 13.5 g/dL Leucocite 6.2 Trombocite 250' : n === 2 ? 'Glucoza 5.1 mmol/L Colesterol 4.9 Trigliceride 1.2' : 'Interpretare: valori in limite. Semnatura medic de laborator']);
const DISCHARGE = (n: number) => text([`Spital Exemplu Foaie de externare ADM-884201 Pagina ${n} din 2`, 'Internat 02.04.2026 externat 06.04.2026', n === 1 ? 'Diagnostic principal: pneumonie. Tratament antibiotic' : 'Recomandari la externare: repaus, control la 7 zile, medicatie']);
const RX = (n: number) => text([`Reteta electronica RX-5530917 pagina ${n} din 2`, 'Emisa 20.05.2026 Dr. Exemplu Medicina de familie', n === 1 ? 'Amoxicilina 500 mg de 3 ori pe zi' : 'Paracetamol 500 mg la nevoie']);

const pages = [
  { id: 'a1', truth: 'lab', raw_text: LAB(1) }, { id: 'd1', truth: 'dis', raw_text: DISCHARGE(1) }, { id: 'r1', truth: 'rx', raw_text: RX(1) },
  { id: 'a2', truth: 'lab', raw_text: LAB(2) }, { id: 'r2', truth: 'rx', raw_text: RX(2) }, { id: 'd2', truth: 'dis', raw_text: DISCHARGE(2) },
  { id: 'a3', truth: 'lab', raw_text: LAB(3) },
].map((p, i) => ({ ...p, page_number: i + 1 }));
const truthOf = (label: string) => pages.find(p => `P${p.page_number}` === label)!.truth;

/** A judge that knows the truth: coherent when every page is of one document, otherwise it divides them by it. */
const truthful = (log: string[][] = []): Judge => async given => {
  log.push(given.map(g => g.id));
  const kinds = new Set(given.map(g => truthOf(g.id)));
  const verdict: GroupingJudgement = kinds.size === 1
    ? { coherent: true, confidence: 0.9, groups: [], order: given.map(g => g.id), title: 'Title', reason: 'same report' }
    : { coherent: false, confidence: 0.9, groups: [...kinds].map(k => given.filter(g => truthOf(g.id) === k).map(g => g.id)), order: [], title: null, reason: 'different documents' };
  return verdict;
};

describe('what a page says about itself', () => {
  it('finds reference numbers, dates and "page k of n", and not a date as a reference', () => {
    expect([...refsIn('Raport nr. LAB-2026-00417 din 12.03.2026 tel 0211234567')].sort()).toEqual(['0211234567', 'LAB-2026-00417']);
    expect([...datesIn('12.03.2026 si 2026-04-02 si 31/02/2026 si 99.99.2026')].sort()).toEqual(['2026-03-12', '2026-04-02']);
    expect(markerIn('Pagina 2 din 3')).toEqual({ index: 2, total: 3 });
    expect(markerIn('Seite 1 von 4')).toEqual({ index: 1, total: 4 });
    expect(markerIn('Page 5 of 2')).toBeNull();
    expect(markerIn('no marker here')).toBeNull();
  });
});

describe('similarity and clustering', () => {
  const features = pages.map(featuresOf);
  const sim = similarityMatrix(features);

  it('puts pages of one document nearer than pages of different ones, without a model', () => {
    const at = (id: string) => pages.findIndex(p => p.id === id);
    expect(sim[at('a1')][at('a2')]).toBeGreaterThan(sim[at('a1')][at('d1')]);
    expect(sim[at('r1')][at('r2')]).toBeGreaterThan(sim[at('r1')][at('a3')]);
    // The same page number of the same report twice cannot be one document.
    const twin = similarityMatrix([featuresOf({ id: 'x', page_number: 1, raw_text: LAB(2) }), featuresOf({ id: 'y', page_number: 2, raw_text: LAB(2) })]);
    expect(twin[0][1]).toBe(-1);
  });

  it('finds the documents of the interleaved export', () => {
    const groups = clusterPages(sim, 0.3, 8).map(g => g.map(i => pages[i].id).sort());
    expect(groups.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([['a1', 'a2', 'a3'], ['d1', 'd2'], ['r1', 'r2']]);
  });

  it('reads a group in the order its own page numbers give', () => {
    const lab = [2, 0, 6].map(i => i); // a1 (index 0), a2 (3), a3 (6) in some order
    expect(readingOrder([6, 0, 3], features).map(i => pages[i].id)).toEqual(['a1', 'a2', 'a3']);
    expect(lab).toBeDefined();
  });

  it('never makes a group larger than allowed', () => {
    expect(Math.max(...clusterPages(sim, -0.5, 3).map(g => g.length))).toBeLessThanOrEqual(3);
  });
});

describe('validating with the model', () => {
  it('asks about each group and keeps what it confirms', async () => {
    const asked: string[][] = [];
    const { groups, calls } = await groupPages(pages.map(featuresOf), similarityMatrix(pages.map(featuresOf)), truthful(asked));
    expect(calls).toBe(3);
    expect(groups.map(g => g.pages.map(i => pages[i].id).join('')).sort()).toEqual(['a1a2a3', 'd1d2', 'r1r2']);
    expect(groups.every(g => g.status === 'validated')).toBe(true);
  });

  it('lets the model divide a cluster that is not one document, using its division and not the clustering', async () => {
    const f = pages.map(featuresOf);
    // Everything in one cluster, as a loose threshold would make it; the model says how it really divides.
    const { groups } = await groupPages(f, similarityMatrix(f), truthful(), { threshold: -0.9, maxGroup: 20 });
    expect(groups.map(g => g.pages.map(i => pages[i].id).sort().join('')).sort()).toEqual(['a1a2a3', 'd1d2', 'r1r2']);
  });

  it('marks a group unchecked when the model gives no verdict or the budget is spent, and never invents one', async () => {
    const f = pages.map(featuresOf); const sim = similarityMatrix(f);
    const none = await groupPages(f, sim, async () => null);
    expect(none.groups.every(g => g.status === 'unchecked')).toBe(true);
    const spent = await groupPages(f, sim, truthful(), { maxCalls: 1 });
    expect(spent.calls).toBe(1);
    expect(spent.groups.filter(g => g.status === 'unchecked')).toHaveLength(2);
    const throwing = await groupPages(f, sim, async () => { throw new Error('provider down'); });
    expect(throwing.groups.every(g => g.status === 'unchecked')).toBe(true);
  });

  it('offers a page left alone to the nearest group, and attaches it only if the model agrees', async () => {
    const extra = { id: 'z1', truth: 'lab', page_number: 8, raw_text: text(['Laborator Exemplu SRL anexa LAB-2026-00417', 'Rezultate suplimentare: ferritina 40 ng/mL vitamina D 22']) };
    const all = [...pages, extra];
    const f = all.map(featuresOf);
    const judge: Judge = async given => {
      const kinds = new Set(given.map(g => all.find(p => `P${p.page_number}` === g.id)!.truth));
      return kinds.size === 1 ? { coherent: true, confidence: 0.9, groups: [], order: given.map(g => g.id), title: null, reason: 'ok' } : { coherent: false, confidence: 0.9, groups: [], order: [], title: null, reason: 'no' };
    };
    const { groups } = await groupPages(f, similarityMatrix(f), judge);
    expect(groups.map(g => g.pages.map(i => all[i].id).sort().join('')).sort()).toContain('a1a2a3z1');
  });
});

describe('the plan', () => {
  const doc = (id: string, ids: string[]) => ({ id, page_ids: ids });

  it('proposes only what would change, and says which documents the pages come from', async () => {
    // The upload cut the first three pages as one document, the rest as another: the export's mixing is not fixed.
    const documents = [doc('X', ['a1', 'd1', 'r1']), doc('Y', ['a2', 'r2', 'd2', 'a3'])];
    const plan = await planRegrouping(pages, documents, truthful(), null);
    expect(plan.groups.map(g => g.page_ids.join(',')).sort()).toEqual(['a1,a2,a3', 'd1,d2', 'r1,r2']);
    expect(plan.groups.find(g => g.page_ids.includes('a1'))!.from_documents.sort()).toEqual(['X', 'Y']);
    expect(plan.groups.find(g => g.page_ids.includes('a1'))!.page_numbers).toEqual([1, 4, 7]);
    expect(plan.model_calls).toBe(3);
    expect(plan.embeddings).toBe(false);
  });

  it('leaves out a group the upload already has', async () => {
    const documents = [doc('L', ['a1', 'a2', 'a3']), doc('Mixed', ['d1', 'r1', 'r2', 'd2'])];
    const plan = await planRegrouping(pages, documents, truthful(), null);
    expect(plan.unchanged_groups).toBe(1);
    expect(plan.groups.map(g => g.page_ids.join(',')).sort()).toEqual(['d1,d2', 'r1,r2']);
  });

  it('leaves pages with no text where they are, and does nothing with fewer than two pages', async () => {
    const blank = { id: 'b', page_number: 9, raw_text: '   ' };
    const plan = await planRegrouping([...pages, blank], [doc('X', [...pages.map(p => p.id), 'b'])], truthful(), null);
    expect(plan.pages_unreadable).toBe(1);
    expect(plan.groups.flatMap(g => g.page_ids)).not.toContain('b');
    expect((await planRegrouping([pages[0]], [doc('X', ['a1'])], truthful(), null)).groups).toEqual([]);
  });

  it('uses embeddings when it is given them and falls back to words when they fail', async () => {
    const embedded = await planRegrouping(pages, [doc('X', pages.map(p => p.id))], truthful(), async texts => texts.map(() => new Float32Array([1, 0])));
    expect(embedded.embeddings).toBe(true);
    const failed = await planRegrouping(pages, [doc('X', pages.map(p => p.id))], truthful(), async () => { throw new Error('embedding service down'); });
    expect(failed.embeddings).toBe(false);
    expect(failed.groups.length).toBeGreaterThan(0);
  });

  it('hides hidden pages from the analysis', async () => {
    const plan = await planRegrouping(pages.map(p => (p.id === 'a3' ? { ...p, hidden: 1 } : p)), [doc('X', pages.map(p => p.id))], truthful(), null);
    expect(plan.groups.flatMap(g => g.page_ids)).not.toContain('a3');
  });
});
