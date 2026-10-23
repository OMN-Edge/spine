// Runs the real app, end to end, in real Chrome: a server on a temporary data directory, an account, sign-in, the vault set up, the sample
// records written on the device, a reload, and the unlock that brings them back. Then it looks in the server's files for anything readable.
// `npm run check:app` (needs `npm run build` in web/ and server/, and Google Chrome; set CHROME elsewhere than macOS). Exits 1 on a failure.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '../..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-app-check-'));
const port = 3000 + Math.floor(Math.random() * 1000);
const env = { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: data, SESSION_SECRET: 'app-check-secret-app-check-secret-1234', ANTHROPIC_API_KEY: 'sk-ant-unused', PORT: String(port), SPINE_PARSER: 'text', SPINE_EMBEDDINGS: 'none' };
const MASTER = 'violet-tractor-9Qx-pelican-ledger-42';

const made = execFileSync('node', ['dist/cli.js', 'create-user', 'check@example.com'], { cwd: path.join(root, 'server'), env, encoding: 'utf8' });
const password = made.match(/password \(shown once\): (\S+)/)[1];
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
  let last = '';
  const text = async () => (last = await p.evaluate(() => document.body.innerText));
  seen = () => last;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (what, ms = 20000) => { for (let t = 0; t < ms; t += 250) { if ((await text()).includes(what)) return true; await wait(250); } return false; };
  const click = async label => { const h = await p.evaluateHandle(l => [...document.querySelectorAll('button,a')].find(e => e.offsetParent && e.innerText.trim().toLowerCase().startsWith(l.toLowerCase())), label); await h.asElement().click(); };
  const type = async (sel, v) => { await p.waitForSelector(sel, { visible: true }); await p.type(sel, v); };

  await p.goto(`http://localhost:${port}/login`, { waitUntil: 'networkidle0' });
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
  await (await p.evaluateHandle(() => [...document.querySelectorAll('a')].find(a => a.getAttribute('href')?.startsWith('/documents/')))).asElement().click();
  check(await waitFor('Extracted fields'), 'a document opens');
  await wait(2500);
  const sizes = await p.evaluate(() => [...document.querySelectorAll('img')].map(i => i.naturalWidth));
  check(sizes.some(w => w > 1000), 'its page image comes from the device');
  await wait(3000); // the save
  await p.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
  check(await waitFor('Open your records'), 'after a reload the key is gone and is asked for again');
  await type('input[type=password]', MASTER); await click('Open');
  check(await waitFor('Chest X-ray'), 'unlocking brings the records back from the vault');
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);

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
  fs.rmSync(data, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
