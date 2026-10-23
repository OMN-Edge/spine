// Runs the real app, end to end, in real Chrome: a server on a temporary data directory, an account, sign-in, the vault set up, the sample
// records written on the device, a reload, and the unlock that brings them back. Then it looks in the server's files for anything readable.
// `npm run check:app` (needs `npm run build` in web/ and server/, and Google Chrome; set CHROME elsewhere than macOS). Exits 1 on a failure.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { startRelayWithStandIn } from './model-stand-in.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-app-check-'));
const port = 3000 + Math.floor(Math.random() * 1000);
const front = port + 1000; // what the browser talks to: a proxy that adds the production content security policy, as Caddy or nginx do
const RELAY_SECRET = 'app-check-relay-secret-app-check-relay';
// A relay (the real code) with a stand-in for the model behind it; the server tells the page where it is.
const relay = await startRelayWithStandIn({ secret: RELAY_SECRET, origin: `http://localhost:${front}`, models: [{ model: 'gemini-test', endpoint: 'aiplatform.eu.example', project: 'proj-1', region: 'eu' }, { model: 'gemini-embedding-2', endpoint: 'aiplatform.eu.example', project: 'proj-1', region: 'eu' }] });
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: data, SESSION_SECRET: 'app-check-secret-app-check-secret-1234', PORT: String(port), SPINE_PARSER: 'text', SPINE_EMBEDDINGS: 'vertex', SPINE_EMBEDDING_ENDPOINT: 'aiplatform.eu.example', SPINE_EMBEDDING_REGION: 'eu', SPINE_EMBEDDING_PROJECT: 'proj-1',
  SPINE_LLM_PROVIDER: 'vertex', SPINE_LLM_ENDPOINT: 'aiplatform.eu.example', SPINE_LLM_REGION: 'eu', SPINE_LLM_PROJECT: 'proj-1', SPINE_LLM_MODEL: 'gemini-test',
  SPINE_RELAY_URL: relay.url, SPINE_RELAY_SECRET: RELAY_SECRET,
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
const MASTER = 'violet-tractor-9Qx-pelican-ledger-42';

const made = execFileSync('node', ['dist/cli.js', 'create-user', 'check@example.com'], { cwd: path.join(root, 'server'), env, encoding: 'utf8' });
const password = made.match(/password \(shown once\): (\S+)/)[1];
const CSP = fs.readFileSync(path.join(root, 'Caddyfile'), 'utf8').match(/Content-Security-Policy "([^"]+)"/)[1].replace('{$SPINE_RELAY_URL:}', relay.url);
const asked = []; // every address the browsers asked the server for: a key in the part after the # would never be among them
const proxy = http.createServer((req, res) => {
  asked.push(req.url);
  const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, r => {
    res.writeHead(r.statusCode, { ...r.headers, 'content-security-policy': CSP });
    r.pipe(res);
  });
  req.pipe(up);
}).listen(front);
const server = spawn('node', ['dist/index.js'], { cwd: path.join(root, 'server'), env, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 3000));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, defaultViewport: { width: 1100, height: 900 } });
let failed = false;
let seen = () => '';
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { failed = true; console.log(`     page says: ${seen().replace(/\s+/g, ' ').slice(0, 300)}`); } };
try {
  const p = await browser.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (/Content Security Policy|violat/i.test(m.text())) errors.push(m.text()); });
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
  await wait(4000);
  check(relay.calls.some(c => c.method === 'embedContent'), 'each document is embedded through the relay, for search by meaning');
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
  check(await waitFor('Check the grouping', 40000), 'an uploaded PDF is read on the device (text, pages, grouping)');
  const sent = relay.calls.length;
  check(sent > 0, `the model was reached through the relay (${sent} calls)`);
  check(relay.calls.every(c => Object.keys(c).sort().join() === 'bytes_in,method,model,ms,status' && c.status === 200), 'the relay noted only the model, the status and the sizes');
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

  // What the server holds.
  const sealed = fs.readdirSync(path.join(data, 'vault'), { recursive: true }).length;
  const readable = ['Chest X-ray', 'Example Clinic', 'Ioan Specimen', 'Example Laboratory', '%PDF'].filter(w => {
    // grep exits 1 when it finds nothing, which is the answer wanted.
    return spawnSync('grep', ['-rlaF', w, data], { encoding: 'utf8' }).stdout.trim() !== '';
  });
  check(sealed > 0, `the server holds sealed objects (${sealed})`);
  check(readable.length === 0, `no readable record text in the server's files${readable.length ? `: ${readable.join(', ')}` : ''}`);
} catch (err) {
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
