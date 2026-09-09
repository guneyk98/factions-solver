#!/usr/bin/env python3
"""Splitting the restarts across workers has to find what one run would find.

Each restart draws on a stream of its own, so running restarts 0..5 here and
6..11 there and keeping the better of the two is the same search as running
0..11 in one go, only quicker. That is the whole basis for the worker pool in
app.js, so it is checked rather than assumed.

`better` below is also the rule app.js reduces by; if the two ever disagree the
page would pick the wrong layout out of its workers.
"""

import itertools
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).parent.parent
HARNESS = ROOT / 'build' / 'Harness'


def run(case, goal, effort):
    out = subprocess.run([HARNESS, 'rearrange', ROOT / 'tests' / 'cases' / f'{case}.txt', goal, effort],
                         capture_output=True, text=True)
    if out.returncode != 0 or out.stdout.startswith('!'):
        raise SystemExit(f'harness refused {case} {goal} {effort}: {out.stdout}{out.stderr}')
    return json.loads(out.stdout)


def better(a, b):
    """Whether a scores better than b, by the rule the solver compares by."""
    if a['ranking'] == 'weighted-sum':
        total = lambda d: sum(g['weight'] * g['after'] / g['alone']
                              for g in d['goals'] if g.get('alone', 0) > 0)
        return total(a) > total(b)

    for one, two in zip(a['goals'], b['goals']):
        scale = max(abs(one['after']), abs(two['after']), 1.0)
        if abs(one['after'] - two['after']) > 1e-9 * scale:
            return one['after'] > two['after']
    return False


def same(a, b):
    return not better(a, b) and not better(b, a)


def main():
    goals = ['wood.production', 'soldiers.production.attack',
             'wood.production:2,iron.production:1', 'wood.storage,iron.storage']

    tried = differed = bad = 0

    # `dense` has seventy pieces to shuffle rather than twenty-six, so it
    # exercises the move generator far harder; kept short to stay quick.
    plans = [(case, goal, restarts, iterations, ways)
             for case, goal, restarts, iterations, ways in itertools.product(
                 ['full', 'full-modifiers'], goals, [4, 8, 12], [300, 3000], [2, 4])]
    plans += [('dense', goal, restarts, 400, ways)
              for goal, restarts, ways in itertools.product(goals, [4, 8], [2, 4])]

    for case, goal, restarts, iterations, ways in plans:
        base = f'restarts={restarts},iterations={iterations},improvementPasses=6,budget=50000'
        whole = run(case, goal, base)

        step = restarts // ways
        parts = [run(case, goal, f'{base},first={first},count={step}')
                 for first in range(0, restarts, step)]

        best = parts[0]
        for part in parts[1:]:
            if better(part, best):
                best = part

        tried += 1
        if any(not same(part, parts[0]) for part in parts):
            differed += 1

        if not same(best, whole):
            bad += 1
            print(f'FAIL {case} {goal} restarts={restarts} iterations={iterations} '
                  f'{ways} ways: split found {[g["after"] for g in best["goals"]]}, '
                  f'one run found {[g["after"] for g in whole["goals"]]}', file=sys.stderr)

    print(f'{tried} searches split every way, {differed} where the parts disagree, {bad} wrong')
    return 1 if bad or differed < tried // 2 else 0


if __name__ == '__main__':
    sys.exit(main())
