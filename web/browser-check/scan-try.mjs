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
import { createRequire } from 'node:module';
const shots = process.env.SHOTS;
fs.mkdirSync(shots, { recursive: true });
const sharp = createRequire(path.join(root, 'server/package.json'))('sharp');
// A photographed page: a dark surface, paper with sensor noise, lines of "print". Noise is what makes a PNG of a photo huge.
async function photo(name, seed) {
  const W = 2400, H = 3200; const raw = Buffer.alloc(W * H * 3);
  let s = seed; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const x0 = W * 0.1, x1 = W * 0.9, y0 = H * 0.06, y1 = H * 0.94;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3; const onPaper = x > x0 && x < x1 && y > y0 && y < y1;
    const ink = onPaper && (Math.floor((y - y0) / 56) % 2 === 0) && ((y - y0) % 56) > 14 && ((y - y0) % 56) < 40 && x > x0 + 120 && x < x1 - 120 - ((y * 7) % 500);
    const base = !onPaper ? 55 : ink ? 30 : 232;
    const n = (rnd() - 0.5) * 46;
    raw[i] = Math.max(0, Math.min(255, base + n + 4)); raw[i + 1] = Math.max(0, Math.min(255, base + n)); raw[i + 2] = Math.max(0, Math.min(255, base + n - 6));
  }
  const file = path.join(sandbox, name);
  await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toFile(file);
  return file;
}
const photos = [await photo('photo-1.jpg', 11), await photo('photo-2.jpg', 22), await photo('photo-3.jpg', 33)];
console.log(`photos made: ${photos.map(f => `${path.basename(f)} ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`).join(', ')}`);

let failed = false;
const check = (ok, what, more = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${more ? ` (${more})` : ''}`); if (!ok) failed = true; };
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
try {
  const p = await browser.newPage();
  const diag = [];
  p.on('requestfailed', r => diag.push(`request failed: ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
  p.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) diag.push(`${r.status()} ${r.url().slice(0, 120)}`); });
  p.on('pageerror', e => diag.push(`page error: ${e.message}`));
  p.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/favicon|status of 404/.test(m.text())) diag.push(`console ${m.type()}: ${m.text().slice(0, 300)}`); });
  const text = () => p.evaluate(() => document.body.innerText);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (what, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if ((await text()).includes(what)) return true; await wait(250); } return false; };
  const waitUntil = async (fn, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if (await p.evaluate(fn)) return true; await wait(250); } return false; };
  const click = async label => { const h = await p.evaluateHandle(l => [...document.querySelectorAll('button,a,label')].find(e => e.offsetParent && e.innerText.trim().toLowerCase().startsWith(l.toLowerCase())), label); await h.asElement().click(); };
  const go = route => p.evaluate(r => { history.pushState(null, '', r); dispatchEvent(new PopStateEvent('popstate')); }, route);
  const shot = name => p.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });

  await p.goto(`http://localhost:${front}/login`, { waitUntil: 'networkidle0' });
  await p.type('input[type=email]', 'check@example.com'); await p.type('input[type=password]', password); await click('Sign in');
  await waitFor('Before you start');
  for (const c of await p.$$('input[type=checkbox]')) await c.click();
  await click('Agree and continue'); await waitFor('Protect your records');
  const pw = await p.$$('input[type=password]'); await pw[0].type(MASTER); await pw[1].type(MASTER); await click('Continue');
  await waitFor('recovery kit'); await (await p.$('input[type=checkbox]')).click(); await click('Continue');
  await waitFor('Open your records'); await p.type('input[type=password]', MASTER); await click('Open');
  check(await waitFor('Explore with sample records', 40000), 'the vault opens and the empty timeline shows');

  // The first time, the chat opens on its welcome; put it away to get at the page.
  if (await waitUntil(() => /Welcome to Spine/.test(document.body.innerText), 15000)) { await (await p.$('button[aria-label="Close"]')).click(); await wait(500); }
  // The chat button: it was never shown for a real account, because chat was asked about before the vault was open.
  const ask = await waitUntil(() => !!document.querySelector('button[aria-label^="Ask your records"]'), 15000);
  check(ask, 'the Ask button is there once the vault is open');
  await shot('1-timeline-with-ask');

  await go('/upload'); await waitFor('Upload');
  await wait(800);
  const upText = await text();
  check(!upText.includes('Export everything'), 'the Upload page has no Export button');
  check(upText.includes('Tap to choose PDFs or photos'), 'it says "Tap to choose PDFs or photos"', upText.split('\n').filter(Boolean).slice(0, 8).join(' | '));
  check(!upText.includes('up to 200 MB') || await p.evaluate(() => { const el = [...document.querySelectorAll('p')].find(e => e.innerText.includes('up to 200 MB')); return !el || el.offsetParent === null; }), 'the size line is hidden on a phone');
  await shot('2-upload');

  // Photos chosen on Upload go to Scan: several at once, each added with the page found in it.
  const input = await p.$('input[type=file]');
  await input.uploadFile(photos[0], photos[1]);
  check(await waitUntil(() => location.pathname === '/scan', 15000), 'choosing photos on Upload opens Scan');
  check(await waitUntil(() => document.querySelectorAll('ol li img').length === 2, 120000), 'both photos arrive as pages in one grid');
  await shot('3-scan-two-pages');
  const tiles = await p.evaluate(() => ({ add: !![...document.querySelectorAll('ol li')].find(li => li.innerText.includes('Add a page')), save: [...document.querySelectorAll('button')].map(b => b.innerText).find(t => t.startsWith('Save')) }));
  check(tiles.add && /Save 2 pages/.test(tiles.save ?? ''), 'with "Add a page" in the grid and Save 2 pages in the header', JSON.stringify(tiles));

  // Corners, as a sheet over the same screen.
  await click('Corners');
  check(await waitUntil(() => !!document.querySelector('[role=dialog] button[aria-label^="Corner"]'), 10000), 'Corners opens a sheet with four handles');
  await shot('4-corners-sheet');
  await click('Use this page');
  check(await waitUntil(() => !document.querySelector('[role=dialog]') && document.querySelectorAll('ol li img').length === 2, 30000), 'Use this page returns to the same screen with the pages still there');

  const brokenAfterRedo = await p.evaluate(() => [...document.querySelectorAll('ol li img')].filter(i => !i.complete || i.naturalWidth === 0).length);
  check(brokenAfterRedo === 0, 'and the page whose corners were redone still shows its picture', `${brokenAfterRedo} broken`);
  // A filter, and one more page from the camera input: one picture opens its corners first.
  await p.select('ol li:nth-child(2) select', 'bw');
  const camera = await p.$('ol li:last-child input[capture]');
  await camera.uploadFile(photos[2]);
  check(await waitUntil(() => !!document.querySelector('[role=dialog]'), 60000), 'a picture taken from the grid opens its corners');
  await click('Use this page');
  check(await waitUntil(() => document.querySelectorAll('ol li img').length === 3, 60000), 'and becomes the third page');
  await wait(500);
  const broken = await p.evaluate(() => [...document.querySelectorAll('ol li img')].filter(i => !i.complete || i.naturalWidth === 0).length);
  check(broken === 0, 'every page in the grid shows its picture', `${broken} broken`);
  await shot('5-scan-three-pages');

  // Save: one document, read through the relay with the page shrunk.
  const before = relay.calls.length;
  await click('Save 3 pages');
  check(await waitUntil(() => location.pathname === '/upload', 120000), 'Save returns to Upload');
  let pageCalls = [];
  for (let t = 0; t < 120000; t += 1000) { pageCalls = relay.calls.slice(before).filter(c => c.task === 'page'); if (pageCalls.length >= 3) break; await wait(1000); }
  check(pageCalls.length >= 3, 'the three pages are read by the model', `${pageCalls.length} page calls`);
  const biggest = Math.max(0, ...pageCalls.map(c => c.bytes_in ?? 0));
  console.log(`     page request sizes: ${pageCalls.map(c => `${(c.bytes_in / 1048576).toFixed(2)} MB`).join(', ')}`);
  check(pageCalls.length > 0 && biggest < 2 * 1048576, 'each page request is under 2 MB', `largest ${(biggest / 1048576).toFixed(2)} MB`);
  check(await waitFor('Check how the pages were grouped', 120000) || await waitFor('Check the grouping', 5000), 'the upload finishes and asks for the grouping');
  await shot('6-upload-done');

  // A photo attached in the chat goes to Scan first, and after Save the chat opens again on the same conversation with the attachment.
  await go('/'); await wait(1500);
  await p.click('button[aria-label^="Ask your records"]');
  check(await waitUntil(() => !!document.querySelector('[role=complementary]'), 10000), 'the chat opens');
  const chatInput = await p.$('[role=complementary] input[type=file]');
  await chatInput.uploadFile(photos[0]);
  check(await waitUntil(() => location.pathname === '/scan', 15000), 'a photo attached in the chat opens Scan, not the upload');
  check(await waitUntil(() => !!document.querySelector('[role=dialog]'), 60000), 'its corners are shown');
  await click('Use this page');
  check(await waitUntil(() => document.querySelectorAll('ol li img').length === 1, 60000), 'it is the one page');
  await click('Save 1 page');
  check(await waitUntil(() => location.pathname === '/upload', 120000), 'Save goes on to Upload');
  check(await waitUntil(() => !!document.querySelector('[role=complementary]'), 15000), 'the chat is open again');
  await wait(1500);
  const chatText = await p.evaluate(() => document.querySelector('[role=complementary]')?.innerText ?? '');
  check(/scan|image|Being read|attached/i.test(chatText) && !/Ask about your records, or paste/.test(chatText.split('\n')[0] ?? ''), 'in the conversation the photo was attached in', chatText.split('\n').filter(Boolean).slice(0, 8).join(' | '));
  // The report of reading it comes to the open conversation by itself: no closing and opening the chat again.
  check(await waitUntil(() => /has been read/.test(document.querySelector('[role=complementary]')?.innerText ?? ''), 90000), 'the report of the photo read appears in the open chat by itself');
  await shot('7a-chat-report');
  // One page has no grouping to check: it is read at once, so nothing asks for it.
  // The three-page upload before it rightly still asks for its grouping, so that is the only card that does, and the new page's document is listed beside its three.
  await waitUntil(() => !/Reading document|processing/.test(document.body.innerText), 90000);
  const after = await p.evaluate(() => document.body.innerText);
  const asks = (after.match(/Check the grouping/g) ?? []).length;
  const shown = (after.match(/View document/g) ?? []).length;
  check(asks === 1 && shown === 4, 'a one-page upload is read at once and does not ask for the grouping to be checked', `${asks} asks, ${shown} documents shown`);
  await shot('7-chat-after-scan');

  // A refresh: the sign-in stays; only the records' password is asked (the key is never kept), and the upload is not left asking.
  await p.reload({ waitUntil: 'domcontentloaded' });
  check(await waitFor('Open your records', 30000), 'a refresh asks only for the records password, not to sign in', (await text()).split('\n').filter(Boolean).slice(0, 6).join(' | '));
  await p.type('input[type=password]', MASTER); await click('Open');
  await waitUntil(() => location.pathname === '/upload' && /View document/.test(document.body.innerText), 40000);
  await wait(2500);
  const afterReload = await p.evaluate(() => document.body.innerText);
  check((afterReload.match(/Check the grouping/g) ?? []).length === 1, 'after the refresh the one-page upload still does not ask for its grouping', `${(afterReload.match(/Check the grouping/g) ?? []).length} asks`);
  await shot('8-after-refresh');

  // The server restarts (a deploy): a refresh still does not ask to sign in (S-16).
  server.kill(); await new Promise(r => server.once('exit', r));
  server = spawn('node', ['dist/index.js'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', serverLog, serverLog] });
  await wait(3500);
  await p.reload({ waitUntil: 'domcontentloaded' });
  check(await waitFor('Open your records', 30000), 'after a server restart a refresh still does not ask to sign in', (await text()).split('\n').filter(Boolean).slice(0, 6).join(' | '));
  console.log(diag.length ? `browser messages:\n${diag.slice(0, 10).map(d => `     ${d}`).join('\n')}` : 'browser: no errors or warnings');
} catch (err) {
  failed = true; console.log(`FAIL script error: ${err.stack?.split('\n').slice(0, 4).join(' | ')}`);
} finally {
  await browser.close(); relay.close(); server.kill(); proxy.close();
  console.log(failed ? 'FAILED' : 'PASSED');
  process.exit(failed ? 1 : 0);
}
