import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { resolveDataDir } from '../config.js';

const execFileAsync = promisify(execFile);

export async function rasterizePdf(
  sourceFileId: string,
  filePath: string,
): Promise<Array<{ page_number: number; image_path: string }>> {
  const outDir = path.join(resolveDataDir(), 'pages', sourceFileId);
  fs.mkdirSync(outDir, { recursive: true });

  // pdftoppm renders each page to <outDir>/page-N.png (1-indexed)
  await execFileAsync('pdftoppm', [
    '-r', '200',   // 200 DPI
    '-png',
    filePath,
    path.join(outDir, 'page'),
  ], { timeout: 10 * 60_000 }); // a file that never finishes must not hold the upload forever

  const files = fs.readdirSync(outDir)
    .filter(f => f.endsWith('.png'))
    .sort();

  return files.map((f, idx) => ({
    page_number: idx + 1,
    image_path: path.join(outDir, f),
  }));
}
