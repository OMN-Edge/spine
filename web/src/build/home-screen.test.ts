import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// What a phone reads when the site is added to its home screen. Nothing else uses these files, so a wrong path or size shows only as a
// blank icon on someone's phone; this checks the page, the manifest and the images agree.
const web = path.resolve(import.meta.dirname, '../..');
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const inPublic = (href: string) => path.join(web, 'public', href.replace(/^\//, ''));

/** Width, height and whether it has an alpha channel, from a PNG's header. */
function png(file: string) {
  const b = fs.readFileSync(file);
  expect(b.subarray(1, 4).toString(), file).toBe('PNG');
  const colourType = b[25];
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), alpha: colourType === 4 || colourType === 6 };
}

const href = (rel: string) => html.match(new RegExp(`<link rel="${rel}" href="([^"]+)"`))?.[1];

describe('the home-screen icon and the manifest', () => {
  it('gives iOS a 180 px opaque PNG (it ignores an SVG, and fills transparency with black)', () => {
    const icon = href('apple-touch-icon');
    expect(icon).toBeDefined();
    expect(png(inPublic(icon!))).toEqual({ width: 180, height: 180, alpha: false });
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Spine" />');
  });

  it('names a manifest whose icons exist at the sizes it states, with one maskable', () => {
    const manifest = JSON.parse(fs.readFileSync(inPublic(href('manifest')!), 'utf8'));
    expect(manifest).toMatchObject({ name: 'Spine', start_url: '/', scope: '/', display: 'standalone' });
    for (const icon of manifest.icons) {
      const [w, h] = icon.sizes.split('x').map(Number);
      const { width, height } = png(inPublic(icon.src));
      expect([width, height], icon.src).toEqual([w, h]);
    }
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
  });
});
