import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Makes the sample archive the demo loads (core/src/testing/clinic/): the PDFs and `archive.json` (what each document was read as, the links, the episodes, the translations), into
 * `dist/demo/clinic/`. Run by the build before it is sealed, so the files are the same every time and are kept nowhere else; the device fetches them when someone asks for the sample.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../dist/demo/clinic');
execFileSync(process.execPath, ['--import', 'tsx', path.resolve(here, '../../core/src/testing/clinic/emit.ts'), out], { stdio: 'inherit', cwd: path.resolve(here, '..') });
