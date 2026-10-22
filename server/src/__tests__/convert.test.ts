import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import sharp from 'sharp';
import { ZipFile } from 'yazl';

process.env.SPINE_DB_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = 'test';

const started = vi.hoisted(() => vi.fn());
vi.mock('../ingestion/pipeline.js', () => ({ startIngestionJob: started, getJobStatus: () => null }));
vi.mock('../parser/index.js', () => ({ aiReadingAllowed: () => true, getParser: () => ({}), getModelParser: () => ({}), resetParser: () => {} }));

import { convertUpload, looksLikeHeic, looksLikeText, looksLikeDocx, textOfDocumentXml } from '../ingestion/convert.js';
import { acceptFile, acceptPhotoSet } from '../ingestion/accept-upload.js';
import { detectFileKind } from '../file-kind.js';
import { getStore } from '../store/index.js';
import { createTestUser, OWNER_ID } from './helpers/seed.js';

const HEIC = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/gradient.heic');
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spine-convert-'));
  process.env.DATA_DIR = dir;
  await createTestUser();
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const textOf = (pdf: string) => execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8' });

/** A Word document with the parts that matter to us: the content-types file and the body. */
function docx(path: string, bodyXml: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'), '[Content_Types].xml');
    zip.addBuffer(Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${bodyXml}</w:body></w:document>`), 'word/document.xml');
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c)).on('end', () => { writeFileSync(path, Buffer.concat(chunks)); resolve(); }).on('error', reject);
  });
}

describe('the text of a Word document', () => {
  it('is one line a paragraph, with tabs, breaks and entities', () => {
    const xml = '<w:p><w:r><w:t>Consult &amp; control</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Doza:</w:t><w:tab/><w:t>5 mg</w:t><w:br/><w:t>de două ori</w:t></w:r></w:p><w:p></w:p><w:p></w:p><w:p></w:p><w:p><w:r><w:t>&#x219;i &#539;</w:t></w:r></w:p>';
    expect(textOfDocumentXml(xml)).toBe('Consult & control\nDoza:\t5 mg\nde două ori\n\nși ț');
  });
});

describe('what is convertible', () => {
  it('recognises a HEIC photo, text and a Word document by their contents, and nothing else', async () => {
    const text = join(dir, 'a.bin'); writeFileSync(text, 'Raport medical\nPacient: invent\n');
    const binary = join(dir, 'b.bin'); writeFileSync(binary, Buffer.from([0, 1, 2, 3, 255, 254, 0, 0]));
    const bad = join(dir, 'c.bin'); writeFileSync(bad, Buffer.from([0x52, 0xff, 0xfe, 0x41]));
    const empty = join(dir, 'd.bin'); writeFileSync(empty, '   \n');
    const word = join(dir, 'e.bin'); await docx(word, '<w:p/>');
    expect(looksLikeHeic(HEIC)).toBe(true);
    expect(looksLikeHeic(text)).toBe(false);
    expect([text, binary, bad, empty].map(looksLikeText)).toEqual([true, false, false, false]);
    expect(await looksLikeDocx(word)).toBe(true);
    expect(await looksLikeDocx(text)).toBe(false);
  });
});

describe('converting', () => {
  it('turns a HEIC photo into a JPEG of the same size', async () => {
    const source = join(dir, 'photo.heic'); copyFileSync(HEIC, source);
    const out = await convertUpload(source);
    expect(out).toMatchObject({ from: 'heic' });
    expect(out!.path.endsWith('.jpg')).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(detectFileKind(out!.path)).toBe('jpeg');
    expect(await sharp(out!.path).metadata()).toMatchObject({ width: 64, height: 64 });
  });

  it('turns text into a PDF whose text layer has the accents', async () => {
    const source = join(dir, 'note.txt'); writeFileSync(source, 'Pacientă: Ioana Invent\r\nTratament: fier, două ori pe zi; control în 3 luni — ș ț ă î â\r\n');
    const out = await convertUpload(source);
    expect(out).toMatchObject({ from: 'txt' });
    expect(detectFileKind(out!.path)).toBe('pdf');
    expect(textOf(out!.path)).toContain('Tratament: fier, două ori pe zi; control în 3 luni — ș ț ă î â');
  });

  it('turns a Word document into a PDF', async () => {
    const source = join(dir, 'letter.docx'); await docx(source, '<w:p><w:r><w:t>Scrisoare medicală</w:t></w:r></w:p><w:p><w:r><w:t>Alergie: penicilină</w:t></w:r></w:p>');
    const out = await convertUpload(source);
    expect(out).toMatchObject({ from: 'docx' });
    expect(textOf(out!.path)).toMatch(/Scrisoare medicală\s+Alergie: penicilină/);
  });

  it('leaves what it does not know alone', async () => {
    const source = join(dir, 'x.bin'); writeFileSync(source, Buffer.from([0, 1, 2, 3]));
    expect(await convertUpload(source)).toBeNull();
    expect(existsSync(source)).toBe(true);
  });
});

describe('arriving as an upload', () => {
  it('keeps the converted file as the original, and a repeat of what was sent is a duplicate', async () => {
    started.mockClear();
    const send = async (id: string) => {
      const source = join(dir, `${id}.txt`); writeFileSync(source, 'Control cardiologie, tensiune 120/80, fără modificări.\n');
      return acceptFile(OWNER_ID, { id, path: source, filename: 'control.txt', checksum: sha(source) });
    };
    const first = await send('11111111-1111-4111-8111-111111111111');
    expect(first).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', status: 'processing' });
    const row = await getStore().sourceFiles.findFor(OWNER_ID, '11111111-1111-4111-8111-111111111111');
    expect(row).toMatchObject({ mime_type: 'application/pdf', original_filename: 'control.txt' });
    expect(row!.file_path.endsWith('.pdf')).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);

    expect(await send('22222222-2222-4222-8222-222222222222')).toMatchObject({ skipped: true, reason: 'duplicate', existing_id: '11111111-1111-4111-8111-111111111111' });
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('refuses a file that is not text, a photo or a document, and removes it', async () => {
    const source = join(dir, 'junk.dat'); writeFileSync(source, Buffer.from([0, 159, 146, 150, 0, 1]));
    expect(await acceptFile(OWNER_ID, { id: '33333333-3333-4333-8333-333333333333', path: source, filename: 'junk.dat', checksum: sha(source) })).toMatchObject({ skipped: true, reason: 'not_pdf' });
    expect(existsSync(source)).toBe(false);
  });

  it('takes HEIC photos among a set of photos', async () => {
    const a = join(dir, 'set-a.photo'); copyFileSync(HEIC, a);
    const jpeg = join(dir, 'set-b.photo'); await sharp({ create: { width: 32, height: 32, channels: 3, background: '#888' } }).jpeg().toFile(jpeg);
    const outcome = await acceptPhotoSet(OWNER_ID, [{ path: a, filename: 'a.heic' }, { path: jpeg, filename: 'b.jpg' }]);
    expect(outcome).toMatchObject({ status: 'processing' });
  });
});
