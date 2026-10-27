import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HEALTH_CONSENT_VERSION, TERMS_VERSION } from '../consent.js';
import recorded from './legal-texts.json';

/**
 * Habits the reviews of 2026-10-26 had to enforce by hand (CONTRIBUTING.md, "Keeping what we say true"), as checks: each one failed on a
 * fault that was really there. They are heuristics with a short, reasoned list of what they let through; a new entry is a decision.
 */
const repo = path.resolve(__dirname, '../../..');
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\n').filter(f => f && fs.existsSync(path.join(repo, f)));
const read = (f: string) => fs.readFileSync(path.join(repo, f), 'utf8');

describe('the texts people agree to', () => {
  it('cannot change without their version being raised and recorded', () => {
    // The hashes are of docs/legal/*.md; changing a text means raising its version in consent.ts, then updating legal-texts.json with
    // the new version and hash. A text and a version that disagree with this record fail here, so neither moves alone.
    expect(recorded.versions).toEqual({ HEALTH: HEALTH_CONSENT_VERSION, TERMS: TERMS_VERSION });
    for (const [name, entry] of Object.entries(recorded.texts)) {
      const sha = createHash('sha256').update(read(`docs/legal/${name}.md`)).digest('hex');
      expect(sha, `docs/legal/${name}.md changed: raise ${entry.consent === 'HEALTH' ? 'HEALTH_CONSENT_VERSION' : 'TERMS_VERSION'} in consent.ts and record the new version and hash in legal-texts.json`).toBe(entry.sha256);
    }
  });
});

describe('documents', () => {
  it('cite no line numbers (they go stale with the next edit)', () => {
    const docs = files.filter(f => f.endsWith('.md') && (!f.includes('/') || f.startsWith('docs/')) && f !== 'docs/sidecar.md' && !f.startsWith('Spine Functional'));
    const cited = docs.flatMap(d => [...read(d).matchAll(/`[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js|sh|conf|yaml):\d[\d,-]*`/g)].map(m => `${d}: ${m[0]}`));
    expect(cited).toEqual([]);
  });
});

describe('screen text', () => {
  // Every screen string that says something about "the server", reviewed: each is about a switch the operator sets, the mailer or the
  // trust anchors, which really are the server's. The records are on the device, so a new string that says the server does something with
  // them is the fault this list exists to stop. Add a string here only after checking it against where the code runs.
  const REVIEWED = new Set<string>([
  "Switched off on this server",
  "This server does not send page images to the model, so a scan with no text layer stays empty. The operator can turn that on (see the setup guide); until then the scan itself is the only record of the page.",
  "{name} was not added: a photo can only be read by sending it to the AI model, and that is switched off on this server. A scanning app that saves a PDF works without it.",
  "No linked documents. Looking for links is switched off on this server; you can still add one.",
  "Asking questions is switched off on this server.",
  "Each question sends your words and the summaries and results of the matching documents (and the text of a few pages when you ask it to sort an upload) to the AI model this server uses. Your conversations are kept in your archive, in History, until you delete them.",
  "No email is set up on this server, so requests are not emailed. They wait on this page.",
  "A photo has to be read by the AI model, which is switched off on this server.",
  "Pages with no text and photos are not sent anywhere: they are not read, because sending images is switched off on this server.",
  "Pages from a camera have no text, so they can only be read here if image reading or local OCR is switched on for this server. A scanning app that saves a PDF works without either.",
  "The certificates in the file lead to an authority this server trusts",
  // The front page (web/src/pages/Landing.tsx): what the server holds of a record, which is sealed pieces it cannot open (readme.md, SECURITY.md
  // P7 and the share row under "Principles", M-34, M-36). The headings name the server as the place a sealed piece sits, with no verb.
  "Your records are read, searched and kept in your browser. The keys that open them are made there, from your password. The server stores them only as sealed pieces it cannot open.",
  "A share link covers what you pick: everything, a tag, a few documents or a date range. It ends when you say, you can revoke it at any time, and the server never holds a key that opens it.",
  "The server",
  "On the server"
]);
  it('says "the server" only where it was checked to be the server', () => {
    const english = Object.keys(JSON.parse(read('web/src/i18n/ro.json')) as Record<string, string>);
    const unreviewed = english.filter(s => /\bserver\b/i.test(s) && !REVIEWED.has(s));
    expect(unreviewed).toEqual([]);
  });
});

describe('code', () => {
  const src = files.filter(f => /\.(ts|tsx|mjs)$/.test(f) && /^(core|server|web)\/(src|scripts)\//.test(f) && !f.endsWith('.d.ts'));
  const isTest = (f: string) => /__tests__|\.test\.|\/testing\/|__integration__|\.it\.ts/.test(f);
  const prod = src.filter(f => !isTest(f));
  // Comments are cut out first: a function named only in a comment is still called by nothing.
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const text = new Map(src.map(f => [f, code(read(f))]));

  // Exports that production code never refers to, not even in their own file. These are the functions a test calls and nothing else does;
  // a function that must run at start and has no caller is exactly this (reconcileStalledJobs was one for a long time). Each one below is
  // on purpose: a helper for tests, or an entry point for tests that wait for the work.
  const TEST_ONLY = new Set([
    'resetEmbedder', 'resetAiReadings', 'resetChatLlm', 'resetParser', 'resetRegroupJobs', 'resetServerClock', 'resetMailer', // between tests
    'settleLinking', 'settleSync', 'readUpload', // the same work as the started one, waiting for it
    'createStore', 'hasStoreFactory', 'currentClockOffset', 'useNodeTools', 'asPlugin', 'SLICE_BUILT', 'SLICE_NEVER', 'isListed', // test setup and contract suites
    'base32Decode', 'newRecoveryKey', // pure helpers with their own tests
    'openSync', 'closeSync', 'readSync', // the in-memory filesystem's Node-shaped surface
    'NOTICE_TITLES', // marks strings for the translation dictionaries only
    'TOOL_KINDS', 'ENTRYPOINTS', // lists that a test holds the code to (every chat tool is read or action; every process is started)
    'openWasm', // the WebAssembly driver as a factory, for the suite that runs on it
  ]);
  it('has no production export that nothing refers to, except the listed test helpers', () => {
    const exported = /^export\s+(?:async\s+)?(?:function\*?|const|class|let|enum)\s+([A-Za-z_$][\w$]*)/gm;
    const loose: string[] = [];
    for (const f of prod) {
      for (const m of text.get(f)!.matchAll(exported)) {
        const name = m[1]!;
        if (TEST_ONLY.has(name)) continue;
        const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
        const own = text.get(f)!.match(new RegExp(re.source, 'g'))!.length;
        if (own <= 1 && !prod.some(g => g !== f && re.test(text.get(g)!))) loose.push(`${f}: ${name}`);
      }
    }
    expect(loose).toEqual([]);
  });

  it('declares no runtime dependency that nothing in its package names', () => {
    const unused: string[] = [];
    for (const ws of ['core', 'server', 'web']) {
      const pkg = JSON.parse(read(`${ws}/package.json`)) as { dependencies?: Record<string, string> };
      const own = files.filter(f => f.startsWith(`${ws}/`) && !f.endsWith('lock.json') && f !== `${ws}/package.json`);
      const blob = own.map(f => { try { return read(f); } catch { return ''; } }).join('\n');
      for (const dep of Object.keys(pkg.dependencies ?? {})) if (!blob.includes(dep)) unused.push(`${ws}: ${dep}`);
    }
    expect(unused).toEqual([]);
  });
});
