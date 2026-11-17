import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPdf } from './render.js';
import { DOCS, pageOf } from './specs.js';
import { demoArchiveOf } from './restore.js';

/**
 * Writes the sample archive the demo loads: `archive.json` (what each document was read as, the links, the episodes, the translations) and one PDF for each document.
 * The web build runs it (`web/scripts/demo-archive.mjs`) so the files are made with the build, the same every time, and kept nowhere else.
 */
export async function emitDemoArchive(dir: string): Promise<string[]> {
  const archive = demoArchiveOf();
  const byId = new Map(DOCS.map(d => [d.id, d]));
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const record of archive.records) {
    fs.writeFileSync(path.join(dir, record.pdf), await renderPdf(pageOf(byId.get(record.key)!, byId)));
    written.push(record.pdf);
  }
  fs.writeFileSync(path.join(dir, 'archive.json'), JSON.stringify(archive));
  return [...written, 'archive.json'];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = process.argv[2];
  if (!out) throw new Error('usage: emit.ts <directory>');
  emitDemoArchive(path.resolve(out)).then(files => console.log(`demo archive: ${files.length} files in ${out}`));
}
