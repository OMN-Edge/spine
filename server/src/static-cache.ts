/**
 * How long a browser may keep a file of the built web app. Vite writes the scripts, styles, fonts and WebAssembly it builds into `assets/`
 * with a hash of their content in the name, so a name never means two different files: they are kept for a year and never asked about
 * again, which on a phone's connection is the difference between one round trip and dozens at every reload (the device's core alone is
 * 7 MB). Everything else (the page itself, the manifest, the icons, the OCR packs) keeps `max-age=0`: it is asked about each time and
 * answered with a few bytes if unchanged. The page is what names the hashed files, so an update reaches everyone at their next visit
 * and nothing can serve an old core (there is deliberately no service worker, CLAUDE.md "Home screen").
 */
const HASHED = /[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

export function cacheControlFor(filePath: string): string | null {
  return HASHED.test(filePath) ? 'public, max-age=31536000, immutable' : null;
}
