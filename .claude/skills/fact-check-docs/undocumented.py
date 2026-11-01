#!/usr/bin/env python3 -I
"""Code to documents: what the code defines that no document mentions (the other direction of the fact check).

usage: python3 -I .claude/skills/fact-check-docs/undocumented.py [<git range, default main..HEAD>]

For the files changed in the range it lists, with the documents that mention each (or none):
  - environment variables the code reads
  - routes the code registers
  - tables the schemas create
  - CLI commands
  - the changed production files themselves (by path)
A line with `NONE` is a thing no document names. It is not always a defect (an internal file needs no page), but each must be looked at and
either documented or left on purpose. Run it after a change, then read the documents it points to and check they still say what the code does.
"""
import re, subprocess, sys
from pathlib import Path

rng = sys.argv[1] if len(sys.argv) > 1 else 'main..HEAD'
def sh(*a): return subprocess.run(a, capture_output=True, text=True, check=True).stdout
changed = [f for f in sh('git', 'diff', '--name-only', '--diff-filter=AM', rng).split('\n') if f]
prod = [f for f in changed if re.search(r'\.(ts|tsx|mjs|js|sh)$', f) and '__tests__' not in f and '/testing/' not in f and not f.endswith('.test.ts') and 'browser-check' not in f]
docs = {f: Path(f).read_text(encoding='utf8', errors='ignore') for f in sh('git', 'ls-files', '*.md', '.env.example').split('\n') if f and not f.startswith('node_modules')}
def where(term):
    hits = sorted(f for f, text in docs.items() if term in text)
    return hits

def report(title, items):
    print(f'\n## {title} ({len(items)})')
    for name, hits in items:
        print(f"  {'NONE' if not hits else 'ok  '}  {name}" + ('' if not hits else '  <- ' + ', '.join(h.split('/')[-1] for h in hits[:4]) + ('…' if len(hits) > 4 else '')))

def added(f):
    # only the lines the range adds: what is new, not everything in a file that was touched
    out = subprocess.run(['git', 'diff', '-U0', rng, '--', f], capture_output=True, text=True).stdout
    return '\n'.join(l[1:] for l in out.split('\n') if l.startswith('+') and not l.startswith('+++'))
text = {f: added(f) for f in prod}
envs, routes, cmds = set(), set(), set()
for f, t in text.items():
    envs |= set(re.findall(r'(?:process\.env|env)\.([A-Z][A-Z0-9_]{3,})', t))
    envs |= set(re.findall(r"env\[\s*'([A-Z][A-Z0-9_]{3,})'", t))
    routes |= set(re.findall(r"app\.(?:get|post|put|delete|patch)(?:<[^>]*(?:\{[^}]*\}[^>]*)*>)?\(\s*'(/[^']+)'", t))
    cmds |= set(re.findall(r"case '([a-z0-9-]+)':", t)) if f.endswith('cli.ts') else set()
# environment variables the platform sets are not ours to document
ignore = {'NODE_ENV', 'PORT', 'HOME', 'PATH', 'CI', 'TZ'}
report('environment variables read', [(e, where(e)) for e in sorted(envs - ignore)])
report('routes registered', [(r, where(r.split(':')[0].rstrip('/') if ':' in r else r)) for r in sorted(routes)])
tables = set()
for f in changed:
    if 'schema-' in f: tables |= set(re.findall(r'CREATE TABLE IF NOT EXISTS (\w+)', added(f)))
report('tables created', [(t, where(t)) for t in sorted(tables)])
report('operator commands', [(c, where(c)) for c in sorted(cmds)])
def file_hits(f):
    # a file is documented by its path, by its directory (a page may describe `store/postgres/`), or by name beside its folder
    parts = f.split('/')
    keys = [f, '/'.join(parts[1:]) if len(parts) > 2 else f, '/'.join(parts[:-1]) + '/', '/'.join(parts[1:-1]) + '/' if len(parts) > 3 else '', parts[-1]]
    hits = {h for k in keys if k and (k == parts[-1] and len(k) > 8 or k != parts[-1]) for h in where(k)}
    # a page that names the folder and, beside it, the file by its short name (a layout listing) documents it too
    hits |= {d for d in where(parts[-2] + '/') if parts[-1] in docs[d]}
    return sorted(hits)
report('changed production files, by path or directory', [(f, file_hits(f)) for f in prod if not f.startswith('web/src/i18n/')])
