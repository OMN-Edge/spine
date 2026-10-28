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

const made = execFileSync('node', ['dist/cli.js', 'create-user', 'check@example.com'], { cwd: path.join(root, 'server'), env, encoding: 'utf8' });
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
const server = spawn('node', ['dist/index.js'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', serverLog, serverLog] });
await new Promise(r => setTimeout(r, 3000));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: (process.env.CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean), defaultViewport: { width: 1280, height: 900 } });
let failed = false;
let seen = () => '';
// What the page and the core's worker said that was wrong, and the server's own log: a failed step is explained by these, so the first
// failure prints them (a worker's error is not a page error, and a step that waits for text would otherwise only say it never came).
const diagnostics = [];
const explain = () => {
  for (const d of diagnostics.slice(-15)) console.log(`     browser: ${d}`);
  try { for (const l of fs.readFileSync(serverLogPath, 'utf8').trim().split('\n').slice(-12)) if (l) console.log(`     server: ${l.slice(0, 240)}`); } catch { /* no log */ }
};
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { if (!failed) explain(); failed = true; console.log(`     page says: ${seen().replace(/\s+/g, ' ').slice(0, 300)}`); } };
try {
  // The demo, before any account exists: the app with the sample records, in this browser only, and nothing of it reaches the server.
  {
    const ctx = await browser.createBrowserContext();
    const d = await ctx.newPage();
    d.on('pageerror', e => diagnostics.push(`demo page error: ${e.message}`));
    d.on('console', m => { if (/^(error|warn)/.test(m.type()) || /\[core\]/.test(m.text())) diagnostics.push(`demo console ${m.type()}: ${m.text().slice(0, 300)}`); });
    const said = () => d.evaluate(() => document.body.innerText);
    const waitDemo = async (what, ms = 30000) => { for (let t = 0; t < ms; t += 250) { const now = await said(); seen = () => now; if (now.includes(what)) return true; await new Promise(r => setTimeout(r, 250)); } return false; };
    const press = label => d.evaluate(l => [...document.querySelectorAll('button,a')].find(e => e.offsetParent && e.innerText.trim().startsWith(l))?.click(), label);
    await d.goto(`http://localhost:${front}/`, { waitUntil: 'networkidle0' });
    const from = asked.length;
    await press('Try the demo');
    check(await waitDemo('This is a demo with invented records'), 'the front page opens the demo with no account');
    check(await waitDemo('Chest X-ray'), 'and the demo shows the sample records');
    const nav = await d.evaluate(() => [...document.querySelectorAll('nav a, nav button')].map(e => e.innerText.trim()).filter(Boolean));
    check(!nav.includes('Upload') && !nav.includes('Share links') && !nav.includes('Sign out') && nav.includes('Leave the demo'), `and offers no upload, sharing or account (${nav.join(', ')})`);
    await d.evaluate(() => [...document.querySelectorAll('a')].find(a => a.innerText.includes('Chest X-ray'))?.click());
    check(await waitDemo('the report states that there are no changes', 20000) && (await d.evaluate(() => location.pathname)).startsWith('/documents/'), 'a sample document opens');
    await d.evaluate(() => { history.pushState(null, '', '/upload'); dispatchEvent(new PopStateEvent('popstate')); });
    await new Promise(r => setTimeout(r, 500));
    check(await d.evaluate(() => location.pathname) === '/', 'the upload screen is not in the demo');
    const reached = asked.slice(from).filter(u => /^\/api\/(vault|shared|relay|demo|documents|source-files|auth\/(login|register))/.test(u));
    check(reached.length === 0, `the demo sent the server nothing of the records${reached.length ? `: ${reached.join(', ')}` : ''}`);
    await d.reload({ waitUntil: 'networkidle0' });
    check(await waitDemo('Try the demo', 10000) && !(await said()).includes('Chest X-ray'), 'a reload ends the demo and keeps nothing');
    await press('Try the demo');
    check(await waitDemo('Chest X-ray'), 'the demo opens again');
    await press('Sign in');
    check(await d.waitForSelector('input[type=email]', { visible: true, timeout: 10000 }).then(() => true, () => false), 'and Sign in from the demo ends it and shows the sign-in form');
    await d.evaluate(() => { history.pushState(null, '', '/'); dispatchEvent(new PopStateEvent('popstate')); });
    check(await waitDemo('Try the demo', 10000) && !(await said()).includes('Chest X-ray'), 'after which the front page is the front page again');
    await ctx.close();
  }

  const p = await browser.newPage();
  const errors = [];
  p.on('pageerror', e => { errors.push(e.message); diagnostics.push(`page error: ${(e.stack || e.message).split('\n').slice(0, 3).join(' | ')}`); });
  p.on('console', m => {
    if (/Content Security Policy|violat/i.test(m.text())) errors.push(m.text());
    // The core's worker reports its failures on the page's console (a favicon the server does not have is not one)
    if ((m.type() === 'error' || m.type() === 'warning') && !/favicon|status of 404/.test(m.text())) diagnostics.push(`console ${m.type()}: ${m.text().slice(0, 300)}`);
  });
  let last = '';
  const text = async () => (last = await p.evaluate(() => document.body.innerText));
  seen = () => last;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (what, ms = 20000) => { for (let t = 0; t < ms; t += 250) { if ((await text()).includes(what)) return true; await wait(250); } return false; };
  const click = async label => { const h = await p.evaluateHandle(l => [...document.querySelectorAll('button,a')].find(e => e.offsetParent && e.innerText.trim().toLowerCase().startsWith(l.toLowerCase())), label); await h.asElement().click(); };
  const type = async (sel, v) => { await p.waitForSelector(sel, { visible: true }); await p.type(sel, v); };

  await p.goto(`http://localhost:${front}/login`, { waitUntil: 'networkidle0' });
  await type('input[type=email]', 'check@example.com'); await type('input[type=password]', password); await click('Sign in');
  check(await waitFor('Before you start'), 'the first sign-in asks for consent');
  for (const c of await p.$$('input[type=checkbox]')) await c.click();
  await click('Agree and continue');
  check(await waitFor('Protect your records'), 'then asks for a master password');
  const pw = await p.$$('input[type=password]'); await pw[0].type(MASTER); await pw[1].type(MASTER); await click('Continue');
  check(await waitFor('recovery kit'), 'and shows the recovery kit');
  await (await p.$('input[type=checkbox]')).click(); await click('Continue');
  check(await waitFor('Open your records'), 'the records open only with the master password');
  await type('input[type=password]', MASTER); await click('Open');
  check(await waitFor('Explore with sample records'), 'the empty timeline is shown from the device');
  await click('Explore with sample records');
  check(await waitFor('Chest X-ray'), 'sample records are written on the device');
  for (let t = 0; t < (REAL ? 60000 : 4000) && !relay.calls.some(c => c.task === 'embed'); t += 500) await wait(500);
  check(relay.calls.some(c => c.task === 'embed'), 'each document is embedded through the relay, for search by meaning');
  await (await p.evaluateHandle(() => [...document.querySelectorAll('a')].find(a => a.getAttribute('href')?.startsWith('/documents/')))).asElement().click();
  check(await waitFor('Extracted fields'), 'a document opens');
  await wait(2500);
  const sizes = await p.evaluate(() => [...document.querySelectorAll('img')].map(i => i.naturalWidth));
  check(sizes.some(w => w > 1000), 'its page image comes from the device');
  await wait(3000); // the save
  await p.goto(`http://localhost:${front}/`, { waitUntil: 'networkidle0' });
  check(await waitFor('Open your records'), 'after a reload the key is gone and is asked for again');
  await type('input[type=password]', MASTER); await click('Open');
  check(await waitFor('Chest X-ray'), 'unlocking brings the records back from the vault');
  // Search runs on the device too: the words index and the vectors are in the database it holds.
  await click('Search');
  await type('input[placeholder^="Search documents"]', 'cholecalciferol');
  await p.keyboard.press('Enter');
  check(await waitFor('Prescription', 15000), 'a word search finds a record, from the index on the device');
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);

  // An upload is read on the device, with the model reached through the relay.
  await click('Upload');
  await waitFor('Drag & drop');
  await (await p.$('input[type=file]')).uploadFile(upload);
  check(await waitFor('Check the grouping', REAL ? 240000 : 40000), 'an uploaded PDF is read on the device (text, pages, grouping)');
  const sent = relay.calls.length;
  check(sent > 0, `the model was reached through the relay (${sent} calls)`);
  check(relay.calls.every(c => Object.keys(c).sort().join() === 'bytes_in,model,ms,status,task' && c.status === 200), 'the relay noted only the task, the model, the status and the sizes');
  check(relay.started.some(e => e.event === 'relay ready' && e.provider && 'endpoint' in e && 'region' in e), 'the relay said once, at start, which provider, model, endpoint and region it calls');
  await wait(3000); // the save

  // Sharing: a link is a sealed copy; the key is in the address after the #; a stranger's browser opens it with no account.
  p.on('dialog', d => void d.accept());
  await click('Share links');
  check(await waitFor('Create share link'), 'the share page opens from the device');
  await click('Create link');
  check(await waitFor('Link created', 40000), 'a link is made and sent to the server sealed');
  const direct = (await text()).match(/https?:\/\/\S+\/share\/\S+/)?.[0] ?? '';
  const key = direct.split('#')[1] ?? '';
  check(/^[A-Za-z0-9_-]{43}$/.test(key), 'its address carries the key after the #');

  const guestContext = await browser.createBrowserContext();
  const guest = await guestContext.newPage();
  const guestErrors = [];
  guest.on('pageerror', e => guestErrors.push(e.message));
  const guestText = () => guest.evaluate(() => document.body.innerText);
  const guestWait = async (what, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if ((await guestText()).includes(what)) return true; await wait(250); } return false; };
  await guest.goto(direct, { waitUntil: 'load' });
  check(await guestWait('Chest X-ray'), 'someone with no account opens the link and reads the shared records');
  check(await guestWait('Shared securely via Spine', 2000), 'the shared page carries its footer');
  const footerLeads = async () => { for (let w = 0; w < 5000; w += 250) { const h = await guest.evaluate(() => [...document.querySelectorAll('a')].find(a => a.innerText.includes('Shared securely via Spine'))?.getAttribute('href') ?? null); if (h) return h; await wait(250); } return null; };
  check(await footerLeads() === '/', "and the footer leads to this instance's own front page");
  await (await guest.evaluateHandle(() => [...document.querySelectorAll('a')].find(a => a.innerText.includes('Chest X-ray')))).asElement().click();
  check(await guestWait('Findings', 20000), 'a shared document opens with its details');
  check(!asked.some(u => u.includes(key)), 'the key never went to the server');
  check(guestErrors.length === 0, `no errors on the recipient's page${guestErrors.length ? `: ${guestErrors[0]}` : ''}`);

  // The owner's device collects what the server noted: that it was opened, and where from.
  await click('Timeline');
  await click('Share links');
  const viewed = async () => { for (let t = 0; t < 20000; t += 250) { if (/[1-9]\d* views?/.test(await text())) return true; await wait(250); } return false; };
  check(await viewed(), 'the owner sees that it was opened');

  // Revoking ends it at the server at once.
  await click('Revoke');
  await wait(3000);
  await guest.reload({ waitUntil: 'load' });
  check(await guestWait('no longer active', 20000), 'after revoking, the link no longer opens');

  // The owner connects two documents by hand; a link that shares both lets its recipient see the connection, and only that one.
  await click('Timeline');
  await waitFor('Chest X-ray');
  const xray = (await p.evaluateHandle(() => [...document.querySelectorAll('a')].find(a => a.offsetParent && a.innerText.includes('Chest X-ray')))).asElement();
  if (!xray) console.log('     owner page:', (await text()).replace(/\s+/g, ' ').slice(0, 300));
  await xray.click();
  await waitFor('Connected documents');
  await click('Add a link');
  await type('input[placeholder="Search for a document"]', 'Prescription');
  await p.waitForSelector('li button', { timeout: 15000 }).catch(() => undefined);
  const rx = (await p.evaluateHandle(() => [...document.querySelectorAll('li button')].find(b => b.innerText.includes('Prescription')))).asElement();
  if (!rx) console.log('     picker:', (await text()).replace(/\s+/g, ' ').slice(-400));
  await rx.click();
  await click('Add link');
  check(await waitFor('requested by', 15000), 'the owner connects two documents by hand');

  // A link with the page images and questions allowed: the recipient's trends, scans and a question, all read from the sealed copy.
  await click('Timeline');
  await click('Share links');
  await waitFor('Create share link');
  for (const label of ['Include scans of the original pages', 'Let the recipient ask questions']) {
    await (await p.evaluateHandle(l => [...document.querySelectorAll('label')].find(e => e.innerText.includes(l)).querySelector('input'), label)).asElement().click();
  }
  await click('Create link');
  check(await waitFor('Link created', 40000), 'a link with scans and questions is made');
  const full = (await text()).match(/https?:\/\/\S+\/share\/\S+/)?.[0] ?? '';
  const fullContext = await browser.createBrowserContext();
  const g3 = await fullContext.newPage();
  const g3Errors = [];
  g3.on('pageerror', e => g3Errors.push(e.message));
  const g3Console = [];
  const g3Refused = [];
  g3.on('workercreated', w => w.on?.('console', m => { if (process.env.SPINE_CHECK_DEBUG) g3Console.push(`worker: ${m.text().slice(0, 300)}`); }));
  g3.on('response', r => { if (r.status() === 401) g3Refused.push(new URL(r.url()).pathname); });
  g3.on('console', m => { if (process.env.SPINE_CHECK_DEBUG || /could not|warn|error|fail/i.test(m.text())) g3Console.push(m.text().slice(0, 300)); });
  const g3Text = () => g3.evaluate(() => document.body.innerText);
  const g3Wait = async (what, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if ((await g3Text()).includes(what)) return true; await wait(250); } return false; };
  await g3.goto(full, { waitUntil: 'load' });
  check(await g3Wait('Chest X-ray'), 'the recipient reads a link that includes scans');
  await (await g3.evaluateHandle(() => [...document.querySelectorAll('button,a')].find(e => e.innerText.trim() === 'Trends')))?.asElement()?.click();
  check(await g3Wait('Hemoglobin') || await g3Wait('Cholesterol') || await g3Wait('Glucose'), 'the recipient sees values over time (trends) from the copy');
  await g3.goBack().catch(() => undefined);
  await g3Wait('Chest X-ray');
  await (await g3.evaluateHandle(() => [...document.querySelectorAll('a')].find(a => a.innerText.includes('Chest X-ray')))).asElement().click();
  await g3Wait('Findings', 20000);
  await wait(3000);
  check(await g3Wait('Connected documents', 15000) && /requested by/.test(await g3Text()), 'the recipient sees the connection between the two shared documents');
  check((await g3.evaluate(() => [...document.querySelectorAll('img')].map(i => i.naturalWidth))).some(w => w > 500), 'the recipient sees the page images of a link that includes scans');
  if (process.env.SPINE_CHECK_DEBUG) console.log(JSON.stringify(await g3.evaluate(() => ({ imgs: [...document.querySelectorAll('img')].map(i => [i.naturalWidth, i.alt, i.src.slice(0, 20)]), buttons: [...document.querySelectorAll('button,a')].map(b => b.innerText.trim()).filter(Boolean).slice(0, 40), inputs: [...document.querySelectorAll('textarea,input')].map(i => [i.tagName, i.placeholder, i.getAttribute('aria-label')]) }))));
  // The recipient reads in another language: the translation is made on their device, through the relay, with the pass the share gives.
  {
    const callsBefore = relay.calls.length;
    await g3.goBack().catch(() => undefined);
    await g3Wait('Chest X-ray');
    const box = await g3.$('input[aria-label="Language"]');
    check(!!box, 'the recipient is offered a choice of language');
    if (box) {
      await box.click({ clickCount: 3 });
      await box.type('Rom');
      await g3.keyboard.press('Enter');
      let said = false;
      for (let t = 0; t < (REAL ? 90000 : 30000) && !said; t += 1000) { await wait(1000); said = /Translated into|Translating into|Se traduce|Tradus/.test(await g3.evaluate(() => document.body.innerText)); }
      if (!said) console.log('     recipient page:', (await g3.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 500), '| console:', g3Console.slice(-4));
      check(said, 'the recipient’s page translates into the language they picked');
      // A real model takes its time: the calls are counted once they have had it.
      for (let t = 0; t < (REAL ? 90000 : 5000) && !relay.calls.slice(callsBefore).some(c => c.task === 'translation'); t += 1000) await wait(1000);
      const translations = relay.calls.slice(callsBefore).filter(c => c.task === 'translation').length;
      check(translations > 0, `the translation went to the model through the relay (${translations} call(s))`);
      check(/Istoric medical|Documente/.test(await g3.evaluate(() => document.body.innerText)), 'the page itself is in the language they picked');
      // Back to English, for the rest of the checks.
      await box.click({ clickCount: 3 });
      await box.type('Eng');
      await g3.keyboard.press('Enter');
      await wait(1500);
    }
    await (await g3.evaluateHandle(() => [...document.querySelectorAll('a')].find(a => a.innerText.includes('Chest X-ray')))).asElement()?.click();
    await g3Wait('Findings', 20000);
  }
  const before = relay.calls.length;
  const pageText = () => g3.evaluate(() => [...document.querySelectorAll('*')].filter(e => e.children.length === 0).map(e => e.textContent?.trim()).filter(Boolean).join(' | '));
  const baseline = (await pageText()).length;
  await (await g3.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Ask')))?.asElement()?.click();
  await wait(1000);
  const ask = await g3.$('textarea[aria-label="Your question"]');
  check(!!ask, 'the recipient is offered a question box');
  if (ask) {
    await ask.type('What is in this record?');
    await g3.keyboard.press('Enter');
    for (let t = 0; t < 30000 && relay.calls.length === before; t += 500) await wait(500);
    if (REAL) await wait(45000); // a real model answers in its own time
    const asked = relay.calls.slice(before).filter(c => c.task !== 'embed');
    check(asked.length > 0, `a question from the recipient reaches the model through the relay (${asked.map(c => c.task).join(',') || 'only embeddings'})`);
    if (process.env.SPINE_CHECK_DEBUG) console.log('     refused (401):', g3Refused);
    // The reply comes back through the streamed path and ends the question: the box is ready again and the page shows an answer or its refusal.
    await wait(4000);
    let everything = '';
    for (let t = 0; t < (REAL ? 90000 : 20000); t += 500) {
      everything = await g3.evaluate(() => [...document.querySelectorAll('*')].filter(e => e.children.length === 0).map(e => e.textContent?.trim()).filter(Boolean).join(' | '));
      if (/sample answer|Could not answer/i.test(everything) || (REAL && /\[D\d|Sources|Answers are written/.test(everything) && !/What is in this record\?\s*\|\s*Ask/.test(everything) && t > 15000)) break;
      await wait(500);
    }
    check(everything.includes('What is in this record?'), 'the question stays on screen in the recipient\'s panel');
    if (process.env.SPINE_CHECK_DEBUG) console.log('     recipient console:', g3Console.slice(-14));
    // The stand-in model is not a real one (its streamed answer may not satisfy the agent), so what is held to is that the question ends:
    // the reply, or its refusal, comes over the streamed channel and the panel settles. A full answer needs a real model.
    check(REAL ? !/Could not answer just now/.test(everything) && /What is in this record\?/.test(everything) && everything.length > baseline + 120 : /A sample answer\.|Could not answer just now/.test(everything), REAL ? 'a real model answers the recipient\'s question over the streamed channel, with an answer of its own words' : 'the reply to the question comes back over the streamed channel');
  }
  check(g3Errors.length === 0, `no errors on the recipient's page with scans and questions${g3Errors.length ? `: ${g3Errors[0]}` : ''}`);
  await fullContext.close();
  await click('Timeline'); // leaving the page clears the form and the banner of the link just made
  await click('Share links');
  await waitFor('Create share link');

  // A link that needs approval has no key in it; the owner's device wraps the key to the visitor's own.
  await p.waitForSelector('input[type=checkbox]');
  const boxes = await p.$$('input[type=checkbox]');
  await boxes[2].click();
  await click('Create link');
  check(await waitFor('Link created', 40000), 'a link that needs approval is made');
  const gated = (await text()).match(/https?:\/\/\S+\/share\/[A-Za-z0-9_-]+(#\S*)?/g)?.pop() ?? '';
  check(gated.length > 0 && !gated.includes('#'), 'its address has no key in it');
  const guest2 = await (await browser.createBrowserContext()).newPage();
  const guest2Text = () => guest2.evaluate(() => document.body.innerText);
  const guest2Wait = async (what, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if ((await guest2Text()).includes(what)) return true; await wait(250); } return false; };
  await guest2.goto(gated, { waitUntil: 'load' });
  check(await guest2Wait('Approval needed'), 'a stranger is asked to request access');
  await (await guest2.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.innerText.startsWith('Ask for access')))).asElement().click();
  check(await guest2Wait('request was sent'), 'the request is sent with the browser\'s own public key');
  await click('Timeline');
  await click('Share links');
  check(await waitFor('Waiting for your approval', 20000), 'the owner sees the request');
  await click('Approve');
  check(await guest2Wait('Chest X-ray', 40000), 'once approved, that browser (and only it) opens the records');

  // Opt-in: upload a digitally signed PDF and see its signer filed as a doctor on the device. `SPINE_CHECK_SIGNED=/path/to/signed.pdf`.
  // The expected name is read by poppler's pdfsig in this script; only whether the page shows it is printed, never the name.
  // Without it an invented file made for this (core/src/__tests__/fixtures) is used, and its signer is also held to being verified, since the
  // certificates in it chain to the invented root named above.
  {
    const own = !!process.env.SPINE_CHECK_SIGNED;
    const file = own ? process.env.SPINE_CHECK_SIGNED : path.join(root, 'core/src/__tests__/fixtures/signed-chain-good.pdf');
    const dn = own ? (() => { try { return execFileSync('pdfsig', [file], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch (e) { return String(e.stdout ?? ''); } })() : '';
    const full = dn.match(/Signer full Distinguished Name: (.+)/)?.[1] ?? '';
    const given = own ? full.match(/givenName=([^,]+)/)?.[1] : 'Ana', surname = own ? full.match(/SN=([^,]+)/)?.[1] : 'Exemplu';
    check(!!given && !!surname, 'the signed file has a personal signature to look for');
    // Only the core's warnings about signatures and filing are shown, never the records.
    const coreLogs = [];
    p.on('console', m => { if (/signature|signers|could not|fail|invalid|schema|error|stamp/i.test(m.text())) coreLogs.push(m.text().slice(0, 200)); });
    p.workers().forEach(w => w.on?.('console', m => { if (/signature|signers|could not|fail|invalid|schema|error|stamp/i.test(m.text())) coreLogs.push(`worker: ${m.text().slice(0, 200)}`); }));
    const noticeLinks = () => p.evaluate(() => [...document.querySelectorAll('a')].filter(e => e.innerText.trim().startsWith('Check the grouping')).map(e => e.getAttribute('href')));
    const already = await noticeLinks();
    await click('Upload');
    await waitFor('Drag & drop');
    await (await p.$('input[type=file]')).uploadFile(file);
    check(await waitFor('Check the grouping', REAL ? 240000 : 60000), 'the signed PDF is read on the device');
    // Every upload waiting is confirmed (the earlier invented one too), so the signed file's cannot be missed.
    await wait(3000);
    const waiting = await noticeLinks();
    for (const href of waiting) {
      if (!(await noticeLinks()).includes(href)) { await click('Upload'); await wait(2000); } // the notices are on the upload page
      await (await p.evaluateHandle(h => [...document.querySelectorAll('a')].find(e => e.getAttribute('href') === h), href)).asElement().click();
      if (await waitFor('Grouping is right', 20000)) { await click('Grouping is right'); await wait(1500); }
      await click('Timeline'); await wait(1500);
    }
    // The reading is done when the line saying so has come and gone, and the page has left the grouping screen.
    await waitFor('Reading the documents', 10000);
    for (let t = 0; t < (REAL ? 300000 : 120000); t += 2000) { await wait(2000); const now = await text(); if (!now.includes('Reading the documents') && !now.includes('Grouping is right')) break; }
    await wait(3000);
    const after = await text();
    console.log('     upload page after confirming:', ['could not be read', 'Reading the documents', 'Grouping is right', 'Read again', 'failed', 'error'].filter(w => after.includes(w)));
    await click('Doctors');
    await wait(3000);
    const page = (await text()).toLowerCase();
    const shown = page.includes(`${given} ${surname}`.toLowerCase());
    if (!shown) console.log('     doctors page has the given name:', page.includes(given.toLowerCase()), 'the surname:', page.includes(surname.toLowerCase()), '| the file says the order', (await text()).toLowerCase().indexOf(surname.toLowerCase()) < (await text()).toLowerCase().indexOf(given.toLowerCase()) ? 'surname first' : 'given first');
    if (!shown) { await click('Timeline'); await wait(3000); console.log('     documents on the timeline now:', await p.evaluate(() => new Set([...document.querySelectorAll('a')].map(a => a.getAttribute('href')).filter(h => h?.startsWith('/documents/'))).size)); }
    if (!shown) console.log('     core logs:', coreLogs.length ? coreLogs : 'none', '| reading line still shown:', (await text()).includes('Reading the documents'));
    check(shown, 'the signer is filed among the doctors, read from the digital signature on the device');
    if (!own && shown) {
      // The chain leads to the named root: the document says the signature is verified.
      await (await p.evaluateHandle(() => [...document.querySelectorAll('a')].find(a => a.innerText.includes('Ana Exemplu') && a.getAttribute('href')?.startsWith('/doctors/')))).asElement().click();
      await wait(1500);
      await (await p.evaluateHandle(() => [...document.querySelectorAll('a')].find(a => a.getAttribute('href')?.startsWith('/documents/')))).asElement().click();
      check(await waitFor('Digital signature verified', 20000), 'its signer is shown as verified, because the file’s certificates chain to the named authority');
    }
    await wait(4000); // the save
  }

  // Opt-in: restore a Spine export through the upload page, on the device, with no model call. `SPINE_CHECK_RESTORE=/path/to/export.zip`.
  // Only counts are printed, never what the records say.
  if (process.env.SPINE_CHECK_RESTORE) {
    const zip = process.env.SPINE_CHECK_RESTORE;
    const manifest = JSON.parse(execFileSync('unzip', ['-p', zip, 'manifest.json'], { maxBuffer: 1 << 30 }).toString());
    const expected = manifest.files.reduce((n, f) => n + (f.documents ?? []).filter(d => shownInTimeline(f, d)).length, 0);
    const callsBefore = relay.calls.length;
    await click('Upload');
    await waitFor('Drag & drop');
    await (await p.$('input[type=file]')).uploadFile(zip);
    // Stay on the upload page until it settles: the line under the file name says what became of it.
    let status = '';
    for (let t = 0; t < 300000; t += 3000) {
      await wait(3000);
      status = (await text()).replace(/\s+/g, ' ').split('spine-archive')[1]?.slice(0, 160) ?? '';
      if (/restored|skipped|failed|could not|invalid|error|document/i.test(status)) break;
    }
    console.log(`     the upload says: ${status.replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')}`);
    await click('Timeline');
    let count = 0;
    for (let t = 0; t < 120000; t += 3000) {
      await wait(3000);
      count = await p.evaluate(() => new Set([...document.querySelectorAll('a')].map(a => a.getAttribute('href')).filter(h => h?.startsWith('/documents/'))).size);
      if (count >= expected) break;
    }
    // Saved, then read back from the vault after a reload: what a person would see tomorrow.
    await wait(8000);
    await p.goto(`http://localhost:${front}/`, { waitUntil: 'networkidle0' });
    await waitFor('Open your records');
    await type('input[type=password]', MASTER); await click('Open');
    await waitFor('Chest X-ray', 40000);
    for (let t = 0; t < 60000; t += 3000) {
      await wait(3000);
      count = await p.evaluate(() => new Set([...document.querySelectorAll('a')].map(a => a.getAttribute('href')).filter(h => h?.startsWith('/documents/'))).size);
      if (count >= expected) break;
    }
    // The samples written earlier are in the timeline too (5), so at least the export's own count must be there.
    check(count >= expected, `the export restores ${expected} document(s) on the device (the timeline shows ${count})`);
    const generated = relay.calls.slice(callsBefore).filter(c => c.task !== 'embed').length;
    check(generated === 0, `a restore calls no model to read or write (${generated}); the documents' summary cards are embedded afterwards`);
    await wait(4000); // the save
  }

  // Export, then import into another account: what one device takes out is what another puts back. The zip is the ground truth: its manifest
  // names every document and title, and the second account's timeline must show them all, after a reload and an unlock.
  {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-app-check-downloads-'));
    const cdp = await p.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await click('Upload');
    await waitFor('Export everything');
    await click('Export everything');
    await wait(1500);
    if (await p.$('[role=dialog] input[type=password]')) { await p.type('[role=dialog] input[type=password]', password); await p.keyboard.press('Enter'); }
    let zipPath = '';
    for (let t = 0; t < 60000 && !zipPath; t += 500) {
      await wait(500);
      const done = fs.readdirSync(downloads).filter(f => f.endsWith('.zip'));
      if (done.length) zipPath = path.join(downloads, done[0]);
    }
    check(!!zipPath, 'the device exports everything as a zip');
    if (zipPath) {
      const manifest = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'manifest.json'], { maxBuffer: 1 << 30 }).toString());
      const titles = manifest.files.flatMap(f => f.documents.filter(d => shownInTimeline(f, d)).map(d => d.title)).filter(Boolean);
      const everyDocument = manifest.files.reduce((n, f) => n + f.documents.length, 0);
      const count = manifest.files.reduce((n, f) => n + f.documents.filter(d => shownInTimeline(f, d)).length, 0);
      check(manifest.format === 'spine-export' && manifest.version === 3 && count > 0, `the export is a Spine export (version ${manifest.version}) of ${everyDocument} document(s), ${count} of them not set aside`);

      const second = execFileSync('node', ['dist/cli.js', 'create-user', 'second@example.com'], { cwd: path.join(root, 'server'), env, encoding: 'utf8' });
      const secondPassword = second.match(/password \(shown once\): (\S+)/)[1];
      const context2 = await browser.createBrowserContext();
      const q = await context2.newPage();
      const qErrors = [];
      q.on('pageerror', e => qErrors.push(e.message));
      q.on('console', m => { if (m.type() === 'error' || m.type() === 'debug') qErrors.push(m.text().slice(0, 200)); });
      const seen2 = () => q.evaluate(() => document.body.innerText);
      const waitFor2 = async (what, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if ((await seen2()).includes(what)) return true; await wait(250); } return false; };
      const click2 = async label => { const h = await q.evaluateHandle(l => [...document.querySelectorAll('button,a')].find(e => e.offsetParent && e.innerText.trim().toLowerCase().startsWith(l.toLowerCase())), label); await h.asElement().click(); };
      const type2 = async (sel, v) => { await q.waitForSelector(sel, { visible: true }); await q.type(sel, v); };
      const links2 = () => q.evaluate(() => [...new Set([...document.querySelectorAll('a')].filter(a => a.getAttribute('href')?.startsWith('/documents/')).map(a => a.getAttribute('href')))].length);
      const titlesShown = () => q.evaluate(() => document.body.innerText);
      await q.goto(`http://localhost:${front}/login`, { waitUntil: 'networkidle0' });
      await type2('input[type=email]', 'second@example.com'); await type2('input[type=password]', secondPassword); await click2('Sign in');
      await waitFor2('Before you start');
      for (const c of await q.$$('input[type=checkbox]')) await c.click();
      await click2('Agree and continue');
      await waitFor2('Protect your records');
      const pw2 = await q.$$('input[type=password]'); await pw2[0].type(MASTER); await pw2[1].type(MASTER); await click2('Continue');
      await waitFor2('recovery kit');
      await (await q.$('input[type=checkbox]')).click(); await click2('Continue');
      await waitFor2('Open your records');
      await type2('input[type=password]', MASTER); await click2('Open');
      check(await waitFor2('Explore with sample records'), 'a second, empty account is ready on another device');
      await click2('Upload');
      await waitFor2('Drag & drop');
      await (await q.$('input[type=file]')).uploadFile(zipPath);
      let said = '';
      for (let t = 0; t < 240000; t += 3000) {
        await wait(3000);
        said = (await seen2()).replace(/\s+/g, ' ').match(/is a Spine export: (\d+) restored, (\d+) already/)?.slice(1).map(Number) ?? '';
        if (said) break;
      }
      check(said && said[0] === everyDocument && said[1] === 0, `the import restores every document of the export (${said ? `${said[0]} restored, ${said[1]} already held` : 'no report'} of ${everyDocument})`);
      const filesIn = n => execFileSync('unzip', ['-Z1', n]).toString().split('\n').filter(Boolean).filter(f => f !== 'manifest.json').length;
      const exportAgain = async label => {
      const cdp2 = await browser.target().createCDPSession(); // downloads are set per browser context, from the browser itself
      const takeZip = async () => {
        await click2('Upload');
        await waitFor2('Export everything');
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-app-check-downloads-'));
        await cdp2.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: folder, browserContextId: context2.id });
        await click2('Export everything');
        await wait(1500);
        if (await q.$('[role=dialog] input[type=password]')) { await q.type('[role=dialog] input[type=password]', secondPassword); await q.keyboard.press('Enter'); }
        let got = '';
        for (let t = 0; t < 60000 && !got; t += 500) { await wait(500); const done = fs.readdirSync(folder).filter(f => f.endsWith('.zip')); if (done.length) got = path.join(folder, done[0]); }
        return got;
      };
      // The report of an import appears when the zip is accepted; a large file is still being restored after it. The export only holds
      // finished uploads, so it is taken again until it holds every file the first one did.
      let zip2 = await takeZip();
      for (let attempt = 0; attempt < 12 && zip2 && filesIn(zip2) < filesIn(zipPath); attempt++) { await wait(15000); zip2 = await takeZip(); }
      const downloads2 = zip2 ? path.dirname(zip2) : '';
      check(!!zip2, `the second account can export what it was given (${label})`);
      if (zip2) {
        const volatile = /(^id$|_id$|^exported_at$|_at$|^path$)/; // `path` is the entry's number in the zip, which follows the order of the files
        const plain = v => Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !volatile.test(k)).map(([k, x]) => [k, plain(x)])) : v;
        // Uploads are listed in the order they were made, which a restore does not keep; what each holds is what is compared.
        // A link or an episode names a document by the place of its file in the manifest, so it is written with the file's name to be comparable.
        const named = (m, end) => end && typeof end === 'object' && typeof end.file === 'number' ? { ...end, file: m.files[end.file]?.original_filename } : end;
        const ordered = m => ({
          ...m,
          files: [...m.files].sort((a, b) => String(a.original_filename).localeCompare(String(b.original_filename))),
          // An episode the app only proposed is worked out again from the documents after a restore, and with a stand-in that dates every document alike the grouping it proposes is arbitrary; the owner's decisions are what must survive.
          episodes: (m.episodes ?? []).filter(e => e.state !== 'proposed').map(e => ({ ...e, documents: (e.documents ?? []).map(d => named(m, d)) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          links: (m.links ?? []).map(l => ({ ...l, from: named(m, l.from), to: named(m, l.to) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        });
        const first = plain(ordered(manifest)), again = plain(ordered(JSON.parse(execFileSync('unzip', ['-p', zip2, 'manifest.json'], { maxBuffer: 1 << 30 }).toString())));
        const differ = (x, y, at = '') => {
          if (JSON.stringify(x) === JSON.stringify(y)) return null;
          if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y)) {
            for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = differ(x[k], y[k], `${at}/${k}`); if (d) return d; }
          }
          return `${at || '/'} (${typeof x}/${typeof y})`;
        };
        if (process.env.SPINE_CHECK_DEBUG) console.log(`     second export per file: ${JSON.stringify(again.files.map(f => [f.original_filename, f.documents.length, f.pages.filter(p => p.hidden).length, f.pages.length]))}\n     first export per file: ${JSON.stringify(first.files.map(f => [f.original_filename, f.documents.length, f.pages.filter(p => p.hidden).length, f.pages.length]))}`);
        const where = differ(first, again);
        check(where === null, `import then export gives the same manifest (${label})${where ? `: first difference at ${where}` : ' (apart from ids and times)'}`);
        check(filesIn(zipPath) === filesIn(zip2), `and the same number of files (${filesIn(zipPath)}, ${label})`);
      }
      if (downloads2) fs.rmSync(downloads2, { recursive: true, force: true });
      };
      await exportAgain('right after the import');
      await wait(8000); // the save
      await q.goto(`http://localhost:${front}/`, { waitUntil: 'networkidle0' });
      await waitFor2('Open your records');
      await type2('input[type=password]', MASTER); await click2('Open');
      let shown = 0;
      // The timeline draws its sections as they come into view, so it is scrolled to the end before it is counted.
      for (let t = 0; t < 60000; t += 3000) { await wait(3000); for (let i = 0; i < 6; i++) { await q.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await wait(400); } shown = await links2(); if (shown >= count) break; }
      check(shown >= count, `after a reload and an unlock the second account shows ${shown} of the ${count} document(s) that are not set aside`);
      const text2 = await titlesShown(); // after the scrolling above, so everything is drawn
      if (process.env.SPINE_CHECK_DEBUG) console.log(`     second timeline: ${text2.replace(/\s+/g, ' ').slice(0, 700)}\n     export titles: ${JSON.stringify(titles)}\n     file keys: ${JSON.stringify(Object.keys(manifest.files[0]))} ${JSON.stringify(manifest.files.map(f => [f.original_filename, f.sample]))}`);
      if (process.env.SPINE_CHECK_DEBUG) {
        const squash = x => x.replace(/\s+/g, ' ').trim();
        const flat = squash(text2);
        const rows = manifest.files.flatMap(f => f.documents.map(d => ({ file: f.original_filename, year: (d.doc_date ?? '').slice(0, 4), type: d.doc_type, reviewed: d.reviewed, pages: `${d.page_start}-${d.page_end}`, titled: !!d.title, shownRaw: d.title ? text2.includes(d.title) : null, shownSquashed: d.title ? flat.includes(squash(d.title)) : null })));
        console.log(`     not drawn: ${JSON.stringify(rows.filter(r => r.titled && !r.shownRaw))}`);
        console.log(`     all docs by year: ${JSON.stringify(rows.reduce((a, r) => ({ ...a, [r.year || 'none']: (a[r.year || 'none'] ?? 0) + 1 }), {}))}`);
      }
      const missing = titles.filter(t => !text2.includes(t));
      check(missing.length === 0, `every title in the export is on the second account's timeline${missing.length ? ` (missing ${missing.length} of ${titles.length})` : ` (${titles.length})`}`);
      await exportAgain('after a reload and an unlock');
      await context2.close();
    }
    fs.rmSync(downloads, { recursive: true, force: true });
  }

  // Two devices on one account: each removes a different tag at the same time, and each ends up with both removals. The first is told, without
  // a reload, that the other made changes.
  {
    const ctx = await browser.createBrowserContext();
    const d = await ctx.newPage();
    const dErrors = [];
    d.on('pageerror', e => dErrors.push(e.message));
    const dText = () => d.evaluate(() => document.body.innerText);
    const dWait = async (what, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if ((await dText()).includes(what)) return true; await wait(250); } return false; };
    const dClick = async label => { const h = await d.evaluateHandle(l => [...document.querySelectorAll('button,a')].find(e => e.offsetParent && e.innerText.trim().toLowerCase().startsWith(l.toLowerCase())), label); await h.asElement().click(); };
    await d.goto(`http://localhost:${front}/login`, { waitUntil: 'networkidle0' });
    await d.type('input[type=email]', 'check@example.com'); await d.type('input[type=password]', MASTER); await dClick('Sign in');
    check(await dWait('Chest X-ray', 60000), 'a second device signing in with the master password sees the records the first device saved');

    const removeTag = async (page, read, name) => {
      await page.evaluate(() => [...document.querySelectorAll('a')].find(a => a.getAttribute('href') === '/library')?.click()); // within the page: a reload would lock it

      for (let t = 0; t < 20000 && !(await read()).includes(name); t += 250) await wait(250);
      if (process.env.SPINE_CHECK_DEBUG) console.log('     library:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('li')].map(l => l.innerText.slice(0, 40)))));
      await page.evaluate(n => { const li = [...document.querySelectorAll('li')].find(l => l.innerText.split('\n')[0].trim() === n); [...li.querySelectorAll('button')].find(b => b.innerText.trim() === 'Remove tag').click(); }, name);
      await wait(400);
      await page.evaluate(() => [...document.querySelectorAll('[role=alertdialog] button')].find(b => b.innerText.trim() === 'Remove tag').click());
      for (let t = 0; t < 10000 && !(await read()).includes('Removed.'); t += 250) await wait(250);
    };
    // The page being left open on the first device is the one that is told; the tag is removed on it through the same screen.
    await removeTag(p, text, 'oncology');
    await removeTag(d, dText, 'vaccine');
    check((await text()).includes('Removed.') && (await dText()).includes('Removed.'), 'each device removes a tag of its own');

    // Within a few polls each has the other's removal.
    let both = false;
    for (let t = 0; t < 40000 && !both; t += 3000) {
      await wait(3000);
      const here = await text(); const there = await dText();
      both = here.includes('Another device made changes') && there.includes('Another device made changes');
    }
    check(both, 'each device is told, without a reload, that the other made changes');
    for (const [page, read, who] of [[p, text, 'first'], [d, dText, 'second']]) {
      await page.goto(`http://localhost:${front}/library`, { waitUntil: 'networkidle0' });
      if (await page.$('input[type=password]')) { await page.type('input[type=password]', MASTER); await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Open')?.click()); }
      for (let t = 0; t < 20000 && !(await read()).includes('allergy'); t += 250) await wait(250);
      const listed = await read();
      check(listed.includes('allergy') && !listed.includes('oncology') && !listed.includes('vaccine'), `the ${who} device has both removals and keeps the other tags`);
    }
    check(dErrors.length === 0, `no errors on the second device${dErrors.length ? `: ${dErrors[0]}` : ''}`);
    await ctx.close();
  }

  // A save that fails is shown, not hidden. The vault refuses writes, a change is made on this device, and the page says the latest changes are
  // not saved; signing out then asks first, and keeping the page open loses nothing; once the vault takes writes again the notice goes.
  {
    failVaultWrites = true;
    await click('Library');
    await waitFor('Remove tag', 15000);
    await click('Remove tag');
    await p.evaluate(() => [...document.querySelectorAll('[role=alertdialog] button')].find(b => b.innerText.trim().startsWith('Remove tag'))?.click());
    check(await waitFor('Your latest changes are not saved yet', 25000), 'a save that fails is shown on the page');
    await click('Sign out');
    check(await waitFor('If you sign out now, they will be lost', 8000), 'signing out over unsaved changes asks first');
    await click('Keep this page open');
    await wait(500);
    const afterKeeping = await text();
    check(!afterKeeping.includes('If you sign out now') && afterKeeping.includes('Sign out') && afterKeeping.includes('Library'), 'keeping the page open leaves the person signed in, with the records open');
    failVaultWrites = false;
    let gone = false;
    for (let t = 0; t < 30000 && !gone; t += 500) { gone = !(await text()).includes('Your latest changes are not saved yet'); if (!gone) await wait(500); }
    check(gone, 'the notice goes once the vault takes the save');
    await click('Timeline');
  }

  // A passkey that opens the vault (the WebAuthn PRF extension), with Chrome's virtual authenticator standing in for the person's device.
  {
    const cdp = await p.createCDPSession();
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
    const reauth = async () => { for (let t = 0; t < 4000; t += 250) { if (await p.$('[role=dialog] input[type=password]')) { await p.type('[role=dialog] input[type=password]', password); await p.keyboard.press('Enter'); return; } await wait(250); } };
    await click('check@example.com');
    check(await waitFor('Add a passkey on this device'), 'the account page offers passkeys');
    await click('Add a passkey on this device');
    await reauth();
    check(await waitFor('added 20', 15000), 'a passkey is added');
    await click('Open my records with it');
    await reauth();
    const opens = await waitFor('opens your records', 15000);
    if (!opens) console.log('     passkeys section:', (await text()).replace(/\s+/g, ' ').split('Passkeys')[1]?.slice(0, 500));
    check(opens, 'the passkey is set to open the records');

    // The server holds the sealed key and not the PRF output: a sign-in is verified without it.
    await click('Sign out');
    check(await waitFor('Sign in with a passkey'), 'signed out');
    await click('Sign in with a passkey');
    check(await waitFor('Chest X-ray', 30000), 'signing in with the passkey opens the records, with no master password typed');
    check(!(await text()).includes('Open your records'), 'and the master password is not asked for');

    // After a reload the key is gone again; the passkey opens it from the unlock screen.
    await p.goto(`http://localhost:${front}/`, { waitUntil: 'networkidle0' });
    check(await waitFor('Open with a passkey'), 'after a reload the unlock screen offers the passkey');
    await click('Open with a passkey');
    check(await waitFor('Chest X-ray', 30000), 'the passkey opens the records after a reload');
    await cdp.send('WebAuthn.disable');
  }

  // A share follows the records: when the owner removes the sample records, the link made earlier stops showing them, with no action on the link.
  {
    await p.evaluate(() => [...document.querySelectorAll('a')].find(a => a.getAttribute('href') === '/')?.click());
    check(await waitFor('Remove the sample records', 20000), 'the owner’s timeline still has the sample records');
    const before = puts.length;
    const removedAt = Date.now();
    await click('Remove the sample records');
    let removedHere = false;
    for (let t = 0; t < 30000 && !removedHere; t += 500) { await wait(500); const now = await text(); removedHere = !now.includes('Chest X-ray') && !now.includes('Remove the sample records'); }
    check(removedHere, 'and removes them');
    for (let t = 0; t < 120000 && puts.length === before; t += 1000) await wait(1000);
    console.log(`     the copy was sent again ${puts.length > before ? Math.round((puts[before] - removedAt) / 1000) + ' s' : 'never'} after the removal`);
    const ctx = await browser.createBrowserContext();
    const r = await ctx.newPage();
    let gone = false;
    for (let t = 0; t < 60000 && !gone; t += 6000) {
      await r.goto(full, { waitUntil: 'load' });
      // With nothing left to share the copy is not usable: the page says the link is unavailable, which is also the proof it was made again.
      const settled = () => r.evaluate(() => /Shared securely via Spine|Link unavailable/.test(document.body.innerText));
      for (let w = 0; w < 12000 && !(await settled()); w += 250) await wait(250);
      gone = (await settled()) && !(await r.evaluate(() => document.body.innerText)).includes('Chest X-ray');
      if (!gone) await wait(4000);
    }
    if (!gone) console.log('     recipient says:', (await r.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400));
    if (!gone) console.log('     shared requests after removal:', JSON.stringify(asked.filter(u => u.includes('/api/shared/')).slice(-12)), '| owner console:', errors.slice(-3));
    check(gone, 'the link made earlier no longer shows what the owner removed, without the owner touching the link');
    await ctx.close();
  }


  // What the server holds.
  const sealed = fs.readdirSync(path.join(data, 'vault'), { recursive: true }).length;
  // A PDF's header, not a bare '%PDF': four bytes turn up by chance in a few MB of ciphertext.
  const readable = ['Chest X-ray', 'Example Clinic', 'Ioan Specimen', 'Example Laboratory', '%PDF-1.', '%PDF-2.'].filter(w => {
    // grep exits 1 when it finds nothing, which is the answer wanted.
    return spawnSync('grep', ['-rlaF', w, data], { encoding: 'utf8' }).stdout.trim() !== '';
  });
  check(sealed > 0, `the server holds sealed objects (${sealed})`);
  if (readable.length) for (const w of readable) console.log(`     in: ${spawnSync('grep', ['-rlaF', w, data], { encoding: 'utf8' }).stdout.trim().split('\n').map(f => path.relative(data, f)).join(', ')}`);
  check(readable.length === 0, `no readable record text in the server's files${readable.length ? `: ${readable.join(', ')}` : ''}`);
} catch (err) {
  if (!failed) explain();
  console.log(`FAIL ${err.message}`);
  failed = true;
} finally {
  await browser.close();
  server.kill();
  proxy.close();
  relay.close();
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(sandbox, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
