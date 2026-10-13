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

export function getPageImageDimensions(imagePath: string): { width: number; height: number } {
  // Read PNG dimensions from header (bytes 16-24 of the PNG file)
  const buf = Buffer.alloc(24);
  const fd = fs.openSync(imagePath, 'r');
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);

  // PNG header: 8 bytes signature + 4 bytes chunk length + 4 bytes 'IHDR' + 4 bytes width + 4 bytes height
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}
