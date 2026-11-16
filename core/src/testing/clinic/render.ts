import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Renders invented clinical documents as real PDFs that look like what a clinic hands over: a coloured letterhead with a logo, a patient box, ruled sections, tables with reference
 * ranges and flags, an ECG on grid paper, a drawn radiograph, a signature and a round stamp with a professional code, a sick-leave form, an invoice. Everything is vector and invented (no real
 * person, clinic or number), written in Romanian with diacritics (Liberation Sans, which ships with PDF.js). The text is a real text layer, so the app reads it as it reads an export.
 */
const require = createRequire(import.meta.url);
const FONTS = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts');
const font = (name: string) => path.join(FONTS, `LiberationSans-${name}.ttf`);

export interface Provider {
  key: string; name: string; sub: string; address: string; contact: string; color: string; tint: string; logo: 'cross' | 'hex' | 'shield' | 'plain' | 'wave' | 'drop' | 'tooth';
}
export interface Patient { name: string; born: string; fileNo: string }

export interface Row { name: string; value: string; unit: string; ref: string; flag?: 'H' | 'L' }
export type Body =
  | { kind: 'letter'; title: string; fields: Array<[string, string]>; sections: Array<{ heading: string; text: string }> }
  | { kind: 'lab'; title: string; fields: Array<[string, string]>; groups: Array<{ heading: string; rows: Row[] }>; note?: string }
  | { kind: 'imaging'; title: string; fields: Array<[string, string]>; sections: Array<{ heading: string; text: string }>; modality: 'xray' | 'echo' }
  | { kind: 'ecg'; title: string; fields: Array<[string, string]>; sections: Array<{ heading: string; text: string }> }
  | { kind: 'rx'; title: string; fields: Array<[string, string]>; items: Array<{ drug: string; dose: string; how: string }>; note?: string }
  | { kind: 'discharge'; title: string; fields: Array<[string, string]>; pages: Array<Array<{ heading: string; text: string }>> }
  | { kind: 'sickleave'; fields: Array<[string, string]>; code: string; days: string; series: string }
  | { kind: 'invoice'; title: string; fields: Array<[string, string]>; lines: Array<[string, string, string]>; total: string };

export interface Page { provider: Provider; patient: Patient; date: string; doctor: { name: string; role: string; code: string } | null; body: Body; scan?: boolean; docNo: string }

type Doc = InstanceType<typeof PDFDocument>;
const W = 595.28, H = 841.89, M = 44;

/** A tiny seeded generator, so the same document is drawn the same every time. */
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}

function logo(doc: Doc, p: Provider, x: number, y: number, size: number, onDark: boolean) {
  const fg = onDark ? '#ffffff' : p.color;
  doc.save();
  switch (p.logo) {
    case 'cross': doc.circle(x + size / 2, y + size / 2, size / 2).lineWidth(2).stroke(fg); doc.rect(x + size * 0.42, y + size * 0.2, size * 0.16, size * 0.6).fill(fg); doc.rect(x + size * 0.2, y + size * 0.42, size * 0.6, size * 0.16).fill(fg); break;
    case 'hex': { const cx = x + size / 2, cy = y + size / 2, r = size / 2; doc.polygon(...[0, 1, 2, 3, 4, 5].map(i => [cx + r * Math.cos(Math.PI / 3 * i), cy + r * Math.sin(Math.PI / 3 * i)] as [number, number])).lineWidth(2).stroke(fg); doc.circle(cx, cy, r * 0.28).fill(fg); break; }
    case 'shield': doc.path(`M ${x} ${y} L ${x + size} ${y} L ${x + size} ${y + size * 0.55} Q ${x + size / 2} ${y + size * 1.15} ${x} ${y + size * 0.55} Z`).lineWidth(2).stroke(fg); doc.rect(x + size * 0.46, y + size * 0.15, size * 0.08, size * 0.55).fill(fg); doc.rect(x + size * 0.28, y + size * 0.3, size * 0.44, size * 0.08).fill(fg); break;
    case 'wave': doc.moveTo(x, y + size / 2).bezierCurveTo(x + size * 0.25, y - size * 0.2, x + size * 0.45, y + size * 1.2, x + size * 0.7, y + size / 2).lineTo(x + size, y + size / 2).lineWidth(3).stroke(fg); break;
    case 'drop': doc.path(`M ${x + size / 2} ${y} Q ${x + size} ${y + size * 0.6} ${x + size / 2} ${y + size} Q ${x} ${y + size * 0.6} ${x + size / 2} ${y} Z`).fill(fg); break;
    case 'tooth': doc.path(`M ${x + size * 0.15} ${y + size * 0.2} Q ${x + size * 0.5} ${y - size * 0.1} ${x + size * 0.85} ${y + size * 0.2} Q ${x + size} ${y + size * 0.7} ${x + size * 0.7} ${y + size} Q ${x + size * 0.55} ${y + size * 0.6} ${x + size * 0.3} ${y + size} Q ${x} ${y + size * 0.7} ${x + size * 0.15} ${y + size * 0.2} Z`).lineWidth(2).stroke(fg); break;
    case 'plain': break;
  }
  doc.restore();
}

function letterhead(doc: Doc, p: Provider, docNo: string, page: number, pages: number) {
  const dark = p.logo !== 'plain';
  if (p.key === 'cabinet') {
    // a family doctor's plain header: name in the accent colour, a thin rule, contact on the right
    doc.font('B').fontSize(17).fillColor(p.color).text(p.name, M, 40, { width: W - 2 * M });
    doc.font('R').fontSize(9).fillColor('#444').text(p.sub, M, 62);
    doc.moveTo(M, 80).lineTo(W - M, 80).lineWidth(1.2).stroke(p.color);
    doc.font('R').fontSize(8).fillColor('#555').text(`${p.address} · ${p.contact}`, M, 85);
  } else {
    doc.rect(0, 0, W, 92).fill(p.color);
    logo(doc, p, M, 24, 44, dark);
    doc.font('B').fontSize(19).fillColor('#ffffff').text(p.name, M + 58, 26, { width: W - 2 * M - 58 });
    doc.font('R').fontSize(9.5).fillColor('#ffffff').opacity(0.9).text(p.sub, M + 58, 52).opacity(1);
    doc.rect(0, 92, W, 4).fill(p.tint);
    doc.font('R').fontSize(8).fillColor('#555').text(`${p.address} · ${p.contact}`, M, 102);
  }
  doc.font('R').fontSize(8).fillColor('#777').text(`${docNo}  ·  pag. ${page}/${pages}`, W - M - 200, H - 30, { width: 200, align: 'right' });
  doc.moveTo(M, H - 38).lineTo(W - M, H - 38).lineWidth(0.5).stroke('#bbbbbb');
  doc.font('R').fontSize(7.5).fillColor('#888').text(`${p.name} · ${p.address}`, M, H - 30, { width: W - 2 * M - 210 });
}

function patientBox(doc: Doc, p: Provider, patient: Patient, fields: Array<[string, string]>, y: number): number {
  const all: Array<[string, string]> = [['Pacient', patient.name], ['Data nașterii', patient.born], ['Nr. fișă', patient.fileNo], ...fields];
  const rows = Math.ceil(all.length / 2);
  const h = rows * 17 + 14;
  doc.roundedRect(M, y, W - 2 * M, h, 5).fillAndStroke(p.tint, p.tint);
  all.forEach(([k, v], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = M + 12 + col * ((W - 2 * M) / 2), yy = y + 8 + row * 17;
    doc.font('R').fontSize(8).fillColor('#555').text(`${k}:`, x, yy + 1, { continued: true }).font('B').fontSize(9).fillColor('#111').text(` ${v}`, { width: (W - 2 * M) / 2 - 20 });
  });
  return y + h + 12;
}

function heading(doc: Doc, p: Provider, text: string, y: number): number {
  doc.font('B').fontSize(10.5).fillColor(p.color).text(text.toUpperCase(), M, y);
  doc.moveTo(M, y + 15).lineTo(W - M, y + 15).lineWidth(0.8).stroke(p.color);
  return y + 22;
}

function paragraph(doc: Doc, text: string, y: number, size = 9.5): number {
  doc.font('R').fontSize(size).fillColor('#111');
  const h = doc.heightOfString(text, { width: W - 2 * M, lineGap: 2 });
  doc.text(text, M, y, { width: W - 2 * M, lineGap: 2 });
  return y + h + 10;
}

function signature(doc: Doc, p: Provider, d: NonNullable<Page['doctor']>, y: number, seed: string) {
  const r = rng(seed);
  doc.font('R').fontSize(8.5).fillColor('#444').text('Medic', M, y).font('B').fontSize(9.5).fillColor('#111').text(d.name, M, y + 12).font('R').fontSize(8.5).fillColor('#444').text(d.role, M, y + 25);
  // a hand-drawn signature
  doc.save().lineWidth(1.4).strokeColor('#1d3b8f');
  const sx = M + 130, sy = y + 18;
  doc.moveTo(sx, sy).bezierCurveTo(sx + 18, sy - 22 * r() - 8, sx + 30, sy + 14, sx + 44, sy - 6).bezierCurveTo(sx + 56, sy - 22, sx + 66, sy + 12, sx + 92, sy - 4).stroke();
  doc.restore();
  // the round stamp: two rings, the name and the professional code, a little off-true
  const cx = M + 262, cy = y + 18;
  doc.save().rotate(-8 + r() * 6, { origin: [cx, cy] }).strokeColor(p.color).lineWidth(1.4).circle(cx, cy, 36).stroke().lineWidth(0.6).circle(cx, cy, 32).stroke();
  // four fixed lines, each shrunk to fit the ring: what it is, the surname, the first name, the professional code
  const [surname, ...given] = d.name.replace(/^Dr\.\s*/, '').toUpperCase().split(' ');
  const line = (text: string, face: 'R' | 'B', size: number, y: number) => {
    let fs = size;
    doc.font(face);
    while (fs > 4.5 && doc.fontSize(fs).widthOfString(text) > 52) fs -= 0.2;
    doc.fontSize(fs).fillColor(p.color).text(text, cx - 26, y, { width: 52, align: 'center', lineBreak: false });
  };
  line('MEDIC', 'B', 5.6, cy - 21);
  line(surname ?? '', 'B', 8, cy - 12);
  line(given.join(' '), 'B', 6.4, cy - 1);
  line('cod parafă', 'R', 5.4, cy + 9);
  line(d.code, 'B', 7, cy + 16);
  doc.restore();
}

function qr(doc: Doc, x: number, y: number, size: number, seed: string) {
  const r = rng(seed), n = 21, c = size / n;
  doc.save().fillColor('#111');
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const finder = (i < 7 && j < 7) || (i < 7 && j >= n - 7) || (i >= n - 7 && j < 7);
    if (finder ? (i % 6 === 0 || j % 6 === 0 || (i % 6 >= 2 && i % 6 <= 4 && j % 6 >= 2 && j % 6 <= 4 && i < 7 && j < 7)) || (j >= n - 7 && (i % 6 === 0 || (j - (n - 7)) % 6 === 0 || ((i % 6) >= 2 && (i % 6) <= 4 && ((j - (n - 7)) % 6) >= 2 && ((j - (n - 7)) % 6) <= 4))) || (i >= n - 7 && (j % 6 === 0 || (i - (n - 7)) % 6 === 0 || ((j % 6) >= 2 && (j % 6) <= 4 && ((i - (n - 7)) % 6) >= 2 && ((i - (n - 7)) % 6) <= 4))) : r() > 0.5) doc.rect(x + j * c, y + i * c, c, c).fill();
  }
  doc.restore();
}

function labTable(doc: Doc, p: Provider, groups: Array<{ heading: string; rows: Row[] }>, y: number): number {
  const cols = [M, M + 200, M + 275, M + 330, M + 440]; // name, value, unit, reference, flag
  for (const g of groups) {
    y = heading(doc, p, g.heading, y);
    doc.rect(M, y, W - 2 * M, 16).fill(p.color);
    doc.font('B').fontSize(8).fillColor('#ffffff');
    ['Analiza', 'Rezultat', 'U.M.', 'Interval de referință', 'Obs.'].forEach((t, i) => doc.text(t, cols[i]! + 5, y + 4));
    y += 16;
    g.rows.forEach((row, i) => {
      if (i % 2 === 0) doc.rect(M, y, W - 2 * M, 16).fill('#f6f7f8');
      doc.font('R').fontSize(9).fillColor('#111').text(row.name, cols[0]! + 5, y + 4, { width: 190 });
      doc.font(row.flag ? 'B' : 'R').fillColor(row.flag ? '#b91c1c' : '#111').text(row.value, cols[1]! + 5, y + 4);
      doc.font('R').fillColor('#444').text(row.unit, cols[2]! + 5, y + 4).text(row.ref, cols[3]! + 5, y + 4);
      if (row.flag) { doc.roundedRect(cols[4]! + 5, y + 3, 18, 11, 3).fill('#fee2e2'); doc.font('B').fontSize(7.5).fillColor('#b91c1c').text(row.flag, cols[4]! + 5, y + 5, { width: 18, align: 'center' }); }
      y += 16;
    });
    y += 10;
  }
  return y;
}

function ecgPanel(doc: Doc, x: number, y: number, w: number, h: number, seed: string) {
  doc.save().rect(x, y, w, h).fill('#fff7f7');
  for (let i = 0; i <= w; i += 5) doc.moveTo(x + i, y).lineTo(x + i, y + h).lineWidth(i % 25 === 0 ? 0.5 : 0.2).stroke('#f3b6b6');
  for (let j = 0; j <= h; j += 5) doc.moveTo(x, y + j).lineTo(x + w, y + j).lineWidth(j % 25 === 0 ? 0.5 : 0.2).stroke('#f3b6b6');
  const r = rng(seed), base = y + h / 2, beat = 58;
  doc.lineWidth(1).strokeColor('#111').moveTo(x, base);
  for (let bx = x; bx < x + w; bx += beat) {
    const j = (r() - 0.5) * 2;
    doc.lineTo(bx + 8, base).bezierCurveTo(bx + 12, base - 6, bx + 16, base - 6, bx + 20, base).lineTo(bx + 24, base + 3).lineTo(bx + 27, base - 34 - j * 3).lineTo(bx + 30, base + 9).lineTo(bx + 34, base).lineTo(bx + 42, base).bezierCurveTo(bx + 46, base - 10, bx + 52, base - 10, bx + 56, base).lineTo(bx + beat, base);
  }
  doc.stroke().restore();
}

function radiograph(doc: Doc, x: number, y: number, w: number, h: number, modality: 'xray' | 'echo', seed: string) {
  const r = rng(seed);
  doc.save().rect(x, y, w, h).fill('#0b0d10');
  if (modality === 'xray') {
    // two lung fields, a spine and ribs, drawn as soft grey shapes
    const g = doc.radialGradient(x + w * 0.3, y + h * 0.45, 4, x + w * 0.3, y + h * 0.45, h * 0.42).stop(0, '#6b7380').stop(1, '#12151a');
    doc.ellipse(x + w * 0.3, y + h * 0.48, w * 0.17, h * 0.34).fill(g);
    const g2 = doc.radialGradient(x + w * 0.7, y + h * 0.45, 4, x + w * 0.7, y + h * 0.45, h * 0.42).stop(0, '#6b7380').stop(1, '#12151a');
    doc.ellipse(x + w * 0.7, y + h * 0.48, w * 0.17, h * 0.34).fill(g2);
    doc.rect(x + w * 0.485, y + 10, w * 0.03, h - 20).fillOpacity(0.55).fill('#c7ccd4').fillOpacity(1);
    for (let i = 0; i < 8; i++) { const yy = y + h * (0.16 + i * 0.085); doc.lineWidth(1.4).strokeOpacity(0.35).strokeColor('#d6dae0').moveTo(x + w * 0.5, yy).bezierCurveTo(x + w * 0.34, yy - 10, x + w * 0.2, yy + 6, x + w * 0.1, yy + 20).stroke().moveTo(x + w * 0.5, yy).bezierCurveTo(x + w * 0.66, yy - 10, x + w * 0.8, yy + 6, x + w * 0.9, yy + 20).stroke(); }
    doc.strokeOpacity(1);
    doc.font('B').fontSize(14).fillColor('#e5e7eb').text('R', x + 12, y + 10);
  } else {
    // an ultrasound sector: a fan of speckle
    doc.save().path(`M ${x + w / 2} ${y + 6} L ${x + w * 0.1} ${y + h - 6} A ${w * 0.55} ${h * 0.95} 0 0 0 ${x + w * 0.9} ${y + h - 6} Z`).clip();
    for (let i = 0; i < 900; i++) doc.circle(x + r() * w, y + r() * h, 0.4 + r() * 1.1).fillOpacity(0.12 + r() * 0.5).fill('#d1d5db');
    doc.restore().fillOpacity(1);
    doc.font('R').fontSize(7).fillColor('#9ca3af').text('3.5 MHz  ·  D 12 cm', x + 8, y + h - 14);
  }
  doc.restore();
}

function formBox(doc: Doc, x: number, y: number, w: number, h: number, label: string, value: string) {
  doc.rect(x, y, w, h).lineWidth(0.8).stroke('#333');
  doc.font('R').fontSize(6.5).fillColor('#555').text(label, x + 3, y + 2, { width: w - 6 });
  doc.font('B').fontSize(10).fillColor('#111').text(value, x + 4, y + h - 15, { width: w - 8 });
}

function draw(doc: Doc, page: Page) {
  const { provider: p, patient, body } = page;
  const total = body.kind === 'discharge' ? body.pages.length : 1;
  const sections = (list: Array<{ heading: string; text: string }>, y: number) => { for (const s of list) { y = heading(doc, p, s.heading, y); y = paragraph(doc, s.text, y); } return y; };
  for (let pg = 1; pg <= total; pg++) {
    if (pg > 1) doc.addPage();
    if (body.kind === 'sickleave') {
      // an official form: a double border, a series and number, boxed fields
      doc.rect(26, 26, W - 52, H - 52).lineWidth(2).stroke('#1e3a8a').rect(31, 31, W - 62, H - 62).lineWidth(0.6).stroke('#1e3a8a');
      doc.font('B').fontSize(9).fillColor('#1e3a8a').text('ROMÂNIA · CASA NAȚIONALĂ DE ASIGURĂRI DE SĂNĂTATE', 0, 46, { width: W, align: 'center' });
      doc.font('B').fontSize(20).fillColor('#111').text('CERTIFICAT DE CONCEDIU MEDICAL', 0, 70, { width: W, align: 'center' });
      doc.font('R').fontSize(10).fillColor('#333').text(`Seria ${body.series}   Nr. ${page.docNo}`, 0, 100, { width: W, align: 'center' });
      let y = 134;
      const box = (cells: Array<[string, string, number]>) => { let x = 48; for (const [l, v, w] of cells) { formBox(doc, x, y, w, 36, l, v); x += w; } y += 36; };
      box([['Numele și prenumele asiguratului', patient.name, 280], ['Data nașterii', patient.born, 100], ['Nr. fișă', patient.fileNo, 120]]);
      box([['Unitatea sanitară', p.name, 280], ['Cod diagnostic (ICD-10)', body.code, 110], ['Nr. zile', body.days, 110]]);
      for (const [k, v] of body.fields) { box([[k, v, 500]]); }
      y += 24;
      doc.font('R').fontSize(9).fillColor('#333').text('Certificatul se eliberează pentru incapacitate temporară de muncă și se prezintă angajatorului în termen de 3 zile.', 48, y, { width: W - 96 });
      if (page.doctor) signature(doc, p, page.doctor, y + 70, page.docNo);
      qr(doc, W - 130, y + 50, 70, page.docNo);
      doc.font('R').fontSize(7.5).fillColor('#777').text(`${page.docNo}  ·  ${p.name}`, M, H - 52);
      continue;
    }
    letterhead(doc, p, page.docNo, pg, total);
    let y = 122;
    if (body.kind === 'discharge') {
      if (pg === 1) { doc.font('B').fontSize(15).fillColor('#111').text(body.title, M, y); y += 26; y = patientBox(doc, p, patient, body.fields, y); }
      y = sections(body.pages[pg - 1]!, y);
      if (pg === total && page.doctor) signature(doc, p, page.doctor, Math.max(y + 10, 640), page.docNo);
      continue;
    }
    if (body.kind === 'invoice') {
      doc.font('B').fontSize(16).fillColor('#111').text(body.title, M, y); y += 28;
      y = patientBox(doc, p, patient, body.fields, y);
      doc.rect(M, y, W - 2 * M, 18).fill(p.color); doc.font('B').fontSize(8.5).fillColor('#fff').text('Serviciu / produs', M + 6, y + 5).text('Cant.', M + 330, y + 5).text('Valoare (RON)', M + 410, y + 5); y += 18;
      body.lines.forEach(([d, q, v], i) => { if (i % 2 === 0) doc.rect(M, y, W - 2 * M, 18).fill('#f6f7f8'); doc.font('R').fontSize(9.5).fillColor('#111').text(d, M + 6, y + 5, { width: 310 }).text(q, M + 330, y + 5).text(v, M + 410, y + 5); y += 18; });
      doc.moveTo(M, y + 4).lineTo(W - M, y + 4).lineWidth(0.8).stroke('#333');
      doc.font('B').fontSize(11).fillColor('#111').text(`TOTAL: ${body.total} RON`, M, y + 12, { width: W - 2 * M, align: 'right' });
      doc.font('R').fontSize(8).fillColor('#666').text('Document justificativ pentru decontare. Achitat integral.', M, y + 40);
      continue;
    }
    doc.font('B').fontSize(15).fillColor('#111').text(body.title, M, y); y += 26;
    y = patientBox(doc, p, patient, body.fields, y);
    if (body.kind === 'letter') y = sections(body.sections, y);
    else if (body.kind === 'lab') { y = labTable(doc, p, body.groups, y); if (body.note) y = paragraph(doc, body.note, y, 8.5); }
    else if (body.kind === 'imaging') { radiograph(doc, W - M - 170, y, 170, 150, body.modality, page.docNo); const keep = y; y = sections(body.sections.slice(0, 1), y); y = Math.max(y, keep + 160); y = sections(body.sections.slice(1), y); }
    else if (body.kind === 'ecg') { ecgPanel(doc, M, y, W - 2 * M, 120, page.docNo); y += 132; y = sections(body.sections, y); }
    else if (body.kind === 'rx') {
      doc.font('B').fontSize(26).fillColor(p.color).text('Rp.', M, y - 6);
      body.items.forEach((it, i) => { doc.font('B').fontSize(10.5).fillColor('#111').text(`${i + 1}. ${it.drug}`, M + 48, y); doc.font('R').fontSize(9.5).fillColor('#333').text(`${it.dose} — ${it.how}`, M + 48, y + 14); y += 38; });
      if (body.note) y = paragraph(doc, body.note, y + 6, 9);
      qr(doc, W - M - 70, 600, 64, page.docNo);
    }
    if (page.doctor) signature(doc, p, page.doctor, Math.max(y + 16, 640), page.docNo);
  }
}

/** One document as PDF bytes. A `scan` copy is the same page a little askew on a greyer sheet, as a document that was scanned and sent again. */
export function renderPdf(page: Page): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `${page.provider.name} ${page.docNo}`, Author: page.provider.name, Producer: 'invented clinical document' }, compress: true });
    doc.registerFont('R', font('Regular')); doc.registerFont('B', font('Bold')); doc.registerFont('I', font('Italic'));
    const chunks: Buffer[] = [];
    doc.on('data', c => chunks.push(c as Buffer)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    if (page.scan) { doc.rect(0, 0, W, H).fill('#f1efe9'); doc.rotate(0.7, { origin: [W / 2, H / 2] }); }
    draw(doc, page);
    doc.end();
  });
}

export const writePdf = (file: string, bytes: Buffer) => fs.writeFileSync(file, bytes);
