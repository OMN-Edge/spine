import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPdf } from './render.js';
import { DOCS, GROUND_TRUTH, PATIENT, pageOf } from './specs.js';

/**
 * Writes the invented archive as PDFs, with the manifest that says what each is and what is related: `npm run demo-archive -w spine-server`. The files are the same every time.
 * They are in `docs/demo/clinic-archive/`, for a demonstration and for the linking evaluation (`__integration__/linking-quality.it.ts`).
 */
export async function buildArchive(dir: string): Promise<Array<{ id: string; file: string; bytes: Buffer }>> {
  const byId = new Map(DOCS.map(d => [d.id, d]));
  const out: Array<{ id: string; file: string; bytes: Buffer }> = [];
  for (const d of DOCS) out.push({ id: d.id, file: `${d.date}-${d.id}.pdf`, bytes: await renderPdf(pageOf(d, byId)) });
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    for (const o of out) fs.writeFileSync(path.join(dir, o.file), o.bytes);
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({
      note: 'Invented patient and documents; nothing here is real.', patient: PATIENT,
      documents: DOCS.map(d => ({ id: d.id, file: `${d.date}-${d.id}.pdf`, cycle: d.cycle, date: d.date, provider: d.provider, label: d.label, duplicateOf: d.duplicateOf ?? null })),
      groundTruth: GROUND_TRUTH,
    }, null, 2)}\n`);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../docs/demo/clinic-archive');
  buildArchive(dir).then(files => console.log(`wrote ${files.length} documents to ${dir}`));
}
