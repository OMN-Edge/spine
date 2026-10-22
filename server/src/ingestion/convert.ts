import { createWriteStream, readFileSync, renameSync, rmSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'fs';
import { createRequire } from 'node:module';
import path from 'path';
import PDFDocument from 'pdfkit';
import heicConvert from 'heic-convert';
import { ZipReader } from '../archive/zip-read.js';

/**
 * Files that are not a PDF or a photo a model can read, made into one on arrival (FR-ING-01): an iPhone's HEIC photo becomes a
 * JPEG; a Word document or a text file becomes a PDF with a text layer, which the ordinary pipeline then reads like any other.
 * What is kept as the original is the converted file; the checksum used to recognise a repeat stays the one of the file the
 * person sent, so sending it again is still a duplicate.
 */
export type ConvertibleKind = 'heic' | 'docx' | 'txt';

/** A text file is one document of plain text: bigger is a data file, not something to put on pages. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** What goes onto pages: about 300 of them. The rest of a longer text is left off rather than stopping the upload. */
const MAX_TEXT_CHARS = 900_000;
const MAX_DOCX_XML_BYTES = 30 * 1024 * 1024;

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

function head(filePath: string, bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes);
  const fd = openSync(filePath, 'r');
  try {
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

/** HEIC and HEIF stills: an ISO base media file whose first box is `ftyp` with one of the still-image brands (AVIF is not one). */
export function looksLikeHeic(filePath: string): boolean {
  const start = head(filePath, 16);
  return start.length >= 12 && start.toString('latin1', 4, 8) === 'ftyp' && HEIC_BRANDS.has(start.toString('latin1', 8, 12));
}

/** Plain text, by what is in it: small, valid UTF-8, no NUL and almost no control characters. */
export function looksLikeText(filePath: string): boolean {
  if (statSync(filePath).size === 0 || statSync(filePath).size > MAX_TEXT_BYTES) return false;
  const bytes = readFileSync(filePath);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (!text.trim()) return false;
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0) return false;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) control++;
  }
  return control / text.length < 0.01;
}

/** A Word document: a zip with `word/document.xml`. (Any other zip is an archive, opened by `archive/import.ts`.) */
export async function looksLikeDocx(filePath: string): Promise<boolean> {
  let zip: ZipReader | null = null;
  try {
    zip = await ZipReader.open(filePath, 2000);
    const names = new Set(zip.entries.map(e => e.name));
    return names.has('[Content_Types].xml') && names.has('word/document.xml');
  } catch {
    return false;
  } finally {
    zip?.close();
  }
}

/** Which conversion applies to this file, if any. */
export async function convertibleKind(filePath: string): Promise<ConvertibleKind | null> {
  if (looksLikeHeic(filePath)) return 'heic';
  const start = head(filePath, 4);
  if (start.length >= 4 && start[0] === 0x50 && start[1] === 0x4b) return (await looksLikeDocx(filePath)) ? 'docx' : null;
  return looksLikeText(filePath) ? 'txt' : null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 8 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });

/** The text of a Word document's body, a paragraph to a line. Tables come out cell by cell; pictures, headers and footers are left. */
export function textOfDocumentXml(xml: string): string {
  const paragraphs: string[] = [];
  for (const raw of xml.split(/<\/w:p>/)) {
    let line = '';
    for (const match of raw.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g)) {
      line += match[1] !== undefined ? decodeXml(match[1]) : match[0].startsWith('<w:tab') ? '\t' : '\n';
    }
    if (line.trim() || raw.includes('<w:p')) paragraphs.push(line);
  }
  return paragraphs.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const FONT = createRequire(import.meta.url).resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');

/**
 * Text on A4 pages in a font that has the accents of the languages Spine speaks (the standard PDF fonts have no ă, ș or ț),
 * as real text, so the PDF has the text layer the reader uses.
 */
export function textToPdf(text: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, compress: true, info: { Producer: 'Spine', Creator: 'Spine' } });
    const out = createWriteStream(outPath);
    out.on('finish', resolve);
    out.on('error', reject);
    doc.on('error', reject);
    doc.pipe(out);
    doc.font(FONT).fontSize(11);
    doc.text(text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text, { lineGap: 2 });
    doc.end();
  });
}

/**
 * Makes `source` readable. Returns the path of the file to keep (next to the source, with the right extension; the source is
 * removed) and its kind, or null when the file is not one of these.
 */
export async function convertUpload(source: string): Promise<{ path: string; from: ConvertibleKind } | null> {
  const kind = await convertibleKind(source);
  if (!kind) return null;
  const target = path.join(path.dirname(source), `${path.basename(source, path.extname(source))}${kind === 'heic' ? '.jpg' : '.pdf'}`);
  const staged = `${target}.part`;
  try {
    if (kind === 'heic') {
      const jpeg = await heicConvert({ buffer: readFileSync(source), format: 'JPEG', quality: 0.92 });
      writeFileSync(staged, Buffer.from(jpeg));
    } else if (kind === 'txt') {
      await textToPdf(readFileSync(source, 'utf8').replace(/\r\n?/g, '\n'), staged);
    } else {
      const zip = await ZipReader.open(source, 2000);
      try {
        const xml = (await zip.readBuffer('word/document.xml', MAX_DOCX_XML_BYTES)).toString('utf8');
        const text = textOfDocumentXml(xml);
        if (!text) throw new Error('the document has no text');
        await textToPdf(text, staged);
      } finally {
        zip.close();
      }
    }
    renameSync(staged, target);
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  }
  if (target !== source) rmSync(source, { force: true });
  return { path: target, from: kind };
}
