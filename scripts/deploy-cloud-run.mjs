#!/usr/bin/env node
// Deploys the Cloud Run services and the job from deploy/cloud-run/ (docs/deploy-cloud-run.md, step 7), the same way each time:
//
//   node scripts/deploy-cloud-run.mjs [app|relay|jobs ...] [--tag TAG] [--apply] [--allow-removal]
//   node scripts/deploy-cloud-run.mjs capture [app|relay|jobs ...]
//
// It fills the placeholders of the templates, adds the settings this operator keeps outside the repository, compares the result with what runs now and prints the difference.
// Without --apply that is all it does. With --apply it replaces the service (or the job), and a setting that runs now and is not in the result is not removed unless --allow-removal says so.
//
// What it reads, all outside git (the files are ignored):
//   deploy/cloud-run/values.env          PROJECT_ID, INSTANCE, BUCKET, and optionally REGION (europe-west4) and DOMAIN (spinevault.eu)
//   deploy/cloud-run/overlay.<target>.env  the settings the templates leave out or comment out (billing, prices, contacts, models ...), one per line:
//                                          NAME=value           a plain value
//                                          NAME=secret:NAME[:KEY]  a Secret Manager secret (KEY is latest if left out)
//                                          A name the template also has takes the overlay's value.
// `capture` writes the overlay from what runs now, once: everything that runs and differs from the template. Review the file before the first deploy.
// TAG defaults to the short commit, the tag scripts/publish-images.sh pushes. Needs gcloud, signed in to the project.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(root, 'deploy/cloud-run');
const TARGETS = {
  app: { file: 'app.service.yaml', kind: 'service', name: 'spine' },
  relay: { file: 'relay.service.yaml', kind: 'service', name: 'spine-relay' },
  jobs: { file: 'jobs.job.yaml', kind: 'job', name: 'spine-jobs' },
};

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const option = name => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };
const apply = flag('--apply');
const allowRemoval = flag('--allow-removal');
const tag = option('--tag') ?? execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const capture = args[0] === 'capture' && args.shift() === 'capture';
const chosen = args.length ? args : Object.keys(TARGETS);
for (const t of chosen) if (!TARGETS[t]) fail(`unknown target "${t}": app, relay or jobs`);

function fail(message) { console.error(message); process.exit(1); }

/** NAME=value lines; blank lines and # comments are ignored. */
function readEnv(file) {
  if (!fs.existsSync(file)) return null;
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) fail(`${file}: not NAME=value: ${line}`);
    out.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return out;
}

const valuesFile = path.join(dir, 'values.env');
const values = Object.fromEntries(readEnv(valuesFile) ?? fail(`${valuesFile} is missing: PROJECT_ID, INSTANCE and BUCKET, one NAME=value per line`));
for (const key of ['PROJECT_ID', 'INSTANCE', 'BUCKET']) if (!values[key]) fail(`${valuesFile} has no ${key}`);
const region = values.REGION ?? 'europe-west4';
const domain = values.DOMAIN ?? 'spinevault.eu';

const gcloud = (...a) => execFileSync('gcloud', [...a, '--project', values.PROJECT_ID, '--region', region], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** One setting as the template writes it, from `- { name: X, value: "y" }` or its secret form; null for a line that is not one. */
const ENTRY = /^(\s*)- \{ name: (\S+?), (?:value: (.*?)|valueFrom: \{ secretKeyRef: \{ name: (\S+?), key: (\S+?) \} \}) \}\s*$/;
const unquote = v => (/^".*"$/.test(v) ? JSON.parse(v) : v);
const entryOf = line => {
  const m = ENTRY.exec(line);
  if (!m) return null;
  return { indent: m[1], name: m[2], ...(m[4] ? { secret: `${m[4]}:${m[5]}` } : { value: unquote(m[3]) }) };
};
const lineOf = (indent, e) => (e.secret
  ? `${indent}- { name: ${e.name}, valueFrom: { secretKeyRef: { name: ${e.secret.split(':')[0]}, key: ${e.secret.split(':')[1] ?? 'latest'} } } }`
  : `${indent}- { name: ${e.name}, value: ${JSON.stringify(e.value)} }`);
const overlayEntry = ([name, raw]) => (raw.startsWith('secret:') ? { name, secret: raw.slice(7).split(':').length > 1 ? raw.slice(7) : `${raw.slice(7)}:latest` } : { name, value: raw });

/** The template with its placeholders filled and the overlay in place of the settings it names: the text to deploy, and the settings it holds. */
function render(target) {
  const lines = fs.readFileSync(path.join(dir, target.file), 'utf8').split('\n');
  const overlay = (readEnv(path.join(dir, `overlay.${target.key}.env`)) ?? []).map(overlayEntry);
  const named = new Set(overlay.map(e => e.name));
  const out = [];
  let inserted = false;
  for (const line of lines) {
    const entry = entryOf(line);
    if (entry && named.has(entry.name)) continue;
    out.push(line);
    // The overlay goes in right after `env:`, with the indent of the settings that follow.
    if (!inserted && /^\s+env:\s*$/.test(line)) {
      const next = lines[lines.indexOf(line) + 1] ?? '';
      const indent = /^(\s*)/.exec(next)?.[1] ?? `${/^(\s*)/.exec(line)[1]}  `;
      for (const e of overlay) out.push(lineOf(indent, e));
      inserted = true;
    }
  }
  if (overlay.length && !inserted) fail(`${target.file} has no env: block to put the overlay in`);
  let text = out.join('\n').replace(/\bPROJECT_ID\b/g, values.PROJECT_ID).replace(/\bINSTANCE\b/g, values.INSTANCE).replace(/\bBUCKET\b/g, values.BUCKET).replace(/\bTAG\b/g, tag);
  if (domain !== 'spinevault.eu') text = text.replace(/spinevault\.eu/g, domain);
  const left = text.split('\n').filter(l => !/^\s*#/.test(l) && /\bCHANGE\b/.test(l));
  if (left.length) fail(`${target.file} still has CHANGE in a setting that is on:\n${left.join('\n')}`);
  const settings = new Map();
  for (const line of text.split('\n')) { const e = entryOf(line); if (e) settings.set(e.name, e); }
  const image = /^\s*-? ?image: (\S+)/m.exec(text)?.[1];
  return { text, settings, image };
}

/** What runs now: the settings (value or secret) and the image. */
function live(target) {
  const d = JSON.parse(gcloud('run', target.kind === 'job' ? 'jobs' : 'services', 'describe', target.name, '--format=json'));
  const spec = target.kind === 'job' ? d.spec.template.spec.template.spec : d.spec.template.spec;
  const container = spec.containers[0];
  const settings = new Map();
  for (const e of container.env ?? []) {
    const ref = e.valueFrom?.secretKeyRef;
    settings.set(e.name, ref ? { name: e.name, secret: `${ref.name}:${ref.key}` } : { name: e.name, value: e.value ?? '' });
  }
  return { settings, image: container.image };
}

const show = e => (e.secret ? `secret ${e.secret}` : JSON.stringify(e.value));
const same = (a, b) => a.secret === b.secret && a.value === b.value;

function difference(now, next) {
  const rows = [];
  if (now.image !== next.image) rows.push(['change', 'image', `${now.image}  ->  ${next.image}`]);
  for (const [name, e] of next.settings) {
    const was = now.settings.get(name);
    if (!was) rows.push(['add', name, show(e)]);
    else if (!same(was, e)) rows.push(['change', name, `${show(was)}  ->  ${show(e)}`]);
  }
  for (const [name, e] of now.settings) if (!next.settings.has(name)) rows.push(['remove', name, show(e)]);
  return rows;
}

for (const key of chosen) {
  const target = { ...TARGETS[key], key };
  const label = `${target.kind} ${target.name}`;
  const next = render(target);
  const now = live(target);

  if (capture) {
    const file = path.join(dir, `overlay.${key}.env`);
    if (fs.existsSync(file)) { console.log(`${file} exists: not overwritten`); continue; }
    const bare = { ...target, key: `${key}.none` };
    const template = render(bare);
    const lines = ['# Settings that run now and the template does not hold (or holds differently). Written by scripts/deploy-cloud-run.mjs capture; review it.'];
    for (const [name, e] of now.settings) {
      const t = template.settings.get(name);
      if (t && same(t, e)) continue;
      lines.push(`${name}=${e.secret ? `secret:${e.secret}` : e.value}`);
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    console.log(`${file}: ${lines.length - 1} settings`);
    continue;
  }

  const rows = difference(now, next);
  console.log(`\n== ${label} (image tag ${tag}) ==`);
  if (!rows.length) console.log('nothing differs from what runs now');
  for (const [what, name, detail] of rows) console.log(`  ${what.padEnd(6)} ${name}  ${detail}`);
  if (!apply) continue;

  const removals = rows.filter(r => r[0] === 'remove');
  if (removals.length && !allowRemoval) fail(`${label}: ${removals.length} settings run now and are not in what would be deployed (${removals.map(r => r[1]).join(', ')}). Put them in deploy/cloud-run/overlay.${key}.env, or run again with --allow-removal.`);
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'spine-deploy-'));
  const file = path.join(scratch, target.file);
  fs.writeFileSync(file, next.text, { mode: 0o600 });
  try {
    console.log(gcloud('run', target.kind === 'job' ? 'jobs' : 'services', 'replace', file).trim());
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (key === 'app') {
    // The front page: the probe's /healthz is Cloud Run's own and is not served on the public address.
    const res = await fetch(`https://${domain}/`).catch(() => null);
    console.log(res?.ok ? `https://${domain}/ answers ${res.status}` : `https://${domain}/ did not answer: look at the revision`);
  }
}
if (!apply && !capture) console.log('\nNothing was changed. Run again with --apply to deploy.');
