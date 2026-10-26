#!/usr/bin/env python3
"""List the checkable claims of a document as a numbered worklist.

    python3 -I .claude/skills/fact-check-docs/extract_claims.py docs/legal/privacy.md > claims.md

One line per sentence (or table cell) that says something a person could check against the code: it names a file, route, variable or
identifier, gives a number, says where something runs, or uses an absolute word. Each line has the claim's id, the document line and
the kinds of claim found. Add a `-- verdict` after each as you check it. A sentence not listed is not thereby true: read the document
too; this only stops you skipping the ones that matter.
"""
import re
import sys

KINDS = [
    ('name', re.compile(r'`[^`]+`')),
    ('number', re.compile(r'\b\d[\d,.]*\s?(?:MB|GB|KB|px|pages?|characters?|chars|seconds?|minutes?|hours?|days?|months?|years?|files?|photos?|documents?|a minute|an hour|%|MiB|bytes|calls?|rounds?|turns?|messages?|conversations?)\b|\b(?:at most|up to|no more than|default|at least|within)\s+\w*\s?\d', re.I)),
    ('place', re.compile(r'\b(?:the server|this server|on the server|server-side|the device|this device|the browser|the relay|the core|the client|nginx|Caddy|the provider|the operator|third part)', re.I)),
    ('absolute', re.compile(r"\b(?:never|always|only|no one|nobody|cannot|can't|does not|do not|doesn't|must not|every|all of|none|nothing|exactly|at most|at once|instantly)\b", re.I)),
    ('state', re.compile(r'\b(?:built|not built|not done|untested|tested|verified|checked|audited|planned|later|today|now|no longer|since|used to|still|already|yet)\b', re.I)),
]


def sentences(text):
    out = []
    for n, line in enumerate(text.split('\n'), 1):
        line = line.strip()
        if not line or line.startswith(('```', '#', '---', '|---', '| ---')):
            continue
        if line.startswith('|'):
            cells = [c.strip() for c in line.strip('|').split('|')]
            out += [(n, c) for c in cells if len(c) > 12]
            continue
        line = re.sub(r'^[-*>\d.\s]+', '', line)
        parts = re.split(r'(?<=[.!?;])\s+(?=[A-Z`(*])', line)
        out += [(n, p.strip()) for p in parts if len(p.strip()) > 12]
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    text = open(path, encoding='utf-8').read()
    i = 0
    for n, s in sentences(text):
        kinds = [k for k, pat in KINDS if pat.search(s)]
        if not kinds:
            continue
        i += 1
        print(f'C{i} [{path}:{n}] ({", ".join(kinds)}) {s}')
    print(f'\n{i} claims listed from {path}', file=sys.stderr)


if __name__ == '__main__':
    main()
