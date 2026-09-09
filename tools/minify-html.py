#!/usr/bin/env python3
"""Shrinks an html file without changing what it renders.

Two rules, both of which the browser already applies:

  * a comment is not rendered, so it is dropped;
  * a run of whitespace in ordinary markup renders as one space, so it is
    written as one space.

Nothing else is touched. Tags, attributes and quoting are left exactly as
written, and the elements where whitespace does count -- pre, textarea, script
and style -- are copied through untouched.

    tools/minify-html.py in.html out.html
"""

import re
import sys

# What is inside these renders as it is written, so it is left as it is.
VERBATIM = re.compile(
    r'<(pre|textarea|script|style)\b[^>]*>.*?</\1\s*>',
    re.IGNORECASE | re.DOTALL,
)

COMMENT = re.compile(r'<!--(?!\[if).*?-->', re.DOTALL)
RUNS = re.compile(r'\s{2,}|\s*\n\s*')


def shrink(html):
    kept = []

    def park(match):
        kept.append(match.group(0))
        return f'\x00{len(kept) - 1}\x00'

    html = VERBATIM.sub(park, html)
    html = COMMENT.sub('', html)
    html = RUNS.sub(' ', html)
    return re.sub(r'\x00(\d+)\x00', lambda m: kept[int(m.group(1))], html).strip() + '\n'


def main():
    if len(sys.argv) != 3:
        raise SystemExit(f'usage: {sys.argv[0]} <in.html> <out.html>')

    with open(sys.argv[1], encoding='utf-8') as source:
        html = source.read()

    with open(sys.argv[2], 'w', encoding='utf-8') as out:
        out.write(shrink(html))


if __name__ == '__main__':
    main()
