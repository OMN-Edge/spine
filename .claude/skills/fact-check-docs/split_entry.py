#!/usr/bin/env python3
"""Print one entry of a document as numbered sentences, so every sentence gets its own verdict.

    python3 -I .claude/skills/fact-check-docs/split_entry.py SECURITY.md M-21
    python3 -I .claude/skills/fact-check-docs/split_entry.py docs/scenarios.md "### 7.2"
    python3 -I .claude/skills/fact-check-docs/split_entry.py docs/architecture/data.md "## Share links"

The entry starts at the first line that begins with `**<name> ` or with the given heading, and ends at the next line that begins the same
way (or the next heading of the same or a higher level). Sentences are split at . ! ? : ; followed by a capital letter, a backtick, a
bracket or an asterisk; read the original as well, the split is a guide. Write the verdict next to each number as you check it.
"""
import re
import sys


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    path, name = sys.argv[1], sys.argv[2]
    lines = open(path, encoding='utf-8').read().split('\n')
    heading = name.startswith('#')
    start = next((i for i, l in enumerate(lines) if (l.startswith(name) if heading else l.startswith(f'**{name} '))), None)
    if start is None:
        sys.exit(f'no entry {name!r} in {path}')
    level = len(name.split(' ')[0]) if heading else None
    end = len(lines)
    for i in range(start + 1, len(lines)):
        l = lines[i]
        if heading and re.match(r'#{1,%d} ' % level, l):
            end = i
            break
        if not heading and re.match(r'\*\*[A-Z]+-?\d+[a-z]? ', l):
            end = i
            break
    text = ' '.join(l.strip() for l in lines[start:end] if l.strip() and not l.startswith('```'))
    parts = re.split(r'(?<=[.!?:;])\s+(?=[A-Z`(*\[])', text)
    for i, p in enumerate(parts, 1):
        print(f'{i}. {p}')
    print(f'\n{len(parts)} sentences in {name} ({path}:{start + 1}-{end})', file=sys.stderr)


if __name__ == '__main__':
    main()
