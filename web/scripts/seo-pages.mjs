// Run after the bundle check and before the build is sealed: give each public page a file of its own, so that what a search engine or a link preview
// reads without running a script (the title, the description, a line of text) is the page's own and not the shell's.
//
// The pages are the app's own shell with the head changed: the same scripts, the same styles, and a title, a description and a short `<noscript>`
// text for the page. Nothing in them names the instance (no address, no canonical link): the same commit builds the same files anywhere, and the
// server adds what depends on the address when it answers (`server/src/seo.ts`). `seo.json` lists the pages for it; `/` is the shell itself, whose
// head is written in `index.html` and checked against the first entry of `seo-pages.json`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The shell with one page's head: its title, description and preview text, its text for a reader with no script, and, where the build drew the page (`prerender.mjs`), the page itself in the root. */
export function pageHtml(shell, page, body = '') {
  const title = escape(page.title);
  const description = escape(page.description);
  const meta = [
    `<meta name="description" content="${description}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
  ].join('\n    ');
  let html = shell.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  html = html.replace(/\s*<meta (?:name="description"|property="og:[a-z]+")[^>]*>/g, '');
  html = html.replace('</title>', `</title>\n    ${meta}`);
  return html.replace('<div id="root"></div>', `<div id="root">${body}</div>\n    <noscript><h1>${title}</h1><p>${description}</p></noscript>`);
}

/**
 * Writes `<path>/index.html` for every page but `/`, and `seo.json` listing all of them. Returns what is wrong. `bodies` are the pages the build drew (path to markup). The front page's
 * is written to `home.html`, not into the shell: the shell is every screen behind a sign-in, and the server gives `home.html` to a visitor with no session (`server/src/seo.ts`).
 */
export function writePages(dir, pages, bodies = {}) {
  const shellFile = path.join(dir, 'index.html');
  if (!fs.existsSync(shellFile)) return ['dist/index.html is missing: build the app first'];
  const shell = fs.readFileSync(shellFile, 'utf8');
  const problems = [];
  const seen = new Set();
  for (const page of pages) {
    if (!/^\/[a-z0-9-]*$/.test(page.path) || seen.has(page.path)) { problems.push(`${page.path}: not a path of one word, or listed twice`); continue; }
    seen.add(page.path);
    if (!page.title || !page.description) problems.push(`${page.path}: needs a title and a description`);
    if (page.path === '/') { if (bodies['/']) fs.writeFileSync(path.join(dir, 'home.html'), pageHtml(shell, page, bodies['/'])); continue; }
    const folder = path.join(dir, page.path.slice(1));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'index.html'), pageHtml(shell, page, bodies[page.path]));
  }
  fs.writeFileSync(path.join(dir, 'seo.json'), `${JSON.stringify(pages.map(({ path: p, when }) => (when ? { path: p, when } : { path: p })))}\n`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pages = JSON.parse(fs.readFileSync(path.join(here, '../seo-pages.json'), 'utf8'));
  // What `prerender.mjs` drew, if it ran: put into the pages, and not kept (it is not a file of the site).
  const drawn = path.join(here, '../dist/prerender.json');
  const bodies = fs.existsSync(drawn) ? JSON.parse(fs.readFileSync(drawn, 'utf8')) : {};
  const problems = writePages(path.join(here, '../dist'), pages, bodies);
  fs.rmSync(drawn, { force: true });
  if (problems.length > 0) {
    console.error(`FAIL the public pages cannot be written:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`public pages written: ${pages.length - 1} files and seo.json (${Object.keys(bodies).length} with their text)`);
}
