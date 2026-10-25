// Runs the browser check: builds it, serves it with the production content security policy, opens it in Chrome and prints what each step did.
// `npm run check:browser` (needs Google Chrome; set CHROME to its path elsewhere than macOS, and CHROME_FLAGS=--no-sandbox where it runs as root or in a container). Exits 1 if a step failed or the policy blocked anything.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const here = import.meta.dirname;
try {
  execFileSync('npx', ['vite', 'build', '--config', path.join(here, 'vite.config.mjs')], { cwd: path.join(here, '..'), stdio: 'pipe' });
} catch (err) {
  // A build that fails says why; it was silent before, and the run then went on with whatever was left from the last one.
  console.log(`FAIL the check did not build\n${err.stdout ?? ''}${err.stderr ?? ''}`);
  process.exit(1);
}
const dist = path.join(here, 'dist');
// A signed PDF of your own to try the signature reader on (`SPINE_CHECK_SIGNED=/path/to.pdf`): served from the build folder, which is not kept.
if (process.env.SPINE_CHECK_SIGNED) fs.copyFileSync(process.env.SPINE_CHECK_SIGNED, path.join(dist, 'own-signed.pdf'));
const CSP = fs.readFileSync(path.join(here, '../../Caddyfile'), 'utf8').match(/Content-Security-Policy "([^"]+)"/)[1].replace('{$SPINE_RELAY_URL:}', '');  // Caddy's empty default; no relay in this check
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const file = path.join(dist, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP });
  fs.createReadStream(file).pipe(res);
}).listen(0);
const port = server.address().port;

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: (process.env.CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean) });
let failed = false;
try {
  const page = await browser.newPage();
  const problems = [];
  // A page that fails while it loads never sets a result, and waiting out the clock says nothing about why: the first error ends the wait.
  const crashed = new Promise((_, reject) => page.on('pageerror', e => reject(new Error(`page error before the check finished: ${(e.stack || e.message).split('\n').slice(0, 4).join(' | ')}`))));
  crashed.catch(() => {});
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('console', m => { if (/Content Security Policy|violat/i.test(m.text())) problems.push(m.text()); });
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await Promise.race([page.waitForFunction('window.__result', { timeout: 120000 }), crashed]);
  const result = await page.evaluate('window.__result');
  for (const [name, r] of Object.entries(result)) {
    const bad = r.error !== undefined;
    failed ||= bad;
    console.log(`${bad ? 'FAIL' : 'ok  '} ${name.padEnd(8)} ${bad ? r.error : `${r.ms} ms  ${JSON.stringify(r.ok)}`}`);
  }
  for (const p of problems) { failed = true; console.log(`FAIL ${p}`); }
} catch (err) {
  console.log(`FAIL ${err.message}`);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
