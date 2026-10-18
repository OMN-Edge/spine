/**
 * A small real PDF with a text layer: each page is a list of lines in Helvetica. Hand-written with an accurate cross-reference table,
 * so the sidecar's PDF reader and poppler read it as they read a clinic's export. Latin-1 text only (the font is the standard one):
 * the fixtures are written without diacritics, as many clinic exports are.
 */
export function makeTextPdf(pages: string[][]): Buffer {
  const objects: string[] = []; // index 0 is object 1
  const add = (body: string) => { objects.push(body); return objects.length; };

  const catalog = add('');           // 1, filled below
  const tree = add('');              // 2, filled below
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3
  const kids: number[] = [];
  for (const lines of pages) {
    const escape = (line: string) => line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const stream = ['BT', '/F1 11 Tf', '14 TL', '50 780 Td', ...lines.map(l => `(${escape(l)}) Tj T*`), 'ET'].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
