import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A container image named by a tag is whatever the tag points at on the day it is pulled, so a rebuild next month can be a different
 * system (SECURITY.md S-32). Every image the build, the compose file and the pipelines use is named with the digest of its
 * multi-architecture index, which is also what keeps a build working on both kinds of CPU.
 */
const repo = path.resolve(__dirname, '../../..');
const FILES = ['Dockerfile', 'relay.Dockerfile', 'compose.yaml', '.gitlab-ci.yml', '.github/workflows/ci.yml'];

/** Every image reference in a file: FROM lines (not the build stages they name), and the `image:`, `container:` and `image: name:` keys. */
function imagesIn(file: string): Array<{ line: number; ref: string }> {
  const lines = fs.readFileSync(path.join(repo, file), 'utf8').split('\n');
  const stages = new Set<string>();
  const out: Array<{ line: number; ref: string }> = [];
  lines.forEach((text, i) => {
    const from = text.match(/^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) {
      if (!stages.has(from[1])) out.push({ line: i + 1, ref: from[1] });
      if (from[2]) stages.add(from[2]);
      return;
    }
    const key = text.match(/^\s*(?:image|container):\s*([^\s#]+)/);
    if (key) { out.push({ line: i + 1, ref: key[1] }); return; }
    const name = text.match(/^\s*name:\s*([^\s#]+)/);
    if (name && /^\s*image:\s*(#.*)?$/.test(lines[i - 1] ?? '')) out.push({ line: i + 1, ref: name[1] });
  });
  return out;
}

describe('the container images the build and the pipelines use', () => {
  it('are all named by digest', () => {
    const floating: string[] = [];
    for (const file of FILES) for (const { line, ref } of imagesIn(file)) if (!/@sha256:[0-9a-f]{64}$/.test(ref)) floating.push(`${file}:${line} ${ref}`);
    expect(floating).toEqual([]);
  });

  it('are found: the references this reads are the ones there are', () => {
    const found = FILES.flatMap(f => imagesIn(f).map(i => `${f}: ${i.ref.split('@')[0]}`)).sort();
    expect(found).toEqual([
      '.github/workflows/ci.yml: semgrep/semgrep',
      '.gitlab-ci.yml: node:22',
      '.gitlab-ci.yml: semgrep/semgrep',
      '.gitlab-ci.yml: zricethezav/gitleaks:v8.24.2',
      'Dockerfile: node:22-bookworm-slim',
      'Dockerfile: node:22-bookworm-slim',
      'compose.yaml: caddy:2',
      'relay.Dockerfile: node:22-bookworm-slim',
      'relay.Dockerfile: node:22-bookworm-slim',
    ]);
  });
});
