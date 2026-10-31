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

  // 1. The first time: the chat opens on the welcome by itself.
  check(await waitFor('Welcome to Spine', 40000), 'the first time, the chat opens on the welcome');
  await wait(400); await shot('g1-welcome');
  await click('How is my data kept private?');
  check(await waitFor('Your records are locked on this device', 15000), 'a question about Spine is answered with the fixed text');
  const help = await text();
  check(help.includes('From Spine’s own help') && help.includes('Getting started'), 'in Getting started, marked as Spine’s own help');
  await wait(300); await shot('g2-help-answer');
  await press('Close');
  check(await waitFor('Get started'), 'the empty timeline has the Get started list');
  await shot('g3-get-started');

  // 2. The next time: no panel over the page, a note that can be put away. (The device saves to the vault every couple of seconds.)
  await waitUntil(() => !/Saving|unsaved/i.test(document.body.innerText), 10000); await wait(4000);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await waitFor('Open your records'); await p.type('input[type=password]', MASTER); await click('Open');
  await waitFor('Get started', 40000); await wait(2500);
  check(!(await panelOpen()), 'the second time the chat does not open by itself');
  // Something was done from the welcome (a question about Spine), so it is over: no note either.
  check(!(await text()).includes('take a look'), 'and, once something was done from the welcome, no note offers it again');
  await shot('g4-second-time');

  // 3. An upload: the grouping tip, Tell me more, and the report in Activity.
  await go('/upload'); await waitFor('Upload');
  await (await p.$('input[type=file]')).uploadFile(upload);
  check(await waitFor('Check the grouping', 60000), 'a two-page upload waits for its grouping');
  check(await waitFor('Spine has guessed where each one starts and ends', 10000), 'with the grouping tip, once');
  await shot('g5-grouping-tip');
  await click('Tell me more');
  check(await waitFor('On the grouping screen you can join documents', 15000), 'Tell me more opens the answer in the chat');
  await wait(300); await shot('g6-tell-me-more');
  await press('History');
  check(await waitFor('Activity', 15000), 'the upload report is in Activity');
  await shot('g7-history');
  await press('Close');
  await go('/upload'); await waitFor('Check the grouping');
  await click('Got it');
  await wait(500);
  check(!(await text()).includes('Spine has guessed where each one starts and ends'), 'Got it puts the tip away');

  // 4. From the chat: Check the grouping leaves the panel; Grouping is right confirms without the assistant, and the report follows by itself.
  await p.click('button[aria-label^="Ask your records"]'); await wait(800);
  await press('History'); await waitFor('Activity'); await click('Activity'); await wait(1500);
  await inPanel('Check the grouping');
  check(await waitUntil(() => location.pathname.startsWith('/uploads/') && !document.querySelector('aside[role=complementary]'), 10000), 'Check the grouping in the chat opens the grouping screen and closes the panel');
  await p.click('button[aria-label^="Ask your records"]'); await wait(1500);
  const relayBefore = relay.calls.filter(c => c.task === 'agent').length;
  await inPanel('Grouping is right');
  check(await waitFor('Grouping confirmed. The documents are being read', 15000), 'Grouping is right in the chat confirms it');
  check(await waitUntil(() => /has been read/.test(document.querySelector('aside[role=complementary]')?.innerText ?? ''), 60000), 'and the report of the documents read appears in the open chat by itself');
  check(relay.calls.filter(c => c.task === 'agent').length === relayBefore, 'without asking the assistant');
  await shot('g7b-confirmed-in-chat');
  await press('Close');
  await go('/'); await wait(3000);
  const tl = await text();
  check(/Your documents are here, newest first/.test(tl), 'after the grouping is confirmed, the timeline explains where the documents are', tl.split('\n').filter(Boolean).slice(0, 12).join(' | '));
  await shot('g8-timeline-after');
  console.log(diag.length ? `browser messages:\n${diag.slice(0, 10).map(d => `     ${d}`).join('\n')}` : 'browser: no errors or warnings');
} catch (err) {
  failed = true; console.log(`FAIL script error: ${err.stack?.split('\n').slice(0, 4).join(' | ')}`);
} finally {
  await browser.close(); relay.close(); server.kill(); proxy.close();
  console.log(failed ? 'FAILED' : 'PASSED');
  process.exit(failed ? 1 : 0);
}
