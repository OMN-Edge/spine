import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pageHtml, writePages } from '../../scripts/seo-pages.mjs';
import { sealBuild } from '../../scripts/seal-build.mjs';

/** What a search engine or a link preview reads of a public page without running a script, and the list the server answers from. */
const made: string[] = [];
function built(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-seo-'));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const SHELL = `<!doctype html><html><head>
    <title>Home</title>
    <meta name="description" content="the home" />
    <meta property="og:title" content="the home" />
    <meta name="apple-mobile-web-app-title" content="Spine" />
    <script type="module" src="/assets/index-A.js"></script>
  </head><body>
    <div id="root"></div>
  </body></html>`;
const PAGE = { path: '/trust', title: 'How to check "Spine"', description: 'Records & keys <sealed>' };

describe('a public page', () => {
  it('has its own title, description and preview text, once each, and the shell’s other tags', () => {
    const html = pageHtml(SHELL, PAGE);
    expect(html).toContain('<title>How to check &quot;Spine&quot;</title>');
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html).toContain('<meta name="description" content="Records &amp; keys &lt;sealed&gt;" />');
    expect(html).toContain('<meta property="og:title" content="How to check &quot;Spine&quot;" />');
    expect(html).not.toContain('the home');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Spine" />');
    expect(html).toContain('<script type="module" src="/assets/index-A.js"></script>');
  });

  it('carries the same text for a reader with no script, and names no address', () => {
    const html = pageHtml(SHELL, PAGE);
    expect(html).toContain('<div id="root"></div>\n    <noscript><h1>How to check &quot;Spine&quot;</h1><p>Records &amp; keys &lt;sealed&gt;</p></noscript>');
    expect(html).not.toMatch(/canonical|og:url|https?:\/\//);
  });
});

describe('a page the build drew', () => {
  it('has its text in the root, where a reader with no script and a search engine find it, and the head it always had', () => {
    const html = pageHtml(SHELL, PAGE, '<main><h1>Records sealed on your device</h1><p>Plain words.</p></main>');
    expect(html).toContain('<div id="root"><main><h1>Records sealed on your device</h1><p>Plain words.</p></main></div>');
    expect(html).toContain('<title>How to check &quot;Spine&quot;</title>');
  });

  it('is written for the front page beside the shell, never into it: the shell is every screen behind a sign-in', () => {
    const dir = built({ 'index.html': SHELL });
    const problems = writePages(dir, [{ path: '/', title: 'Home', description: 'd' }, PAGE], { '/': '<main>the front page</main>', '/trust': '<main>trust</main>' });
    expect(problems).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(SHELL);
    expect(fs.readFileSync(path.join(dir, 'home.html'), 'utf8')).toContain('<div id="root"><main>the front page</main></div>');
    expect(fs.readFileSync(path.join(dir, 'trust/index.html'), 'utf8')).toContain('<div id="root"><main>trust</main></div>');
  });

  it('is not written where the build drew nothing', () => {
    const dir = built({ 'index.html': SHELL });
    writePages(dir, [{ path: '/', title: 'Home', description: 'd' }, PAGE]);
    expect(fs.existsSync(path.join(dir, 'home.html'))).toBe(false);
  });
});

describe('writing the pages', () => {
  it('makes a file for each page but the first, and lists every page for the server', () => {
    const dir = built({ 'index.html': SHELL });
    const problems = writePages(dir, [{ path: '/', title: 'Home', description: 'd' }, PAGE, { path: '/pricing', title: 'Plans', description: 'p', when: 'billing' }]);
    expect(problems).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'trust/index.html'), 'utf8')).toContain('<title>How to check');
    expect(fs.existsSync(path.join(dir, 'pricing/index.html'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(SHELL);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'seo.json'), 'utf8'))).toEqual([{ path: '/' }, { path: '/trust' }, { path: '/pricing', when: 'billing' }]);
  });

  it('refuses a path that is not one word, a repeat and a page with no description', () => {
    const dir = built({ 'index.html': SHELL });
    const problems = writePages(dir, [{ path: '/../x', title: 't', description: 'd' }, PAGE, PAGE, { path: '/a', title: 't', description: '' }]);
    expect(problems.join('\n')).toMatch(/\/\.\.\/x: not a path/);
    expect(problems.join('\n')).toMatch(/\/trust: not a path of one word, or listed twice/);
    expect(problems.join('\n')).toMatch(/\/a: needs a title/);
    expect(fs.existsSync(path.join(dir, '../x'))).toBe(false);
  });

  it('are sealed like the shell: integrity on their scripts, and their hashes listed', () => {
    const dir = built({ 'index.html': SHELL, 'assets/index-A.js': 'x' });
    writePages(dir, [{ path: '/', title: 'Home', description: 'd' }, PAGE]);
    expect(sealBuild(dir, '/nowhere')).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'trust/index.html'), 'utf8')).toMatch(/src="\/assets\/index-A\.js" integrity="sha384-/);
    expect(fs.readFileSync(path.join(dir, 'hashes.txt'), 'utf8')).toMatch(/ {2}trust\/index\.html\n/);
  });
});

describe('the list of pages', () => {
  const root = path.resolve(__dirname, '../..');
  const pages = JSON.parse(fs.readFileSync(path.join(root, 'seo-pages.json'), 'utf8')) as Array<{ path: string; title: string; description: string }>;
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');

  it('starts with the page the shell is, which says the same in its head', () => {
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    expect(pages[0].path).toBe('/');
    expect(index).toContain(`<title>${pages[0].title}</title>`);
    expect(index).toContain(`<meta name="description" content="${pages[0].description}" />`);
    expect(index).toContain(`<meta property="og:title" content="${pages[0].title}" />`);
  });

  it('names only screens anyone can open: each is a route of the app and none is behind a sign-in', () => {
    for (const page of pages.filter(p => p.path !== '/')) {
      const route = new RegExp(`<Route path="${page.path}" element=\\{([^}]*)\\}`).exec(app);
      expect(route, page.path).not.toBeNull();
      expect(route![1], page.path).not.toMatch(/PrivateRoute/);
    }
  });

  it('keeps each title and description a length a search result shows', () => {
    for (const page of pages) {
      expect(page.title.length, page.path).toBeLessThanOrEqual(70);
      expect(page.description.length, page.path).toBeLessThanOrEqual(160);
    }
  });
});
