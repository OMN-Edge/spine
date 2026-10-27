// The browser check's own worker: a PDF with a font it embeds is drawn here the way the core's worker draws one, because a page can load a
// font that a worker cannot (the page images of such a file were once empty boxes, and only this place shows it).
import '../src/core/shims/globals';
import fs, { browserFiles } from '../src/core/shims/fs';
import { useFiles } from 'spine-core/files';
import { useSettings } from 'spine-core/config';
import { deviceSettings } from '../src/core/native/settings';
import { useDigests } from 'spine-core/digest';
import { browserDigests } from '../src/core/native/digests';
import { useNativeTools } from 'spine-core/native-tools';
import { browserTools } from '../src/core/native';
import { rasterizePdf } from '../src/core/native/rasterize';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';

useNativeTools(browserTools);
useFiles(browserFiles);
useSettings(deviceSettings);
useDigests(browserDigests);

/** How many dark pixels a band of the page image holds. */
function ink(data: Uint8ClampedArray, width: number, from: number, to: number): number {
  let n = 0;
  for (let y = from; y < to; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4] < 128) n++;
  return n;
}

(async () => {
  try {
    // One line of the letter I and one of W, as many of each: drawn as letters they hold very different amounts of ink, drawn as the empty boxes a font that did not load gives, the same.
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const face = await doc.embedFont(await (await fetch('/fonts/DejaVuSans.ttf')).arrayBuffer(), { subset: true });
    const page = doc.addPage([595.28, 841.89]);
    page.drawText('I'.repeat(12), { x: 60, y: 700, size: 40, font: face });
    page.drawText('W'.repeat(12), { x: 60, y: 500, size: 40, font: face });
    fs.mkdirSync('/data/originals', { recursive: true });
    fs.writeFileSync('/data/originals/embedded.pdf', await doc.save());
    const [first] = await rasterizePdf('embedded', '/data/originals/embedded.pdf');
    const bitmap = await createImageBitmap(new Blob([fs.readFileSync(first.image_path)], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const rows = (y: number) => Math.round((y / 841.89) * height); // a point from the top of the page, as a row
    const i = ink(data, width, rows(100), rows(200));
    const w = ink(data, width, rows(300), rows(400));
    (self as unknown as Worker).postMessage({ i, w, ratio: i ? w / i : 0 });
  } catch (e) {
    (self as unknown as Worker).postMessage({ error: String((e as Error).stack || e).slice(0, 400) });
  }
})();
