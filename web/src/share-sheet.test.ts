import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { makeShareSheet, sheetLanguage, type SheetInput } from './share-sheet';

/** The PDF sheet for a share link: the link as text and as a code, and what the reader needs to know (the owner's request). */
const font = readFileSync(createRequire(import.meta.url).resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'));
const URL_WITH_KEY = 'https://spine.example/share/3f2a9c1e-7b4d-4e0a-9d51-0c8a6e2b7f14#k=Zm9yX2FfdGVzdF9vbmx5X25vdF9hX3JlYWxfa2V5X2F0X2FsbF9mb3JfdGhlX3NoZWV0';
const input = (over: Partial<SheetInput> = {}): SheetInput => ({ url: URL_WITH_KEY, language: 'en', expiresAt: '2026-11-24T10:00:00.000Z', needsApproval: false, ...over });
const textOf = async (pdf: Uint8Array) => {
  const loaded = await getDocument({ data: new Uint8Array(pdf) }).promise;
  const page = await loaded.getPage(1);
  return { pages: loaded.numPages, text: (await page.getTextContent()).items.map(i => ('str' in i ? i.str : '')).join(' ').replace(/\s+/g, ' ') };
};

describe('the share sheet', () => {
  it('is one page with the title, when it ends, the link in full and a code to scan', async () => {
    const pdf = await makeShareSheet(input({ by: 'Ana Exemplu', note: 'For a new endocrinologist' }), { regular: font });
    expect(Buffer.from(pdf).subarray(0, 4).toString('latin1')).toBe('%PDF');
    const { pages, text } = await textOf(pdf);
    expect(pages).toBe(1);
    for (const shown of ['Medical records shared with you', 'Shared by Ana Exemplu', 'Open until 24 Nov 2026', 'For a new endocrinologist', 'Open this link', 'Scan the code', 'Shared securely via Spine']) expect(text).toContain(shown);
    // The whole address is on the page, wrapped across lines.
    expect(text.replace(/\s/g, '')).toContain(URL_WITH_KEY);
  });

  it('is in the language of the link, with its accents', async () => {
    const { text } = await textOf(await makeShareSheet(input({ language: 'ro' }), { regular: font }));
    expect(text).toContain('Documente medicale partajate cu tine');
    expect(text).toContain('Deschis până la 24.11.2026');
    const german = (await textOf(await makeShareSheet(input({ language: 'de' }), { regular: font }))).text;
    expect(german).toContain('Mit Ihnen geteilte Krankenunterlagen');
  });

  it('says the owner approves each browser where the link needs approval, and that anyone with the link can read it where it does not', async () => {
    expect((await textOf(await makeShareSheet(input({ needsApproval: true, url: 'https://spine.example/share/abc' }), { regular: font }))).text).toContain('approves each browser');
    expect((await textOf(await makeShareSheet(input(), { regular: font }))).text).toContain('Anyone who has this link or code can read the records');
  });

  it('leaves out the name and the note where the owner left them out', async () => {
    const { text } = await textOf(await makeShareSheet(input(), { regular: font }));
    expect(text).not.toContain('Shared by');
    expect(text).not.toContain('Why');
  });

  it('is written in the link’s language, else the owner’s, else English', () => {
    expect(sheetLanguage('de', 'ro')).toBe('de');
    expect(sheetLanguage(null, 'fr')).toBe('fr');
    expect(sheetLanguage('it', 'it')).toBe('en');
    expect(sheetLanguage(undefined, undefined)).toBe('en');
  });
});
