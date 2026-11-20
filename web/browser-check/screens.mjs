// Screenshots of every screen, for a product or UX review: starts the built server and the stand-in relay on a temporary data directory, makes the
// accounts a review needs (an administrator with a granted Family plan and the sample records, a new account on the trial, one waiting for approval),
// and captures the public pages, the demo, the first sign-in, the signed-in screens, a share link opened as its recipient and /admin, at desktop
// (1440) and phone (390@2x) widths, in English and Romanian (the share link in German too).
// `npm run screens -- <outdir>` in web/ (needs `npm run build`, Google Chrome, and a Stripe test key in .env: billing runs as the branch does,
// Stripe in test mode with Spine's own e-Factura invoicing on ANAF's test platform; the key is refused unless it is a test one). The default
// <outdir> is .workspace/ux/<today>/shots, which git does not track. SECTIONS=pub,demo,onb,acc runs only some; INVOICING=billyou runs the operator's pages in Billyou mode; CHROME and CHROME_FLAGS as for check:app.
// The Stripe prices are the sandbox's own; SPINE_STRIPE_PRICE_* in .env or the environment replace them. No record here is a real person's.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(process.argv[2] ?? path.join(root, '.workspace', 'ux', new Date().toISOString().slice(0, 10), 'shots'));
fs.mkdirSync(out, { recursive: true });
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-ux-'));
// Chrome refuses some ports outright (ERR_UNSAFE_PORT); these are among them, and the run must not draw one.
const UNSAFE = new Set([3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
let port;
do { port = 3300 + Math.floor(Math.random() * 500); } while ([port, port + 1000].some(n => UNSAFE.has(n)));
const front = port + 1000;
const relayPort = 4600 + Math.floor(Math.random() * 300);
const RELAY_SECRET = 'ux-review-relay-secret-ux-review-relay-xx';
const MASTER = 'copper-lantern-7Xk-orchard-violet-19';
const log = (...a) => console.log(...a);

const relayProcess = spawn(path.join(root, 'node_modules/.bin/tsx'), ['src/testing/stand-in-relay.ts'], { cwd: path.join(root, 'server'), env: { PATH: process.env.PATH, HOME: process.env.HOME, SPINE_LLM_PROVIDER: 'stand-in', SPINE_LLM_MODEL: 'gemini-test', SPINE_EMBEDDINGS: 'stand-in', SPINE_RELAY_SECRET: RELAY_SECRET, SPINE_RELAY_ORIGIN: `http://localhost:${front}`, SPINE_DB_PATH: ':memory:', PORT: String(relayPort) }, stdio: ['ignore', 'ignore', 'inherit'] });
const relayUrl = `http://127.0.0.1:${relayPort}`;
for (let w = 0; ; w += 250) { if (w > 30000) throw new Error('relay did not start'); try { await fetch(relayUrl + '/healthz'); break; } catch { await new Promise(r => setTimeout(r, 250)); } }

const anchors = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-ux-anchors-'));
fs.copyFileSync(path.join(root, 'core/src/__tests__/fixtures/chain-root.der'), path.join(anchors, 'root.der'));
const env = {
  SPINE_TRUST_ANCHORS_DIR: anchors, PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: data, SESSION_SECRET: 'ux-review-secret-ux-review-secret-1234', PORT: String(port), SPINE_PARSER: 'hybrid', SPINE_MULTIMODAL_ENABLED: 'true', SPINE_OCR: 'off',
  SPINE_EMBEDDINGS: 'vertex', SPINE_EMBEDDING_ENDPOINT: 'aiplatform.eu.example', SPINE_EMBEDDING_REGION: 'eu', SPINE_EMBEDDING_PROJECT: 'proj-1', SPINE_LLM_PROVIDER: 'vertex', SPINE_LLM_ENDPOINT: 'aiplatform.eu.example', SPINE_LLM_REGION: 'eu', SPINE_LLM_PROJECT: 'proj-1', SPINE_LLM_MODEL: 'gemini-test',
  SPINE_RELAY_URL: relayUrl, SPINE_RELAY_SECRET: RELAY_SECRET, SPINE_DOMAIN: `localhost:${front}`, SPINE_DEMO_UPLOADS: 'on',
  // Billing as the branch runs it: Stripe (test mode, the sandbox's prices) through spine-billing, invoices by Spine's own e-Factura module on ANAF's test platform.
  // The ANAF application is invented (the seller is saved by seed-lists.mjs); nothing is signed in to ANAF and nothing is bought.
  SPINE_BILLING: 'on', SPINE_BILLING_PROVIDER: 'stripe', STRIPE_WEBHOOK_SECRET: ['whsec', 'ux', 'review'].join('_'),
  SPINE_STRIPE_PRICE_YEAR: 'price_1Uc8gEFMVsdHvrD5AjN1GbjV', SPINE_STRIPE_PRICE_MONTH: 'price_1Uc8gFFMVsdHvrD5bIDdTjJi', SPINE_STRIPE_PRICE_FOUNDING: 'price_1Uc8gGFMVsdHvrD5qBOUHZtJ',
  SPINE_STRIPE_PRICE_ESSENTIAL_YEAR: 'price_1Uc8gHFMVsdHvrD5nw1UUExc', SPINE_STRIPE_PRICE_ESSENTIAL_MONTH: 'price_1Uc8gIFMVsdHvrD517DjA5lm',
  SPINE_STRIPE_PRICE_FAMILY_YEAR: 'price_1Uc8gIFMVsdHvrD5zfMT5vZm', SPINE_STRIPE_PRICE_FAMILY_MONTH: 'price_1Uc8gJFMVsdHvrD5mS4mJLkV', SPINE_STRIPE_PRICE_TOPUP_PAGES: 'price_1Uc8gNFMVsdHvrD5aCq547Tq',
  SPINE_INVOICING_PROVIDER: 'efactura', SPINE_EFACTURA_MODE: 'test', ANAF_CLIENT_ID: 'ux-review-client', ANAF_CLIENT_SECRET: ['ux', 'review', 'anaf'].join('-'),
  SPINE_EFACTURA_REDIRECT_URI: 'https://spine.example/api/admin/efactura/callback', SPINE_EFACTURA_KEY: Buffer.alloc(32, 7).toString('base64'), SPINE_EFACTURA_SERIES: 'TST',
  SPINE_OPERATOR_CONTACT: 'contact@example.com',
  SPINE_REGISTRATION: 'approval', SPINE_ADMIN_EMAILS: 'owner@example.com',
};
{
  const dotenv = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n').map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].replace(/^"(.*)"$/, '$1')]));
  // The Stripe sandbox key only (rk_test_/sk_test_): never a live one.
  if (/^(rk|sk)_test_/.test(dotenv.STRIPE_SECRET_KEY ?? '')) env.STRIPE_SECRET_KEY = dotenv.STRIPE_SECRET_KEY; else throw new Error('no Stripe test key in .env');
  for (const [k, v] of Object.entries({ ...dotenv, ...process.env })) if (k.startsWith('SPINE_STRIPE_PRICE_') && v) env[k] = v;
}
// INVOICING=billyou shows the operator's pages with a service issuing the invoices instead of Spine's own e-Factura link. Nothing calls the service (the pages only list what was made), so the key and the series are invented.
if (process.env.INVOICING === 'billyou') {
  for (const k of ['SPINE_EFACTURA_MODE', 'ANAF_CLIENT_ID', 'ANAF_CLIENT_SECRET', 'SPINE_EFACTURA_REDIRECT_URI', 'SPINE_EFACTURA_KEY', 'SPINE_EFACTURA_SERIES']) delete env[k];
  Object.assign(env, { SPINE_INVOICING_PROVIDER: 'billyou', BILLYOU_API_KEY: ['bk', 'ux', 'review'].join('_'), BILLYOU_SERIES_ID: '1', SPINE_INVOICING_EFACTURA: 'on', SPINE_INVOICING_MAIL: 'off' });
}
const cli = (...args) => execFileSync('node', ['dist/cli.js', ...args], { cwd: path.join(root, 'server'), env, encoding: 'utf8' });
const password = cli('create-user', 'owner@example.com').match(/password \(shown once\): (\S+)/)[1];
try { cli('grant-plan', 'owner@example.com', '--plan=family', '--days=30'); } catch (e) { log('grant-plan failed', e.message); }
// Sixty invoices and sixty subscriptions, so the paged lists (25 to a page) show their pager.
execFileSync('node', ['browser-check/seed-lists.mjs', 'owner@example.com'], { cwd: path.join(root, 'web'), env, encoding: 'utf8' });
const fresh = cli('create-user', 'fresh@example.com').match(/password \(shown once\): (\S+)/)[1];

const CSP = fs.readFileSync(path.join(root, 'Caddyfile'), 'utf8').match(/Content-Security-Policy "([^"]+)"/)[1].replace('{$SPINE_RELAY_URL:}', relayUrl);
http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, { ...r.headers, 'content-security-policy': CSP }); r.pipe(res); });
  req.pipe(up);
}).listen(front);
const server = spawn('node', ['dist/index.js'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', fs.openSync(path.join(out, 'server.log'), 'w'), fs.openSync(path.join(out, 'server.log'), 'a')] });
await new Promise(r => setTimeout(r, 3000));
const base = `http://localhost:${front}`;

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: (process.env.CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean), defaultViewport: null });
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const index = [];
const errors = [];
const wait = ms => new Promise(r => setTimeout(r, ms));

function helpers(p) {
  const text = () => p.evaluate(() => document.body.innerText);
  const waitFor = async (what, ms = 20000) => { for (let t = 0; t < ms; t += 250) { if ((await text()).includes(what)) return true; await wait(250); } log(`  (did not see "${what}")`); return false; };
  const press = label => p.evaluate(l => { const e = [...document.querySelectorAll('button,a')].find(e => e.offsetParent && e.innerText.trim().toLowerCase().startsWith(l.toLowerCase())); e?.click(); return !!e; }, label);
  const go = async route => { await p.evaluate(r => { history.pushState(null, '', r); dispatchEvent(new PopStateEvent('popstate')); }, route); await wait(1500); };
  const shot = async (name, note = '', full = true) => {
    if (only && !only.has(name.split('-')[0])) return;
    await wait(700);
    const file = `${name}.png`;
    try { await p.screenshot({ path: path.join(out, file), fullPage: full, captureBeyondViewport: true }); } catch (e) { log('shot failed', name, e.message); return; }
    const url = await p.evaluate(() => location.pathname + location.search);
    index.push({ file, url, note });
    log('shot', file, url);
  };
  return { text, waitFor, press, go, shot };
}
async function newPage(ctx, vp, lang = 'en') {
  const p = await ctx.newPage();
  await p.setViewport(vp);
  p.on('pageerror', e => errors.push(`${p.url()} pageerror: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(`${p.url()} console: ${m.text().slice(0, 200)}`); });
  p.on('dialog', d => void d.accept());
  await p.evaluateOnNewDocument(l => { try { localStorage.setItem('spine.lang', l); } catch {} }, lang);
  return p;
}

const PUBLIC = ['/', '/pricing', '/how-it-works', '/protection', '/families', '/for-doctors', '/encryption', '/security-checks', '/trust', '/privacy', '/terms', '/purpose', '/login', '/register', '/forgot'];
try {
  const SECTIONS = new Set((process.env.SECTIONS ?? 'pub,demo,onb,acc').split(','));
  // 1. Public pages
  if (SECTIONS.has('pub')) for (const [tag, vp, lang] of [['d', DESKTOP, 'en'], ['m', PHONE, 'en'], ['ro', DESKTOP, 'ro']]) {
    const ctx = await browser.createBrowserContext();
    const p = await newPage(ctx, vp, lang);
    const h = helpers(p);
    for (const route of (tag === 'ro' ? ['/', '/pricing', '/login', '/register'] : PUBLIC)) {
      await p.goto(base + route, { waitUntil: 'networkidle0' });
      await wait(800);
      await h.shot(`pub-${tag}-${route === '/' ? 'landing' : route.slice(1)}`);
    }
    if (tag === 'm') { // the phone menu on the landing page
      await p.goto(base + '/', { waitUntil: 'networkidle0' });
      await p.evaluate(() => document.querySelector('button[aria-label="Open menu"]')?.click()); await wait(500); await h.shot('pub-m-landing-menu', '', false);
    }
    await ctx.close();
  }

  // 2. The demo
  if (SECTIONS.has('demo')) for (const [tag, vp] of [['d', DESKTOP], ['m', PHONE]]) {
    const ctx = await browser.createBrowserContext();
    const p = await newPage(ctx, vp);
    const h = helpers(p);
    await p.goto(base + '/', { waitUntil: 'networkidle0' });
    await h.press('Try the demo');
    await h.waitFor('Radiografie', 120000);
    await wait(2500);
    await h.shot(`demo-${tag}-timeline`, '', false);
    await h.shot(`demo-${tag}-timeline-full`);
    if (tag === 'm') { await p.evaluate(() => document.querySelector('button[aria-label="Open menu"]')?.click()); await wait(500); await h.shot('demo-m-navmenu', '', false); await p.evaluate(() => document.querySelector('button[aria-label="Close menu"]')?.click()); }
    await p.evaluate(() => [...document.querySelectorAll('a')].find(a => a.getAttribute('href')?.startsWith('/documents/') && /X-ray|Radiografie/.test(a.innerText))?.click());
    await wait(3500);
    await h.shot(`demo-${tag}-document`);
    for (const r of ['/review', '/episodes', '/trends', '/doctors', '/library', '/search', '/upload']) { await h.go(r); await wait(1500); await h.shot(`demo-${tag}-${r.slice(1)}`); }
    await h.go('/doctors'); await p.evaluate(() => [...document.querySelectorAll('a')].find(a => a.getAttribute('href')?.startsWith('/doctors/'))?.click()); await wait(2000); await h.shot(`demo-${tag}-doctor`);
    await h.go('/search'); await p.type('input', 'tiroid'); await p.keyboard.press('Enter'); await wait(3000); await h.shot(`demo-${tag}-search-results`);
    await h.go('/'); await wait(1000);
    // the chat
    const chat = await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? '').startsWith('Ask your records')); b?.click(); return b?.outerHTML.slice(0, 120); });
    // The sample archive has no chat (asking needs a model, which a sample cannot bring): no button, and no shot of one.
    log('chat button', chat ?? 'none: the demo has no chat'); if (chat) { await wait(1500); await h.shot(`demo-${tag}-chat`, '', false); }
    await ctx.close();
  }

  // 3. A fresh account: consent, master password, recovery kit, empty timeline
  if (SECTIONS.has('onb')) {
    const ctx = await browser.createBrowserContext();
    const p = await newPage(ctx, DESKTOP);
    const h = helpers(p);
    await p.goto(base + '/login', { waitUntil: 'networkidle0' });
    await p.type('input[type=email]', 'fresh@example.com'); await p.type('input[type=password]', fresh); await h.press('Sign in');
    await h.waitFor('Before you start'); await h.shot('onb-d-consent');
    for (const c of await p.$$('input[type=checkbox]')) await c.click();
    await h.press('Agree and continue');
    await h.waitFor('Protect your records'); await h.shot('onb-d-master');
    const pw = await p.$$('input[type=password]'); await pw[0].type(MASTER); await pw[1].type(MASTER); await h.shot('onb-d-master-filled');
    await h.press('Continue');
    await h.waitFor('recovery kit'); await h.shot('onb-d-kit');
    await (await p.$('input[type=checkbox]')).click(); await h.press('Continue');
    await h.waitFor('Timeline', 30000); await wait(3000); await h.shot('onb-d-empty');
    await h.go('/account'); await wait(2500); await h.shot('onb-d-account-free');
    await h.go('/pricing'); await wait(1500); await h.shot('onb-d-pricing-signedin');
    await ctx.close();
  }

  // 4. The owner (family plan, administrator) with the sample archive
  // someone waiting for approval, for the administrator's list
  try { const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: 'waiting@example.com', password: 'violet-harbour-93-quill-ember-x', consent_health_data: true, accept_terms: true }) }); log('register waiting', r.status, (await r.text()).slice(0, 200)); } catch (e) { log('register failed', e.message); }
  const actx = SECTIONS.has('acc') ? await browser.createBrowserContext() : null;
  const p = actx ? await newPage(actx, DESKTOP, 'en') : null;
  const h = p ? helpers(p) : null;
  if (SECTIONS.has('acc')) for (const [tag, vp, lang] of [['d', DESKTOP, 'en'], ['m', PHONE, 'en'], ['ro', DESKTOP, 'ro']]) {
    if (tag === 'd') {
      await p.goto(base + '/login', { waitUntil: 'networkidle0' });
      await p.type('input[type=email]', 'owner@example.com'); await p.type('input[type=password]', password);
      await p.evaluate(() => document.querySelector('form button[type=submit]')?.click());
      await h.waitFor('Before you start');
      for (const c of await p.$$('input[type=checkbox]')) await c.click();
      await h.press('Agree and continue');
      await h.waitFor('Protect your records');
      const pw = await p.$$('input[type=password]'); await pw[0].type(MASTER); await pw[1].type(MASTER); await h.press('Continue');
      await h.waitFor('recovery kit'); await (await p.$('input[type=checkbox]')).click(); await h.press('Continue');
      await h.waitFor('Explore with sample records', 30000);
      await h.press('Explore with sample records');
      await h.waitFor('Cardiology', 180000); await wait(5000);
    } else {
      await p.setViewport(vp);
      await p.evaluate(l => localStorage.setItem('spine.lang', l), lang);
      await p.evaluateOnNewDocument(l => { try { localStorage.setItem('spine.lang', l); } catch {} }, lang);
      await p.goto(base + '/', { waitUntil: 'networkidle0' });
      await wait(4000);
      await h.shot(`acc-${tag}-unlock`);
      await p.type('input[type=password]', MASTER);
      await p.evaluate(() => document.querySelector('form button[type=submit]')?.click());
      await wait(8000);
    }
    await h.shot(`acc-${tag}-timeline`, '', false);
    await h.shot(`acc-${tag}-timeline-full`);
    if (tag === 'm') { await p.evaluate(() => document.querySelector('button[aria-label="Open menu"]')?.click()); await wait(600); await h.shot('acc-m-navmenu', '', false); await p.evaluate(() => document.querySelector('button[aria-label="Close menu"]')?.click()); await wait(300); }
    if (tag !== 'ro') {
      await p.evaluate(() => document.querySelector('nav button[aria-label="Account and settings"]')?.click()); await wait(500); await h.shot(`acc-${tag}-accountmenu`, '', false); await p.keyboard.press('Escape');
      await p.evaluate(() => document.querySelector('nav button[aria-haspopup=menu]:not([title]):not([aria-label])')?.click()); await wait(500); await h.shot(`acc-${tag}-moremenu`, '', false); await p.keyboard.press('Escape');
      await p.evaluate(() => document.querySelector('button[title="Whose records are open"]')?.click()); await wait(500); await h.shot(`acc-${tag}-peoplemenu`, '', false); await p.keyboard.press('Escape');
    }
    await p.evaluate(() => [...document.querySelectorAll('a')].find(a => a.getAttribute('href')?.startsWith('/documents/'))?.click()); await wait(3000);
    await h.shot(`acc-${tag}-document`);
    const routes = tag === 'ro' ? ['/account', '/share', '/emergency', '/review', '/episodes'] : ['/review', '/episodes', '/trends', '/doctors', '/library', '/search', '/upload', '/scan', '/reminders', '/profiles', '/emergency', '/share', '/account', '/review/fields', '/account/invoices', '/family'];
    if (tag === 'd') {
      // The profile page, empty and then written: the name and birth date are the person's own, the health lists feed the card and a share link.
      await h.go('/emergency'); await wait(2500);
      await h.shot('acc-d-profile-empty');
      await p.type('input[autocomplete="name"]', 'Ana Exemplu');
      await p.type('input[inputmode="numeric"]', '1990-04-02');
      const areas = await p.$$('textarea');
      await areas[0].type('Penicillin'); await areas[1].type('Levothyroxine 50 µg'); await areas[2].type('Hypothyroidism');
      await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save the profile')?.click()); await wait(3500);
      await h.shot('acc-d-profile-saved');
    }
    for (const r of routes) { await h.go(r); await wait(2500); await h.shot(`acc-${tag}-${r.slice(1).replace(/\//g, '-')}`); }
    if (tag === 'd') {
      // a share link made
      await h.go('/share'); await wait(1500);
      await p.evaluate(() => [...document.querySelectorAll('[role=combobox]')][0]?.click()); await wait(500); await h.shot('acc-d-share-scope-open', '', false); await p.keyboard.press('Escape');
      try {
        await p.type('input[placeholder^="e.g."]', 'Dr. Example — thyroid, for a new endocrinologist');
        await (await p.waitForFunction(() => [...document.querySelectorAll('[role=combobox]')].find(i => i.getAttribute('aria-label') === 'What to share' && i.offsetParent))).asElement().evaluate(e => { if (e.getAttribute('aria-expanded') !== 'true') e.click(); }); await wait(500);
        await h.shot('acc-d-share-scope-options', '', false);
        await (await p.waitForFunction(() => [...document.querySelectorAll('[role=listbox] [role=option]')].find(e => e.innerText.trim() === 'All history'))).asElement().evaluate(e => e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))); await wait(400);
        await p.evaluate(() => [...document.querySelectorAll('label')].find(l => l.textContent?.includes('Include my health summary'))?.querySelector('input')?.click()); await wait(400);
        await h.shot('acc-d-share-filled');
        await h.press('Create link'); await h.waitFor('Link created', 40000); await wait(1500); await h.shot('acc-d-share-created');
        const link = await p.evaluate(() => [...document.querySelectorAll('input,a,code')].map(e => e.value ?? e.getAttribute('href') ?? e.innerText).find(v => /\/share\/[^/]+#/.test(v ?? '')));
        log('share link', link ? 'found' : 'not found');
        if (link) {
          const url = link.startsWith('http') ? link : base + link;
          for (const [gtag, gvp, glang] of [['d', DESKTOP, 'de'], ['m', PHONE, 'de'], ['den', DESKTOP, 'en']]) {
            const gctx = await browser.createBrowserContext(); const g = await newPage(gctx, gvp, glang); const gh = helpers(g);
            await g.goto(url, { waitUntil: 'networkidle0' }); await wait(6000); await gh.shot(`guest-${gtag}-share`);
            await g.evaluate(() => [...document.querySelectorAll('a,button')].find(a => /X-ray|Röntgen|Radiografie/.test(a.innerText))?.click()); await wait(3000); await gh.shot(`guest-${gtag}-share-document`);
            await gctx.close();
          }
          // The link follows the profile: a medicine is changed there, and the same link, opened again, shows it.
          const fctx = await browser.createBrowserContext(); const f = await newPage(fctx, DESKTOP, 'en'); const fh = helpers(f);
          await f.goto(url, { waitUntil: 'networkidle0' }); await wait(5000); await fh.shot('guest-d-summary-before');
          await h.go('/emergency'); await wait(2500);
          const areas = await p.$$('textarea'); await areas[1].type('\nMetformin 500 mg');
          await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save the profile')?.click()); await wait(25000);
          await f.reload({ waitUntil: 'networkidle0' }); await wait(5000); await fh.shot('guest-d-summary-after');
          await fctx.close();
        }
        await h.go('/share'); await wait(2000); await h.shot('acc-d-share-list');
      } catch (e) { log('share flow failed', e.message); }
      await h.go('/review'); await p.evaluate(() => [...document.querySelectorAll('a')].find(a => a.getAttribute('href')?.startsWith('/documents/') || a.getAttribute('href')?.startsWith('/uploads/'))?.click()); await wait(2500); await h.shot('acc-d-review-item');
      for (const r of ['/admin', '/admin/subscriptions', '/admin/products', '/admin/invoices', '/admin/accounts', '/admin/settings']) { await h.go(r); await wait(2500); await h.shot(`adm-d-${r === '/admin' ? 'overview' : r.slice(7)}`); }
      // The VAT switch ticked: the day invoices carry VAT from, the One Stop Shop box and Romania's rate appear.
      await h.go('/admin/invoices'); await wait(2000);
      await p.evaluate(() => [...document.querySelectorAll('label')].find(l => l.textContent?.includes('The company is registered for VAT'))?.querySelector('input')?.click()); await wait(800); await h.shot('adm-d-invoices-vat');
      await p.setViewport(PHONE); for (const r of ['/admin', '/admin/accounts']) { await h.go(r); await wait(2000); await h.shot(`adm-m-${r === '/admin' ? 'overview' : r.slice(7)}`); } await p.setViewport(DESKTOP);
      await h.go('/episodes'); await p.evaluate(() => [...document.querySelectorAll('a,button')].find(a => /episode/i.test(a.getAttribute('href') ?? ''))?.click()); await wait(1500);
      await h.go('/'); await wait(1000);
      // A touch viewport reloads the page (Puppeteer), which locks the records again: open them with the master password before asking.
      if (await p.$('input[type=password]')) { await p.type('input[type=password]', MASTER); await p.evaluate(() => document.querySelector('form button[type=submit]')?.click()); await wait(8000); }
      await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? '').startsWith('Ask your records')); b?.click(); }); await wait(1500); await h.shot('acc-d-chat', '', false);
      // The greeting stands while the person has no upload of their own; a help topic puts it away, and a new conversation then offers the questions drawn from the records.
      await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'What can the assistant do?')?.click()); await wait(1500);
      await p.evaluate(() => document.querySelector('button[aria-label="New conversation"]')?.click()); await wait(1500); await h.shot('acc-d-chat-suggestions', '', false);
      await p.keyboard.press('Escape');
    }
  }
} catch (e) {
  log('FAILED', e.stack);
} finally {
  fs.writeFileSync(path.join(out, `index-${process.env.SECTIONS ?? 'all'}.json`), JSON.stringify({ shots: index, errors }, null, 2));
  log(`errors: ${errors.length}`);
  await browser.close(); server.kill(); relayProcess.kill();
  process.exit(0);
}
