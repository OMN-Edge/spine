import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cacheControlFor } from '../static-cache.js';

describe('which built files a browser may keep', () => {
  it('keeps the files whose names carry a content hash, for a year, and asks about the rest each time', () => {
    for (const hashed of ['/srv/web/dist/assets/core.worker-CDtSMpGI.js', '/srv/web/dist/assets/sqlite3-k2cTanUO.wasm', '/srv/web/dist/assets/inter-latin-ext-wght-normal-DO1Apj_S.woff2', 'C:\\web\\dist\\assets\\index-DdNt8-h0.js']) {
      expect(cacheControlFor(hashed)).toBe('public, max-age=31536000, immutable');
    }
    for (const asked of ['/srv/web/dist/index.html', '/srv/web/dist/theme.js', '/srv/web/dist/manifest.webmanifest', '/srv/web/dist/icons/icon-192.png', '/srv/web/dist/tesseract/core/tesseract-core-simd.wasm', '/srv/web/dist/tesseract/lang/eng.traineddata.gz', '/srv/web/dist/assets/not-hashed.js']) {
      expect(cacheControlFor(asked)).toBeNull();
    }
  });

  // It reads the web build, so it runs where the web app is built and is reported as skipped where it is not (the server's CI job builds
  // only core): a test that returned early passed there having checked nothing.
  const dist = path.resolve(__dirname, '../../../web/dist');
  it.skipIf(!fs.existsSync(path.join(dist, 'assets')))('holds for every file the build writes to assets/, and for nothing the page changes without a new name', () => {
    for (const name of fs.readdirSync(path.join(dist, 'assets'))) expect(cacheControlFor(path.join(dist, 'assets', name)), name).not.toBeNull();
    expect(cacheControlFor(path.join(dist, 'index.html'))).toBeNull();
  });
});
