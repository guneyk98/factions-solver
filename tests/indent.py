#!/usr/bin/env python3
"""Indents the JSON on stdin one space per level, so a recorded answer diffs
line by line. Only whitespace is added: every token is copied as the harness
wrote it, since parsing and re-serialising would rewrite number literals (jq
turns 3.7e+10 into 3.7E+10). An array holding no object or array stays on one
line."""

import sys


def tokens(text):
    at = 0
    while at < len(text):
        c = text[at]
        if c in ' \t\r\n':
            at += 1
        elif c in '{}[],:':
            yield c
            at += 1
        elif c == '"':
            end = at + 1
            while text[end] != '"':
                end += 2 if text[end] == '\\' else 1
            yield text[at:end + 1]
            at = end + 1
        else:
            end = at
            while end < len(text) and text[end] not in ' \t\r\n{}[],:':
                end += 1
            yield text[at:end]
            at = end


def flat(toks, start):
    """Whether the array opening at toks[start] holds no object or array."""
    for tok in toks[start + 1:]:
        if tok == ']':
            return True
        if tok in '{[':
            return False
    return True


def indent(text):
    toks = list(tokens(text))
    out = []
    depth = 0
    inline = 0
    for i, tok in enumerate(toks):
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        if inline:
            out.append(', ' if tok == ',' else tok)
            if tok == '[':
                inline += 1
            elif tok == ']':
                inline -= 1
            continue
        if tok in '{[':
            if tok == '[' and flat(toks, i):
                out.append(tok)
                inline = 1
                continue
            out.append(tok)
            if nxt not in '}]':
                depth += 1
                out.append('\n' + ' ' * depth)
        elif tok in '}]':
            if toks[i - 1] not in '{[':
                depth -= 1
                out.append('\n' + ' ' * depth)
            out.append(tok)
        elif tok == ',':
            out.append(',\n' + ' ' * depth)
        elif tok == ':':
            out.append(': ')
        else:
            out.append(tok)
    return ''.join(out)


sys.stdout.write(indent(sys.stdin.read()) + '\n')
