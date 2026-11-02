import { describe, expect, it } from 'vitest';
import { firstLook, madeOnScreen, routeFiles } from './route';

const file = (name: string, type: string) => new File(['x'], name, { type });

describe('routeFiles: one way in, pictures to Scan', () => {
  it('sends JPEG and PNG to Scan and the rest to upload', async () => {
    const { scan, upload } = await routeFiles([file('a.jpg', 'image/jpeg'), file('b.png', 'image/png'), file('c.pdf', 'application/pdf'), file('d.docx', '')], async () => false);
    expect(scan.map(f => f.name)).toEqual(['a.jpg', 'b.png']);
    expect(upload.map(f => f.name)).toEqual(['c.pdf', 'd.docx']);
  });

  it('sends an iPhone HEIC photo to Scan where the browser can draw it, and uploads it where it cannot', async () => {
    const heic = [file('IMG_0001.HEIC', ''), file('IMG_0002.heic', 'image/heic')];
    expect((await routeFiles(heic, async () => true)).scan).toHaveLength(2);
    const notHere = await routeFiles(heic, async () => false);
    expect(notHere.scan).toHaveLength(0);
    expect(notHere.upload).toHaveLength(2);
  });

  it('tries another picture type, such as WebP, rather than refusing it', async () => {
    expect((await routeFiles([file('x.webp', 'image/webp')], async () => true)).scan).toHaveLength(1);
  });
});

describe('firstLook: a photo of paper is checked and cleaned, a screenshot is kept as it is', () => {
  it('a photo of paper: corners to check (found or placed), cleaned up', () => {
    expect(firstLook({ onScreen: false })).toEqual({ askCorners: true, filter: 'clean' });
  });
  it('a screenshot: the whole picture, uncleaned, no corners asked for', () => {
    expect(firstLook({ onScreen: true })).toEqual({ askCorners: false, filter: 'original' });
  });
  it('knows a screenshot by its type: PNG or GIF, not a camera\'s JPEG or HEIC', () => {
    expect(madeOnScreen(new Blob([], { type: 'image/png' }))).toBe(true);
    expect(madeOnScreen(new Blob([], { type: 'image/jpeg' }))).toBe(false);
    expect(madeOnScreen(new Blob([], { type: 'image/heic' }))).toBe(false);
  });
});
