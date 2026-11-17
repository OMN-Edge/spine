import { expect, it } from 'vitest';
import { describePipeline, describeTarget } from './support/live.js';
import { OWNER_ID, startWorld, until } from './support/world.js';
import { buildArchive } from 'spine-core/testing/clinic/build.js';
import { DOCS, GROUND_TRUTH, expectedOf } from 'spine-core/testing/clinic/specs.js';
import { getStore } from 'spine-core/store/index.js';
import { settleLinking } from 'spine-core/linking/index.js';
import { proposeEpisodes } from 'spine-core/episodes/index.js';

/**
 * Do the suggested links and episodes mean something? The whole flow runs for real, on the invented clinic archive (`core/src/testing/clinic/`): forty PDFs are uploaded, read by the model, their grouping
 * confirmed, embedded, looked at for links, and proposed as episodes; then what the app suggested is marked against what is true of the archive (`GROUND_TRUTH`): a link between two care cycles that
 * is not a real follow-up is false, a link between documents that are only alike in the day, the clinic or the lab is a violation, a copy is not a relative, an episode holds one story and never
 * spans a year. The report is printed first, then the rules are asserted.
 */
const say = (s: string) => console.log(`[quality ${new Date().toISOString().slice(11, 19)}] ${s}`);
const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const spec = new Map(DOCS.map(d => [d.id, d]));
const canonical = (id: string) => spec.get(id)?.duplicateOf ?? id;
const cycleOf = (id: string) => spec.get(canonical(id))!.cycle;
/** Two cycles that are next to each other in one chronic condition: a link between them is a real follow-up. */
const adjacent = (x: string, y: string) => GROUND_TRUTH.conditionChains.some(chain => Math.abs(chain.indexOf(x as never) - chain.indexOf(y as never)) === 1 && chain.includes(x as never) && chain.includes(y as never));
const day = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

describePipeline(`links and episodes on the clinic archive (${describeTarget()})`, () => {
  it('suggests links within a story, none between stories, and episodes that are one story each', async () => {
    const w = await startWorld();
    const store = getStore();
    // QUALITY_LIMIT=3 runs the first few documents only, to see that the flow works before it is run on all
    // QUALITY_ONLY=a,b runs the named documents only, to check one fix without the twenty minutes
    const only = process.env.QUALITY_ONLY?.split(',');
    const files = (await buildArchive('')).filter(f => !only || only.includes(f.id)).slice(0, Number(process.env.QUALITY_LIMIT ?? 1000));
    say(`uploading ${files.length} documents`);

    // 1. Upload each document on its own, as a person would, and remember which spec each upload is.
    const uploads = new Map<string, string>(); // upload id -> spec id
    for (const file of files) {
      const B = 'QualityBoundary';
      const payload = Buffer.concat([Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="files"; filename="${file.file}"\r\nContent-Type: application/pdf\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${B}--`)]);
      const res = await w.app.inject({ method: 'POST', url: '/api/source-files/upload', headers: { cookie: w.cookie, 'content-type': `multipart/form-data; boundary=${B}` }, payload });
      expect(res.statusCode, file.file).toBe(200);
      const answered = res.json() as Array<{ id?: string; upload_id?: string }>;
      if (uploads.size === 0) say(`first upload answered: ${res.body.slice(0, 300)}`);
      const id = answered[0]?.id ?? answered[0]?.upload_id;
      if (!id) throw new Error(`no upload id for ${file.file}: ${res.body.slice(0, 200)}`);
      uploads.set(id, file.id);
    }

    // 2. Each is read; when it is, the grouping (one document each) is confirmed, which reads the document and puts it in the archive.
    say('reading and confirming');
    const confirmed = new Set<string>();
    await until('every upload read and confirmed', async () => {
      for (const id of uploads.keys()) {
        if (confirmed.has(id)) continue;
        const file = await store.sourceFiles.findFor(OWNER_ID, id);
        if (!file) continue;
        if (file.status === 'error') { say(`${uploads.get(id)} could not be read: ${file.error_message ?? 'no reason given'}`); confirmed.add(id); continue; }
        if (file.status !== 'done') continue; // a fresh upload says its grouping is confirmed until its reading ends
        if (file.grouping_confirmed) { confirmed.add(id); continue; }
        const res = await w.app.inject({ method: 'POST', url: `/api/source-files/${id}/grouping/confirm`, headers: { cookie: w.cookie } });
        if (process.env.QUALITY_DEBUG) say(`confirm ${uploads.get(id)} -> ${res.statusCode} ${res.body.slice(0, 120)}`);
        if (res.statusCode === 200) confirmed.add(id);
      }
      if (process.env.QUALITY_DEBUG) say(`confirmed ${confirmed.size}/${uploads.size}`);
      return confirmed.size === uploads.size;
    }, 25 * 60_000, 3000);

    // 3. Links are looked for in the background as documents arrive; wait for that to end, then for the episodes.
    say('looking for links');
    await settleLinking(OWNER_ID);
    await new Promise(r => setTimeout(r, 4000));
    await settleLinking(OWNER_ID);
    await proposeEpisodes(OWNER_ID);

    // 4. What the app holds.
    const docOf = new Map<string, string>(); // document id -> spec id
    const unread: string[] = [];
    for (const [upload, specId] of uploads) {
      const docs = await store.documents.listFor(OWNER_ID, { sourceFileId: upload, limit: 50, offset: 0 });
      if (docs.length === 0) {
        unread.push(specId);
        const file = await store.sourceFiles.findFor(OWNER_ID, upload);
        const all = await store.documents.listFor(OWNER_ID, { sourceFileId: upload, includeHidden: true, includeUnconfirmed: true, limit: 50, offset: 0 });
        if (unread.length <= 2) say(`${specId}: status ${file?.status}, confirmed ${file?.grouping_confirmed}, error ${file?.error_message ?? 'none'}, documents incl. hidden/unconfirmed ${all.length}${all[0] ? ` (needs_reading ${all[0].needs_reading}, title ${all[0].title})` : ''}`);
      }
      for (const d of docs) docOf.set(d.id, specId);
      if (docs.length > 1) say(`${specId} was read as ${docs.length} documents`);
    }
    const byDoc = (id: string) => docOf.get(id);
    const links = (await store.links.all(OWNER_ID)).filter(l => l.state !== 'dismissed' && byDoc(l.from_document_id) && byDoc(l.to_document_id));
    const episodes = await store.episodes.list(OWNER_ID);

    // 4b. What was read from each document, against what it was drawn from.
    const fold = (t: string | null | undefined) => (t ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const misses: string[] = [];
    const tally = { docs: 0, date: 0, type: 0, provider: 0, doctor: 0, doctors: 0, values: 0, valuesTotal: 0, flags: 0 };
    for (const [id, specId] of docOf) {
      const want = expectedOf(spec.get(specId)!, spec);
      const got = await store.documents.findFor(OWNER_ID, id);
      if (!got) continue;
      tally.docs++;
      if (got.doc_date === want.date) tally.date++; else misses.push(`${specId}: date ${got.doc_date} (wanted ${want.date})`);
      if (got.doc_type && want.types.includes(got.doc_type)) tally.type++; else misses.push(`${specId}: type ${got.doc_type} (wanted ${want.types.join(' or ')})`);
      if (want.providerWords.every(wd => fold(got.provider).includes(wd))) tally.provider++; else misses.push(`${specId}: provider "${got.provider}" (wanted ${want.providerWords.join(' ')})`);
      if (want.doctorSurname) {
        tally.doctors++;
        const names = (await store.doctors.forDocument(OWNER_ID, id)).map(d => fold(d.name));
        if (names.some(n => n.includes(want.doctorSurname!))) tally.doctor++; else misses.push(`${specId}: doctor ${want.doctorSurname} not found among [${names.join('; ')}]`);
      }
      if (want.values.length) {
        const results = await store.measurements.listForDocument(OWNER_ID, id);
        for (const v of want.values) {
          tally.valuesTotal++;
          const first = fold(v.test).split(' ')[0]!;
          const match = results.find(m => fold(`${m.canonical} ${m.name}`).includes(first) && String(m.value_text ?? '').replace(',', '.').includes(v.value));
          if (match) tally.values++; else misses.push(`${specId}: value ${v.test} ${v.value} not found`);
          // a value printed high or low is read as high or low, and one printed with no flag is not read as either
          if (match && (match.flag === 'high' ? 'high' : match.flag === 'low' ? 'low' : null) === v.flag) tally.flags++;
          else if (match) misses.push(`${specId}: ${v.test} ${v.value} flagged ${match.flag ?? 'none'} (printed ${v.flag ?? 'none'})`);
        }
      }
    }

    // 5. Mark them.
    const never = new Set(GROUND_TRUTH.never.map(([a, b]) => pairKey(a, b)));
    const cross = new Set(GROUND_TRUTH.crossCycle.map(([a, b]) => pairKey(a, b)));
    const ambiguous = new Set(GROUND_TRUTH.ambiguous.map(([a, b]) => pairKey(a, b)));
    const inCycle: string[] = [], allowed: string[] = [], violations: string[] = [], falseLinks: string[] = [], dupLinks: string[] = [], skipped: string[] = [];
    const seen = new Set<string>();
    for (const l of links) {
      const a = byDoc(l.from_document_id)!, b = byDoc(l.to_document_id)!;
      const describe = `${a} → ${b} (${l.kind}, ${l.state}, ${l.source})`;
      const key = pairKey(canonical(a), canonical(b));
      if (canonical(a) === canonical(b)) { dupLinks.push(describe); continue; }
      if (seen.has(`${key}|${l.kind}`)) continue;
      seen.add(`${key}|${l.kind}`);
      if (ambiguous.has(key)) skipped.push(describe);
      else if (never.has(key)) violations.push(describe);
      else if (cycleOf(a) === cycleOf(b)) inCycle.push(describe);
      else if (cross.has(key) || adjacent(cycleOf(a), cycleOf(b))) allowed.push(describe);
      else falseLinks.push(describe);
    }
    const perDoc = new Map<string, number>();
    for (const l of links) for (const id of [byDoc(l.from_document_id)!, byDoc(l.to_document_id)!]) perDoc.set(id, (perDoc.get(id) ?? 0) + 1);

    // each cycle's documents, connected through links inside it: how much of the story the links hold together
    const cycleReport: string[] = [];
    let connectedTotal = 0, cycleDocsTotal = 0;
    for (const [cycle, ids] of Object.entries(GROUND_TRUTH.cycles)) {
      if (ids.length < 2) continue;
      const parent = new Map(ids.map(i => [i, i]));
      const find = (x: string): string => { while (parent.get(x) !== x) x = parent.get(x)!; return x; };
      for (const l of links) { const a = canonical(byDoc(l.from_document_id)!), b = canonical(byDoc(l.to_document_id)!); if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b)); }
      const sizes = new Map<string, string[]>();
      for (const i of ids) sizes.set(find(i), [...(sizes.get(find(i)) ?? []), i]);
      const biggest = [...sizes.values()].sort((x, y) => y.length - x.length)[0]!;
      connectedTotal += biggest.length; cycleDocsTotal += ids.length;
      cycleReport.push(`${cycle}: ${biggest.length}/${ids.length} connected${biggest.length < ids.length ? ` (apart: ${ids.filter(i => !biggest.includes(i)).join(', ')})` : ''}`);
    }
    const recall = connectedTotal / cycleDocsTotal;

    // episodes: one story each, and never longer than a care cycle
    const episodeReport: string[] = [], impure: string[] = [], tooLong: string[] = [];
    let coveredCycles = 0;
    const multi = Object.entries(GROUND_TRUTH.cycles).filter(([, ids]) => ids.length >= 2).map(([c]) => c);
    const covered = new Set<string>();
    for (const e of episodes.filter(e => e.state !== 'dismissed')) {
      const specs = e.document_ids.map(id => byDoc(id)).filter((x): x is string => !!x).map(canonical);
      const cycles = new Set(specs.map(cycleOf));
      const dates = specs.map(s => day(spec.get(s)!.date));
      const spanDays = dates.length ? Math.max(...dates) - Math.min(...dates) : 0;
      episodeReport.push(`${[...new Set(specs)].join(', ')} — ${spanDays} days, ${cycles.size} ${cycles.size === 1 ? 'story' : 'stories'}`);
      if (cycles.size > 1) impure.push(`${[...cycles].join('+')}: ${[...new Set(specs)].join(', ')}`);
      if (spanDays > GROUND_TRUTH.maxEpisodeDays) tooLong.push(`${spanDays} days: ${[...new Set(specs)].join(', ')}`);
      if (cycles.size === 1) covered.add([...cycles][0]!);
    }
    coveredCycles = multi.filter(c => covered.has(c)).length;

    const precision = (inCycle.length + allowed.length) / Math.max(1, inCycle.length + allowed.length + falseLinks.length + violations.length + dupLinks.length);
    say('——— report ———————————————————————————————————————————————');
    say(`documents read: ${docOf.size} of ${uploads.size}${unread.length ? `; not in the archive: ${unread.join(', ')}` : ''}`);
    const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(0)}%` : 'n/a');
    say(`extraction: date ${pct(tally.date, tally.docs)}, kind ${pct(tally.type, tally.docs)}, provider ${pct(tally.provider, tally.docs)}, doctor ${pct(tally.doctor, tally.doctors)}, lab values ${tally.values}/${tally.valuesTotal} (${pct(tally.values, tally.valuesTotal)}), flags right ${pct(tally.flags, tally.values)}`);
    for (const m of misses) say(`  EXTRACTION MISS ${m}`);
    say(`links: ${links.length} suggested — ${inCycle.length} inside a story, ${allowed.length} real follow-ups between stories, ${falseLinks.length} false between stories, ${violations.length} between documents that must never be linked, ${dupLinks.length} between a document and its copy, ${skipped.length} that are a matter of taste`);
    say(`precision ${(precision * 100).toFixed(0)}%, stories held together ${(recall * 100).toFixed(0)}%, most links on one document ${Math.max(0, ...perDoc.values())}`);
    for (const line of cycleReport) say(`  ${line}`);
    for (const [title, list] of [['FALSE LINKS BETWEEN STORIES', falseLinks], ['NEVER-LINKED PAIRS THAT WERE LINKED', violations], ['A DOCUMENT LINKED TO ITS COPY', dupLinks], ['LINKS OF TASTE', skipped]] as const) if (list.length) { say(title); list.forEach(x => say(`  ${x}`)); }
    say(`episodes: ${episodes.filter(e => e.state !== 'dismissed').length} proposed; ${coveredCycles} of ${multi.length} stories covered by an episode of their own`);
    episodeReport.forEach(x => say(`  ${x}`));
    if (impure.length) { say('EPISODES THAT MIX STORIES'); impure.forEach(x => say(`  ${x}`)); }
    if (tooLong.length) { say(`EPISODES LONGER THAN ${GROUND_TRUTH.maxEpisodeDays} DAYS`); tooLong.forEach(x => say(`  ${x}`)); }

    expect(tally.date / tally.docs, 'documents read with the right date').toBeGreaterThanOrEqual(0.95);
    expect(tally.type / tally.docs, 'documents read as the right kind').toBeGreaterThanOrEqual(0.85);
    expect(tally.provider / tally.docs, 'documents read with the right provider').toBeGreaterThanOrEqual(0.9);
    expect(tally.doctor / Math.max(1, tally.doctors), 'documents whose doctor was found').toBeGreaterThanOrEqual(0.85);
    expect(tally.values / Math.max(1, tally.valuesTotal), 'lab values read as printed').toBeGreaterThanOrEqual(0.9);
    expect(tally.flags / Math.max(1, tally.values), 'values flagged as printed').toBeGreaterThanOrEqual(0.9);
    expect(docOf.size, 'every document should be in the archive').toBeGreaterThanOrEqual(uploads.size);
    expect(violations, 'documents that only share a day, a clinic or a lab').toEqual([]);
    expect(falseLinks, 'links between different stories that are not follow-ups').toEqual([]);
    expect(dupLinks, 'a document linked to its own copy').toEqual([]);
    expect(recall, 'how much of each story the links hold together').toBeGreaterThanOrEqual(0.8);
    expect(impure, 'an episode must be one story').toEqual([]);
    expect(tooLong, 'an episode must not span a year').toEqual([]);
    expect(coveredCycles / multi.length, 'the stories that are an episode of their own').toBeGreaterThanOrEqual(0.7);
  }, 45 * 60_000);
});
