import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { resolveDataDir } from '../config.js';

const execFileAsync = promisify(execFile);
const TIMEOUT = 5 * 60_000;

/** Runs of consecutive numbers: [3,4,5,9] becomes [[3,5],[9,9]]. */
function runsOf(pages: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const p of [...pages].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else if (!last || p !== last[1]) runs.push([p, p]);
  }
  return runs;
}

/**
 * A new PDF with only these pages of a file (their numbers in that file), in the order given. Poppler's
 * `pdfseparate` and `pdfunite`, which are already needed to read a PDF at all. Used to export one document without
 * the other documents that happen to share its file.
 */
export async function extractPdfPages(source: string, sourcePages: number[]): Promise<Buffer> {
  const tmpRoot = path.join(resolveDataDir(), 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'export-'));
  try {
    for (const [first, last] of runsOf(sourcePages)) {
      await execFileAsync('pdfseparate', ['-f', String(first), '-l', String(last), source, path.join(dir, 'p-%d.pdf')], { timeout: TIMEOUT });
    }
    const parts = sourcePages.map(n => path.join(dir, `p-${n}.pdf`));
    if (parts.length === 1) return fs.readFileSync(parts[0]);
    const out = path.join(dir, 'out.pdf');
    await execFileAsync('pdfunite', [...parts, out], { timeout: TIMEOUT });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
