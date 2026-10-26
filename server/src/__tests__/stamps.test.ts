import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { makePdf } from 'spine-core/testing/pdf.js';

const mockAllowed = vi.hoisted(() => vi.fn());
const readStamps = vi.hoisted(() => vi.fn());
vi.mock('spine-core/parser/index.js', () => ({ aiReadingAllowed: mockAllowed, getParser: vi.fn(), getModelParser: vi.fn(), resetParser: vi.fn() }));
vi.mock('spine-core/llm/index.js', () => ({ getChatLlm: () => ({ readStamps }) }));

import {
  MAX_STAMPS_PER_DOCUMENT, STAMP_MAX_SIDE, parseImageList, parseSigners, pickStampCandidates, readDigitalSigners, readSignatures, type PdfImage,
} from '../native/signatures.js';

import { hasPoppler } from 'spine-core/testing/tools.js';

describe('reading the list of a PDF’s pictures', () => {
  // As poppler prints it, trimmed to the metadata that matters (the shape of a clinic bulletin's list).
  const listing = `page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio
--------------------------------------------------------------------------------------------
   1     0 image     820   191  rgb     3   8  jpeg   no         3  0   341   341 37.7K 8.2%
   1     1 smask     820   191  gray    1   8  image  no         3  0   341   341 17.7K  12%
   1     2 image     208   114  rgb     3   8  jpeg   no         5  0   240   240 11.8K  17%
   3     5 image     820   191  rgb     3   8  jpeg   no        14  0   341   341 37.7K 8.2%
   3     6 smask     820   191  gray    1   8  image  no        14  0   341   341 17.7K  12%
   3     7 image     207   106  rgb     3   8  jpeg   no        17  0   147   147 18.7K  29%
`;
  it('gives each picture its page, its place on that page, its size and its kind', () => {
    const rows = parseImageList(listing);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ page: 1, index: 0, type: 'image', width: 820, height: 191, size: '37.7K' });
    expect(rows[1]).toMatchObject({ page: 1, index: 1, type: 'smask' });
    // `pdfimages` numbers the files of a page from 0, so the place is counted per page, not taken from `num`.
    expect(rows.slice(3).map(r => [r.page, r.index])).toEqual([[3, 0], [3, 1], [3, 2]]);
  });
  it('skips what it does not understand, and an empty list', () => {
    expect(parseImageList('')).toEqual([]);
    expect(parseImageList('page num\n---\nnot a row at all\n   x  y\n')).toEqual([]);
  });
});

describe('which pictures may be a stamp', () => {
  const img = (page: number, width: number, height: number, size = `${width}B`, type = 'image', index = 0): PdfImage => ({ page, index, type, width, height, size });

  it('keeps a stamp-shaped picture on the last page', () => {
    expect(pickStampCandidates([img(2, 200, 80)], 2)).toHaveLength(1);
  });
  it('only looks at the last page of the document', () => {
    expect(pickStampCandidates([img(1, 200, 80), img(2, 200, 80, '1B')], 2).map(i => i.page)).toEqual([2]);
    expect(pickStampCandidates([img(1, 200, 80)], 2)).toEqual([]);
  });
  it.each([
    ['a QR code or round seal (square)', 330, 330], ['a tall picture', 768, 872], ['a letterhead strip', 820, 191], ['a wide logo', 497, 111],
    ['something tiny', 60, 30], ['too thin', 300, 30],
  ])('leaves out %s', (_n, w, h) => expect(pickStampCandidates([img(1, w, h)], 1)).toEqual([]));
  it('does not cap by size: a large scanned stamp is still a stamp', () => {
    expect(pickStampCandidates([img(1, 1580, 878)], 1)).toHaveLength(1);
  });
  it('leaves out masks and other non-pictures', () => {
    expect(pickStampCandidates([img(1, 200, 80, '1B', 'smask'), img(1, 200, 80, '2B', 'stencil', 1)], 1)).toEqual([]);
  });
  it('leaves out a picture that appears on more than one page: that is a letterhead', () => {
    const logo = [img(1, 207, 106, '18.7K'), img(2, 207, 106, '18.7K')]; // stamp-shaped, but on every page
    expect(pickStampCandidates(logo, 2)).toEqual([]);
    expect(pickStampCandidates([...logo, img(2, 169, 92, '11K', 'image', 1)], 2).map(i => i.width)).toEqual([169]);
  });
  it('keeps the largest few and no more, in a stable order', () => {
    const many = [1, 2, 3, 4, 5, 6].map(i => img(1, 150 + i * 10, 80 + i, `${i}B`, 'image', i));
    const picked = pickStampCandidates(many, 1);
    expect(picked).toHaveLength(MAX_STAMPS_PER_DOCUMENT);
    expect(picked.map(i => i.width)).toEqual([210, 200, 190, 180]);
  });
  it('is what the four real reports needed: the stamps, not the seal, the QR code or the letterhead', () => {
    const lab = [
      img(3, 820, 191, '37.7K', 'image', 0), img(3, 820, 191, '17.7K', 'smask', 1), img(3, 207, 106, '18.7K', 'image', 2), img(3, 169, 92, '11.0K', 'image', 3),
      img(1, 820, 191, '37.7K'), img(2, 820, 191, '37.7K'), img(4, 820, 191, '37.7K', 'image', 0),
      img(4, 768, 872, '222K', 'image', 2), img(4, 170, 121, '12.5K', 'image', 3), img(4, 1580, 878, '181K', 'image', 4),
    ];
    expect(pickStampCandidates(lab, 3).map(i => `${i.width}x${i.height}`)).toEqual(['207x106', '169x92']);
    expect(pickStampCandidates(lab, 4).map(i => `${i.width}x${i.height}`)).toEqual(['1580x878', '170x121']);
  });
});

describe.skipIf(!hasPoppler)('reading stamps out of a real PDF', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'spine-stamps-test-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  // What was sent, looked at while the model call is in progress: the files are removed afterwards.
  let seen: Array<{ width: number; height: number; format: string }>;
  beforeEach(() => {
    mockAllowed.mockReset(); readStamps.mockReset();
    mockAllowed.mockReturnValue(true);
    seen = [];
    readStamps.mockImplementation(async (paths: string[]) => {
      for (const p of paths) { const m = await sharp(p).metadata(); seen.push({ width: m.width!, height: m.height!, format: m.format! }); }
      return { doctors: [{ name: 'Elena Marinescu', specialty: 'medic specialist', code: 'X23456' }] };
    });
  });
  const stampDirs = () => readdirSync(tmpdir()).filter(f => f.startsWith('spine-stamps-') && f !== dir.split('/').pop());

  async function pdf(pages: Parameters<typeof makePdf>[0], name = 'doc.pdf') {
    const file = join(dir, name);
    writeFileSync(file, await makePdf(pages));
    return file;
  }
  const letterhead = { key: 'logo', width: 497, height: 111, shade: 200 };
  const qr = { key: 'qr', width: 330, height: 330, shade: 20 };
  const stamp = { key: 'stamp', width: 200, height: 80, shade: 60 };

  it('sends only the stamp on the last page, never the letterhead or the QR code', async () => {
    const file = await pdf([[letterhead], [qr, stamp]]);
    const result = await readSignatures(file, [2]);
    expect(readStamps).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ width: 200, height: 80, format: 'png' }]);
    expect(result.get(2)).toEqual([{ name: 'Elena Marinescu', specialty: 'medic specialist', code: 'X23456' }]);
  });

  it('reads each document’s last page, once each, with its own pictures', async () => {
    const stampB = { key: 'stampB', width: 180, height: 100, shade: 90 };
    const file = await pdf([[stamp], [letterhead], [stampB]]);
    readStamps.mockImplementation(async (paths: string[]) => ({ doctors: [{ name: `from ${paths.length} image(s)`, specialty: null, code: null }] }));
    const result = await readSignatures(file, [1, 3, 1]);
    expect(readStamps).toHaveBeenCalledTimes(2);
    expect([...result.keys()].sort()).toEqual([1, 3]);
  });

  it('leaves out a stamp-shaped picture that repeats on every page', async () => {
    const repeated = { key: 'repeated', width: 200, height: 80, shade: 50 };
    const file = await pdf([[repeated], [repeated]]);
    await readSignatures(file, [2]);
    expect(readStamps).not.toHaveBeenCalled();
  });

  it('reduces a large stamp before it is sent', async () => {
    const file = await pdf([[{ key: 'big', width: 1580, height: 878, shade: 70 }]]);
    await readSignatures(file, [1]);
    expect(seen).toHaveLength(1);
    expect(Math.max(seen[0].width, seen[0].height)).toBe(STAMP_MAX_SIDE);
    expect(seen[0].width / seen[0].height).toBeCloseTo(1580 / 878, 1);
  });

  it('does not unpack a page that declares more image pixels than allowed', async () => {
    const file = await pdf([[qr, stamp]]); // 108,900 + 16,000 pixels
    expect((await readSignatures(file, [1], 100_000)).size).toBe(0);
    expect(readStamps).not.toHaveBeenCalled();
    expect(stampDirs()).toEqual([]);
    expect((await readSignatures(file, [1], 125_000)).size).toBe(1);
  });

  it('sends nothing, and does not even look, when image reading is off', async () => {
    mockAllowed.mockReturnValue(false);
    const file = await pdf([[stamp]]);
    expect((await readSignatures(file, [1])).size).toBe(0);
    expect(readStamps).not.toHaveBeenCalled();
  });

  it('finds nothing for a report with no stamp, and sends nothing', async () => {
    const file = await pdf([[letterhead, qr]]);
    expect((await readSignatures(file, [1])).size).toBe(0);
    expect(readStamps).not.toHaveBeenCalled();
  });

  it('turns a model failure, an unusable answer, or a file that is not a PDF into no doctors, never an error', async () => {
    const file = await pdf([[stamp]]);
    readStamps.mockRejectedValueOnce(new Error('provider down'));
    expect((await readSignatures(file, [1])).size).toBe(0);
    readStamps.mockResolvedValueOnce(null);
    expect((await readSignatures(file, [1])).size).toBe(0);
    readStamps.mockResolvedValueOnce({ doctors: [] });
    expect((await readSignatures(file, [1])).size).toBe(0);
    const notPdf = join(dir, 'not.pdf'); writeFileSync(notPdf, 'plain text');
    await expect(readSignatures(notPdf, [1])).resolves.toBeInstanceOf(Map);
  });

  it('leaves no copy of a stamp behind', async () => {
    const before = stampDirs();
    const file = await pdf([[stamp]]);
    await readSignatures(file, [1]);
    readStamps.mockRejectedValueOnce(new Error('down'));
    await readSignatures(file, [1]);
    expect(stampDirs()).toEqual(before);
  });
});


describe('who digitally signed a PDF', () => {
  const block = (n: number, dn: string, validation = 'Signature is Valid.', time = 'Mar 04 2026 10:15:00') => `Signature #${n}:
  - Signature Field Name: Signature${n}
  - Signer Certificate Common Name: whoever
  - Signer full Distinguished Name: ${dn}
  - Signing Time: ${time}
  - Signature Type: ETSI.CAdES.detached
  - Signature Validation: ${validation}
  - Certificate Validation: Certificate has Expired
`;
  const head = 'Digital Signature Info of: report.pdf\n';
  const person = 'givenName=Elena,SN=Marinescu,C=RO,serialNumber=XY1234,CN=Elena Marinescu';

  it('names a person by given name and surname, with the signing time', () => {
    expect(parseSigners(head + block(1, person))).toEqual([{ name: 'Elena Marinescu', signedAt: '2026-03-04T10:15:00.000Z' }]);
  });
  it('keeps the order of several signers, and one person who signed twice is one signer', () => {
    const other = 'givenName=Radu,SN=Stoica,C=RO,CN=Radu Stoica';
    expect(parseSigners(head + block(1, person) + block(2, other) + block(3, person)).map(x => x.name)).toEqual(['Elena Marinescu', 'Radu Stoica']);
  });
  it('leaves out a company seal (no given name), and a signature that does not validate', () => {
    expect(parseSigners(head + block(1, 'O=Some Clinic SRL,C=RO,CN=Some Clinic SRL'))).toEqual([]);
    expect(parseSigners(head + block(1, 'SN=Marinescu,CN=Marinescu'))).toEqual([]);
    expect(parseSigners(head + block(1, person, 'Signature is Invalid.'))).toEqual([]);
  });
  it('does not keep the certificate serial number: it identifies a person, it is not a professional code', () => {
    expect(JSON.stringify(parseSigners(head + block(1, person)))).not.toContain('XY1234');
  });
  it('copes with a time it cannot read, and with output that has no signatures', () => {
    expect(parseSigners(head + block(1, person, 'Signature is Valid.', 'not a time'))[0].signedAt).toBeNull();
    expect(parseSigners("File 'x.pdf' does not contain any signatures")).toEqual([]);
    expect(parseSigners('')).toEqual([]);
  });
  it('reads nothing from a file that is not a PDF or does not exist, without throwing', async () => {
    const f = join(tmpdir(), `not-a-pdf-${Date.now()}.pdf`); writeFileSync(f, 'plain');
    expect(await readDigitalSigners(f)).toEqual([]);
    expect(await readDigitalSigners('/no/such/file.pdf')).toEqual([]);
    rmSync(f);
  });
});
