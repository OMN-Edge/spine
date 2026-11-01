// Runs the real app, end to end, in real Chrome: a server on a temporary data directory, an account, sign-in, the vault set up, the sample
// records written on the device, a reload, and the unlock that brings them back. Then it looks in the server's files for anything readable.
// `npm run check:app` (needs `npm run build` in web/ and server/, and Google Chrome; set CHROME elsewhere than macOS, and CHROME_FLAGS=--no-sandbox where it runs as root or in a container). Exits 1 on a failure.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = path.resolve(import.meta.dirname, '../..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-app-check-'));
// Chrome refuses some ports outright (ERR_UNSAFE_PORT); these are among them, and the check must not draw one.
const UNSAFE = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
let port;
do { port = 3000 + Math.floor(Math.random() * 1000); } while ([port, port + 1000].some(n => UNSAFE.has(n)));
const front = port + 1000; // what the browser talks to: a proxy that adds the production content security policy, as Caddy or nginx do
const RELAY_SECRET = 'app-check-relay-secret-app-check-relay';
const REAL = process.env.SPINE_CHECK_REAL === '1';
// The relay is always a process, started the way it is deployed: its own entry point (dist/relay/main.js) with the model and service account
// of the repository's .env when SPINE_CHECK_REAL=1 (real calls to the real provider, on invented records only), and otherwise the same relay
// with a stand-in model registered in place of a vendor (server/src/testing/stand-in-relay.ts, never built).
let relay, relayProcess;
let modelEnv = {};
if (REAL) {
  const dotenv = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n').map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].replace(/^"(.*)"$/, '$1')]));
  const keep = ['SPINE_LLM_PROVIDER', 'SPINE_LLM_MODEL', 'SPINE_LLM_ENDPOINT', 'SPINE_LLM_REGION', 'SPINE_LLM_PROJECT', 'SPINE_LLM_MODELS', 'SPINE_EMBEDDINGS', 'SPINE_EMBEDDING_ENDPOINT', 'SPINE_EMBEDDING_REGION', 'SPINE_EMBEDDING_PROJECT', 'SPINE_EMBEDDING_MODEL', 'GOOGLE_APPLICATION_CREDENTIALS'];
  modelEnv = Object.fromEntries(keep.filter(k => dotenv[k] !== undefined).map(k => [k, dotenv[k]]));
  if (modelEnv.GOOGLE_APPLICATION_CREDENTIALS && !path.isAbsolute(modelEnv.GOOGLE_APPLICATION_CREDENTIALS)) modelEnv.GOOGLE_APPLICATION_CREDENTIALS = path.join(root, modelEnv.GOOGLE_APPLICATION_CREDENTIALS);
}
{
  const relayPort = 4000 + Math.floor(Math.random() * 1000);
  const calls = [];
  const started = []; // the lines the relay writes about itself, not about a call: `relay ready`
  const [command, args, extraEnv] = REAL
    ? ['node', ['dist/relay/main.js'], modelEnv]
    : [path.join(root, 'node_modules/.bin/tsx'), ['src/testing/stand-in-relay.ts'], { SPINE_LLM_PROVIDER: 'stand-in', SPINE_LLM_MODEL: 'gemini-test', SPINE_EMBEDDINGS: 'stand-in' }];
  relayProcess = spawn(command, args, { cwd: path.join(root, 'server'), env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv, SPINE_RELAY_SECRET: RELAY_SECRET, SPINE_RELAY_ORIGIN: `http://localhost:${front}`, SPINE_DB_PATH: ':memory:', PORT: String(relayPort) }, stdio: ['ignore', 'pipe', 'inherit'] });
  let partial = '';
  relayProcess.stdout.on('data', d => { partial += d; const lines = partial.split('\n'); partial = lines.pop(); for (const l of lines) { try { const { time, ...rest } = JSON.parse(l); if (rest.event) { started.push(rest); continue; } calls.push(rest); } catch { /* not a call line */ } } });
  let exited = false;
  relayProcess.on('exit', () => { exited = true; });
  const url = `http://127.0.0.1:${relayPort}`;
  for (let waited = 0; ; waited += 250) {
    if (exited || waited > 30000) throw new Error('the relay did not start');
    try { await fetch(url + '/healthz'); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  relay = { url, calls, started, close: () => relayProcess.kill() };
}
const standIn = { SPINE_EMBEDDINGS: 'vertex', SPINE_EMBEDDING_ENDPOINT: 'aiplatform.eu.example', SPINE_EMBEDDING_REGION: 'eu', SPINE_EMBEDDING_PROJECT: 'proj-1', SPINE_LLM_PROVIDER: 'vertex', SPINE_LLM_ENDPOINT: 'aiplatform.eu.example', SPINE_LLM_REGION: 'eu', SPINE_LLM_PROJECT: 'proj-1', SPINE_LLM_MODEL: 'gemini-test' };
// The invented root the signed fixture chains to, named as the operator would: a directory of certificates.
const anchors = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-app-check-anchors-'));
fs.copyFileSync(path.join(root, 'core/src/__tests__/fixtures/chain-root.der'), path.join(anchors, 'root.der'));
const env = {
  SPINE_TRUST_ANCHORS_DIR: anchors,
  PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: data, SESSION_SECRET: 'app-check-secret-app-check-secret-1234', PORT: String(port), SPINE_PARSER: 'text',
  ...(REAL ? modelEnv : standIn), // the model settings are the .env's alone in real mode: the relay and the server must describe the same targets
  SPINE_RELAY_URL: relay.url, SPINE_RELAY_SECRET: RELAY_SECRET,
  SPINE_DOMAIN: `localhost:${front}`, // where passkeys belong: the address the browser uses
  SPINE_DEMO_UPLOADS: 'on', SPINE_MULTIMODAL_ENABLED: 'true', // a visitor may read a few files of their own in the demo (SECURITY.md M-39)
};
// An invented two-page file with a text layer.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-app-check-files-')); // not in the server's data directory: that is searched below
const upload = path.join(sandbox, 'invented.pdf');
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of [['Example Clinic - Consultation', 'Patient: Jane Example (invented).'], ['Laboratory report', 'Hemoglobin 13.5 g/dL.']]) {
    const page = doc.addPage([595.28, 841.89]);
    lines.forEach((t, i) => page.drawText(t, { x: 60, y: 760 - i * 28, size: 14, font }));
  }
  fs.writeFileSync(upload, await doc.save());
}
const shownInTimeline = (f, d) => !f.pages.slice(d.page_start - 1, d.page_end).every(pg => pg.hidden); // a document whose every page is set aside is kept, not drawn
const MASTER = 'violet-tractor-9Qx-pelican-ledger-42';

// Invented files for the demo: one longer than the demo reads, and two of one page.
const demoFiles = [];
for (const [name, count] of [['demo-long.pdf', 7], ['demo-two.pdf', 1], ['demo-three.pdf', 1]]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= count; n++) doc.addPage([595.28, 841.89]).drawText(`Demo Example Clinic ${name} - page ${n} of ${count} (invented)`, { x: 60, y: 760, size: 14, font });
  demoFiles.push(path.join(sandbox, name));
  fs.writeFileSync(demoFiles.at(-1), await doc.save());
}
const made = execFileSync('node', ['dist/cli.js', 'create-user', 'check@example.com'], { cwd: path.join(root, 'server'), env, encoding: 'utf8' });
const keeperPassword = execFileSync('node', ['dist/cli.js', 'create-user', 'keeper@example.com'], { cwd: path.join(root, 'server'), env, encoding: 'utf8' }).match(/password \(shown once\): (\S+)/)[1];
const password = made.match(/password \(shown once\): (\S+)/)[1];
const CSP = fs.readFileSync(path.join(root, 'Caddyfile'), 'utf8').match(/Content-Security-Policy "([^"]+)"/)[1].replace('{$SPINE_RELAY_URL:}', relay.url);
const puts = []; // when the owner's device sent a sealed copy
const asked = []; // every address the browsers asked the server for: a key in the part after the # would never be among them
let failVaultWrites = false; // when set, the vault refuses writes, as a server that is down or a vault that is full would
const proxy = http.createServer((req, res) => {
  asked.push(req.url);
  if (failVaultWrites && req.method !== 'GET' && req.method !== 'HEAD' && req.url.startsWith('/api/vault/objects')) {
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'test: the vault is not taking writes' }));
  }
  if (req.method === 'PUT' && req.url.startsWith('/api/shared/')) puts.push(Date.now());
  const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, r => {
    res.writeHead(r.statusCode, { ...r.headers, 'content-security-policy': CSP });
    r.pipe(res);
  });
  req.pipe(up);
}).listen(front);
const serverLogPath = path.join(data, 'server.log');
const serverLog = fs.openSync(serverLogPath, 'w');
let server = spawn('node', ['dist/index.js'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', serverLog, serverLog] });
await new Promise(r => setTimeout(r, 3000));

// ---- What this adds: the phone flows of the feature branch, on a phone-sized screen, with photographed (noisy, colour) pages. ----
const shots = process.env.SHOTS;
fs.mkdirSync(shots, { recursive: true });
let failed = false;
const check = (ok, what, more = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${more ? ` (${more})` : ''}`); if (!ok) failed = true; };
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
try {
  const p = await browser.newPage();
  const diag = [];
  p.on('pageerror', e => diag.push(`page error: ${e.message}`));
  p.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) diag.push(`${r.status()} ${r.url().slice(0, 120)}`); });
  p.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/favicon|status of 404/.test(m.text())) diag.push(`console ${m.type()}: ${m.text().slice(0, 300)}`); });
  const text = () => p.evaluate(() => document.body.innerText);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (what, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if ((await text()).includes(what)) return true; await wait(250); } return false; };
  const waitUntil = async (fn, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if (await p.evaluate(fn)) return true; await wait(250); } return false; };
  const click = async label => { const h = await p.evaluateHandle(l => [...document.querySelectorAll('button,a,label')].find(e => e.offsetParent && e.innerText.trim().toLowerCase().startsWith(l.toLowerCase())), label); await h.asElement().click(); };
  const go = route => p.evaluate(r => { history.pushState(null, '', r); dispatchEvent(new PopStateEvent('popstate')); }, route);
  const shot = name => p.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
  const inPanel = async label => { const h = await p.evaluateHandle(l => [...document.querySelectorAll('aside[role=complementary] button, aside[role=complementary] a')].find(e => e.innerText.trim().startsWith(l)), label); await h.asElement().click(); };
  const press = async label => (await p.$(`button[aria-label="${label}"]`)).click();
  const panelOpen = () => p.evaluate(() => !!document.querySelector('aside[role=complementary]'));

  await p.goto(`http://localhost:${front}/login`, { waitUntil: 'networkidle0' });
  await p.type('input[type=email]', 'check@example.com'); await p.type('input[type=password]', password); await click('Sign in');
  await waitFor('Before you start');
  for (const c of await p.$$('input[type=checkbox]')) await c.click();
  await click('Agree and continue'); await waitFor('Protect your records');
  const pw = await p.$$('input[type=password]'); await pw[0].type(MASTER); await pw[1].type(MASTER); await click('Continue');
  await waitFor('recovery kit'); await (await p.$('input[type=checkbox]')).click(); await click('Continue');
  await waitFor('Open your records'); await p.type('input[type=password]', MASTER); await click('Open');

  // The sample records: results, doctors, and (with the real model) a suggested connection.
  check(await waitFor('Welcome to Spine', 40000), 'the welcome opens');
  const welcome = await text();
  check(!welcome.includes('What is an episode?') && welcome.includes('What can the assistant do?'), 'the welcome offers only the first steps');
  await click('Look around with sample records');
  await waitUntil(() => document.querySelectorAll('a[href^="/documents/"]').length >= 3, 60000);
  if (await panelOpen()) await press('Close');
  await wait(1500);

  // A document with results: the results tip, and not the doctors one at the same time.
  const docs = await p.evaluate(() => [...document.querySelectorAll('a[href^="/documents/"]')].map(a => ({ href: a.getAttribute('href'), text: a.innerText })));
  await go('/trends?name=hemoglobin'); await wait(2500);
  const labHref = await p.evaluate(() => document.querySelector('main a[href^="/documents/"], a[href^="/documents/"]')?.getAttribute('href'));
  console.log('     lab report:', labHref);
  await go(labHref);
  check(await waitFor('These results are also on the Trends page', 20000), 'a document with results shows the results tip');
  check(!(await text()).includes('The doctors this document names'), 'and only that one');
  await shot('t1-results-tip');
  await click('Got it'); await wait(800);
  const after = await text();
  check(!after.includes('These results are also on the Trends page'), 'Got it puts it away');
  console.log('     doctors tip next:', after.includes('The doctors this document names'));
  await go('/trends'); await waitFor('Trends'); await wait(1500);
  check(!(await text()).includes('Each test here is drawn from every document'), 'Trends does not repeat a results tip already put away');
  await shot('t2-after-got-it');

  await shot('t3-trends');
  await go('/doctors'); await waitFor('Doctors'); await wait(1500);
  const doctorsPage = await text();
  console.log('     doctors tip on Doctors:', doctorsPage.includes('Each doctor is listed with the documents that name them'));
  await shot('t4-doctors');
  await go('/review'); await waitFor('Review queue'); await wait(800);
  check((await text()).includes('Documents you have not marked reviewed yet'), 'Review says what it is for');
  await shot('t5-review');
  await go('/search'); await wait(1000);
  check((await text()).includes('Finds documents by the words in them'), 'Search says what it is for');

  // A suggested connection (the real model only): ask for links on the consultation.
  if (REAL) {
    const consult = docs.find(d => /consult/i.test(d.text)) ?? docs[0];
    await go(consult.href); await waitFor('Connected documents', 20000);
    const tipsBefore = await p.evaluate(() => document.querySelectorAll('[role=note]').length);
    if (tipsBefore > 0) { await click('Got it'); await wait(800); }
    await click('Look for links again');
    const found = await waitFor('possibly connected', 90000);
    console.log('     a suggestion came:', found);
    if (found) {
      check(await waitFor('Spine thinks some of these documents belong together', 5000), 'a suggested connection shows the connections tip');
      const box = await p.evaluate(() => document.getElementById('section-chain')?.getBoundingClientRect().top ?? 0);
      await p.evaluate(y => window.scrollTo(0, y + window.scrollY - 80), box);
      await wait(400); await shot('t6-connections');
      await click('Tell me more');
      check(await waitFor('Some documents belong together', 15000), 'Tell me more opens the connected-documents answer');
      await wait(300); await shot('t7-tell-me-more');
    }
  }
  console.log(diag.length ? `browser messages:\n${diag.slice(0, 10).map(d => `     ${d}`).join('\n')}` : 'browser: no errors or warnings');
} catch (err) {
  failed = true; console.log(`FAIL script error: ${err.stack?.split('\n').slice(0, 4).join(' | ')}`);
} finally {
  await browser.close(); relay.close(); server.kill(); proxy.close();
  console.log(failed ? 'FAILED' : 'PASSED');
  process.exit(failed ? 1 : 0);
}
