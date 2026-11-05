import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SECURITY.md S-59. The release job installed dependencies and ran actions named by a tag while it held the right to sign, so anything that ran in
 * it could sign a tampered build, which `scripts/deploy-check.sh` would accept. The files the CI and the release run are held to what makes that
 * harder: actions pinned by commit, the CI read-only, the scanner's download checked, and the job that signs installs nothing.
 */
const root = path.resolve(import.meta.dirname, '../../..');
const read = (name: string) => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
const ci = read('ci.yml');
const release = read('release.yml');

/** The jobs of a workflow, by name, each with its own text. */
function jobsOf(text: string): Map<string, string> {
  const after = text.slice(text.indexOf('\njobs:\n') + 6);
  const parts = after.split(/^  ([A-Za-z][\w-]*):\s*$/m);
  const jobs = new Map<string, string>();
  for (let i = 1; i < parts.length; i += 2) jobs.set(parts[i], parts[i + 1]);
  return jobs;
}

describe('the workflows', () => {
  it('name every action by the commit it is, not by a tag its owner can move', () => {
    for (const [name, text] of [['ci.yml', ci], ['release.yml', release]]) {
      const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map(m => m[1]).filter(u => !u.startsWith('./'));
      expect(uses.length, name).toBeGreaterThan(0);
      for (const use of uses) expect(use, `${name}: ${use}`).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w.-]+)?@[0-9a-f]{40}$/);
    }
  });

  it('give the CI only what it reads', () => {
    expect(ci).toMatch(/^permissions:\n  contents: read$/m);
  });

  it('check the scanner they download against its published checksum before they run it', () => {
    const gitleaks = jobsOf(ci).get('gitleaks')!;
    expect(gitleaks).toMatch(/sha256sum -c/);
    expect(gitleaks).toMatch(/[0-9a-f]{64}/);
  });

  it('sign in a job that installs and builds nothing, and build in a job that cannot sign', () => {
    const jobs = jobsOf(release);
    const signing = [...jobs].filter(([, text]) => /attestations: write|id-token: write/.test(text));
    expect(signing.length).toBe(1);
    const [, signText] = signing[0];
    expect(signText).not.toMatch(/npm |setup-node|node-version|npx /);
    expect(signText).toMatch(/attest-build-provenance/);
    // what it signs is what the building job made: the hashes are compared before it signs
    expect(signText).toMatch(/sha256sum -c/);
    for (const [name, text] of jobs) {
      if (text === signText) continue;
      expect(text, `${name} must not hold the right to sign or publish`).not.toMatch(/attestations: write|id-token: write|contents: write/);
    }
    expect([...jobs.values()].some(t => /npm ci/.test(t))).toBe(true);
  });
});
