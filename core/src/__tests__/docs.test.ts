import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * What the documents cite must exist: a file path, an environment variable, a code identifier, a relative link and its heading. Prose is not
 * checked, but the names inside it are, because those were what went stale each time the code moved. A name that is meant to be absent (history,
 * another project's, a file the build makes) is listed below with the reason.
 */
const repo = path.resolve(__dirname, '../../..');

/** The files git knows or would add: not what is ignored (a leftover virtual environment, build output). */
function listed(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
}

const rels = listed().filter((f) => fs.existsSync(path.join(repo, f)));
const docs = rels.filter((f) => f.endsWith('.md') && (!f.includes('/') || f.startsWith('docs/')) && f !== 'docs/sidecar.md' && !f.startsWith('Spine Functional'));
const code = rels.filter((f) => /\.(ts|tsx|mjs|js|sh|yaml|service|timer|conf)$/.test(f) || f === 'Dockerfile' || f === 'Caddyfile');
const codeText = code.map((f) => fs.readFileSync(path.join(repo, f), 'utf8')).join('\n');
const identifiers = new Set(codeText.match(/[A-Za-z_$][A-Za-z0-9_$]*/g));
const read = (f: string) => fs.readFileSync(path.join(repo, f), 'utf8');

/** Named in a document on purpose and not in the code. */
const ABSENT_ON_PURPOSE = new Set([
  'manifest.json', // inside an export zip
  '/.well-known/security.txt', // served by nginx, from nginx/
  'connection.js', // a file of @langchain/google-common, cited as the reason for a control
  'backup.js', // the compiled form of server/src/backup.ts
  'support/live.js', // the compiled form of the integration support file
  '/etc/spine/vertex-sa.json', // an example path on the operator's machine
  'rawPredict', // Vertex's own method name
  'HttpOnly', // a cookie attribute
  'approvalFor', // SECURITY.md M-19 names what the old design did
  'GOOGLE_CLOUD_LOCATION', // @google/genai's variable, cited from its bug report
]);

describe('what the documents cite exists', () => {
  it('every file path in backticks is a file in the repository', () => {
    const missing: string[] = [];
    for (const d of docs) {
      for (const m of read(d).matchAll(/`([A-Za-z0-9_./\-[\]]+\.(?:ts|tsx|mjs|js|json|md|sh|py|yaml|yml|service|timer|conf|txt))`/g)) {
        const p = m[1]!;
        if (ABSENT_ON_PURPOSE.has(p) || p.includes('*') || p.startsWith('.')) continue;
        if (rels.some((f) => f === p || f.endsWith('/' + p))) continue;
        if (fs.existsSync(path.join(repo, path.dirname(d), p))) continue;
        missing.push(`${d}: ${p}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every environment variable in backticks is read by some code', () => {
    const missing: string[] = [];
    for (const d of docs) {
      for (const m of read(d).matchAll(/`((?:SPINE|BREVO|GOOGLE|ANTHROPIC)_[A-Z_]+|SESSION_SECRET|DATA_DIR)`/g)) {
        if (!ABSENT_ON_PURPOSE.has(m[1]!) && !codeText.includes(m[1]!)) missing.push(`${d}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every function or type in backticks exists in the code', () => {
    const missing: string[] = [];
    for (const d of docs) {
      const t = read(d);
      const named = [...t.matchAll(/`([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)(?:\(\))?`/g), ...t.matchAll(/`([A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)`/g)];
      for (const m of named) if (!ABSENT_ON_PURPOSE.has(m[1]!) && !identifiers.has(m[1]!)) missing.push(`${d}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('every relative link goes to a file, and its #heading is there', () => {
    const slug = (h: string) => h.trim().toLowerCase().replace(/[`*_]/g, '').replace(/[^\w\- ]/g, '').replace(/ /g, '-');
    const bad: string[] = [];
    for (const d of docs) {
      for (const m of read(d).matchAll(/\]\(([^)\s]+)\)/g)) {
        const link = m[1]!;
        if (/^(https?:|mailto:|\/)/.test(link)) continue; // an address, or a route of the app
        const [p, anchor] = link.split('#');
        const target = p ? path.normalize(path.join(path.dirname(d), p)) : d;
        if (!fs.existsSync(path.join(repo, target))) { bad.push(`${d}: ${link}`); continue; }
        if (anchor && target.endsWith('.md')) {
          const heads = [...read(target).matchAll(/^#+\s+(.*)$/gm)].map((h) => slug(h[1]!));
          if (!heads.includes(anchor)) bad.push(`${d}: ${link}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
