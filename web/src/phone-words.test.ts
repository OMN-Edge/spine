import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** What the phone's camera path says (T-19): words for a person, never a setting or the server's wording, and the camera first on Upload. */
const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

describe('the camera path on a phone', () => {
  it('says nothing about switches, OCR or the server on Scan', () => {
    const scan = read('pages/Scan.tsx');
    // What a reader sees is what is passed to t(); a code comment may name the setting.
    const shown = [...scan.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map(m => m[1]).join('\n');
    for (const word of ['switched on', 'OCR', 'this server', 'SPINE_']) expect(shown).not.toContain(word);
    expect(scan).toContain('Reading photos is not available here yet. You can upload a PDF.');
  });

  it('puts "Take a photo" above the file picker on Upload, on a phone only, and only where photos can be read', () => {
    const upload = read('pages/Upload.tsx');
    const button = upload.indexOf("{t('Take a photo')}");
    const picker = upload.indexOf('onDrop={onDrop}');
    expect(button).toBeGreaterThan(0);
    expect(button).toBeLessThan(picker);
    expect(upload).toMatch(/!demo && photos\?\.enabled && \(\s*<Link to="\/scan"[^>]*sm:hidden/);
  });

  it('has Scan in the phone menu', () => {
    expect(read('App.tsx')).toMatch(/<NavLink to="\/scan"[\s\S]*?t\('Scan'\)/);
  });
});

/** The cards and the timeline on a phone (T-21, T-22). */
import { pageRange, pageRef } from './titles';

describe('the page reference of a document', () => {
  const en = (s: string, v?: Record<string, string | number>) => (v ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k])) : s);

  it('is "page 3" or "pages 3–5", written by one helper', () => {
    expect(pageRange(3, 3, en)).toBe('page 3');
    expect(pageRange(3, 5, en)).toBe('pages 3–5');
    expect(pageRange(1, 1, en)).not.toContain('1–1');
  });

  it('is left out for a document of one page, which "p. 1" says nothing about', () => {
    expect(pageRef(1, 1, en)).toBeNull();
    expect(pageRef(2, 4, en)).toBe('pages 2–4');
  });

  it('is not written out by hand in any screen: no "p. {from}–{to}" and no "pages 1–1" ternary is left', () => {
    for (const file of ['components/DocumentCard.tsx', 'pages/Search.tsx', 'pages/ReviewQueue.tsx', 'components/UploadNoticeMessage.tsx', 'components/ProposalCard.tsx', 'pages/Upload.tsx', 'pages/UploadPages.tsx']) {
      const source = read(file);
      expect(source).not.toMatch(/p\. \{from\}/);
      expect(source).not.toMatch(/page_start === [\w.]*page_end \?/);
    }
  });
});

describe('the cards of an upload', () => {
  it('leave out the page of a one-page document, as every other card does', () => {
    const upload = read('pages/Upload.tsx');
    expect(upload).toContain("import { documentTitle, pageRef } from '../titles'");
    expect(upload).not.toMatch(/\bpageRange\(/);
  });
});

describe('the timeline on a phone', () => {
  it('opens its filters from one button that says how many are on, closes them on Apply, and leaves room under the list for the pills', () => {
    const timeline = read('pages/Timeline.tsx');
    expect(timeline).toContain("t('Filter ({count})'");
    expect(timeline).toMatch(/aria-expanded=\{filtersOpen\}/);
    expect(timeline).toContain("setFiltersOpen(false)");
    expect(timeline).toContain('max-md:pb-20');
    expect(timeline).toMatch(/className="md:hidden[^"]*"[^>]*>\s*\{activeFilters > 0/);
  });
});
