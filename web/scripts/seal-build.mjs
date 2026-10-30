// Run at the end of `npm run build`, after the bundle check: seal the built web app.
//
// 1. Every script and stylesheet the page loads gets a Subresource Integrity attribute, so the browser refuses a file that is not the one the
//    page was built with (a cache or a CDN in front of the operator, a half-finished deploy). It does not stop an operator who serves a different
//    page: they would write the attributes too. Dynamic imports and workers are outside what the attribute covers.
// 2. `hashes.txt` lists the SHA-256 of every file in the build, in the format `sha256sum -c` reads. It is built the same way from the same commit
//    anywhere (nothing here depends on the machine, the time or the folder it is built in), so anyone can build the commit, compare the file with
//    the one a site serves, and have a second party's word for what the page is. `scripts/verify-build.mjs` does that comparison.
//
// The build fails if a built file names the folder it was built in, since that would make the same commit build differently elsewhere.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HASHES_FILE = 'hashes.txt';

/** Every file under `dir`, as paths relative to it with `/`, in a fixed order. */
export function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? listFiles(path.join(dir, entry.name), base) : [path.relative(base, path.join(dir, entry.name)).split(path.sep).join('/')])
    .sort();
}

const digest = (bytes, algorithm, encoding) => crypto.createHash(algorithm).update(bytes).digest(encoding);

/** `index.html` with an `integrity` attribute on each same-origin script and stylesheet (or preload) that is a file of this build. Idempotent. */
export function addIntegrity(html, dir) {
  return html.replace(/<(script|link)\b[^>]*>/g, tag => {
    if (/\bintegrity=/.test(tag)) return tag;
    const isScript = tag.startsWith('<script');
    if (!isScript && !/\brel=["']?(stylesheet|modulepreload)\b/.test(tag)) return tag;
    const url = tag.match(isScript ? /\bsrc="(\/[^"?#]+)"/ : /\bhref="(\/[^"?#]+)"/)?.[1];
    const file = url && path.join(dir, url);
    if (!file || !fs.existsSync(file)) return tag;
    return tag.replace(/\s*\/?>$/, ` integrity="sha384-${digest(fs.readFileSync(file), 'sha384', 'base64')}"${tag.endsWith('/>') ? ' />' : '>'}`);
  });
}

/** The lines of `hashes.txt` for the files under `dir` (itself left out). */
export function hashLines(dir) {
  return listFiles(dir).filter(f => f !== HASHES_FILE).map(f => `${digest(fs.readFileSync(path.join(dir, f)), 'sha256', 'hex')}  ${f}`);
}

/** The built text files that name `root`, the folder the build ran in. */
export function buildPathLeaks(dir, root) {
  return listFiles(dir)
    .filter(f => /\.(js|mjs|css|html|json|webmanifest|txt|svg)$/.test(f))
    .filter(f => fs.readFileSync(path.join(dir, f), 'latin1').includes(root));
}

/** Seals `dir`; returns what is wrong (empty when sealed). */
export function sealBuild(dir, root) {
  const leaks = buildPathLeaks(dir, root);
  if (leaks.length > 0) return [`built files name the folder they were built in (${root}), so the same commit would build differently elsewhere: ${leaks.join(', ')}`];
  const index = path.join(dir, 'index.html');
  fs.writeFileSync(index, addIntegrity(fs.readFileSync(index, 'utf8'), dir));
  fs.writeFileSync(path.join(dir, HASHES_FILE), `${hashLines(dir).join('\n')}\n`);
  return [];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const problems = sealBuild(path.join(here, '../dist'), path.resolve(here, '../..'));
  if (problems.length > 0) {
    console.error(`FAIL the build cannot be sealed:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`build sealed: integrity on the page's scripts and styles, ${HASHES_FILE} lists ${hashLines(path.join(here, '../dist')).length} files`);
}
