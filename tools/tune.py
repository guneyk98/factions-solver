#!/usr/bin/env python3
"""Measures what the search finds against what it costs, to set the presets.

Quality is against a reference found by a much heavier search, so a number here
is "how close to the best we know of", not an absolute. Cost is the wall time
one worker would take, which is what a person waits: with W workers and R
restarts each worker runs its share, so the time for a slice that size is it.

Run it as `tools/tune.py full` or `tune.py dense`. Not part of tests/run.sh, since it
takes minutes and measures rather than checks.

What was measured in 2026-08, and what the presets in app.js came from:

  * A single run says almost nothing. Every setting from r=16 i=100k upward
    reached the same figure as a reference 16x its size, on both villages. The
    thing that separates settings is not the answer they average but how often
    they fall short of it.

  * So the deciding measurement was the spread over five independent runs of
    the same setting (different `first`, so no shared streams):

        r=8  i=30k  (the old Fast)   up to 18.62% below its own best
        r=16 i=60k  (the new Fast)             3.90%
        r=24 i=100k (Normal)                   0.00%
        r=64 i=200k (Thorough)                 0.00%

  * Which density is hardest is not obvious. `full` (26 buildings) is settled
    by anything. `dense` (70 on ~75 buildable tiles) has nowhere to relocate
    to. `roomy` (37, half the ground free) has the most arrangements and was
    the last to stop varying.

  * Restarts and iterations do not trade evenly. On a sparse village restarts
    win (r=16 i=20k beat r=8 i=30k on both quality and time); on a dense one
    iterations win (r=8: 30k->60k moved 97.5%->99.5%, while r=8->16 at 60k
    moved only 99.54%->99.62%). Restarts are also what goes wide across
    workers, so they are the cheaper of the two to raise.

  * Thorough measured no better than Normal on anything here. It is kept for
    villages harder than these, not on evidence that it scores better than Normal.
"""

import json
import math
import statistics
import subprocess
import sys
import time

HARNESS = 'build/Harness'

SETS = {
    # `full` is a small village and any effort at all solves it; `dense` packs
    # the ground out and is where the presets actually have to be chosen.
    'full': [
        ('full', 'wood.production'),
        ('full', 'soldiers.production.attack'),
        ('full-modifiers', 'wood.production:2,iron.production:1'),
    ],
    'dense': [
        ('dense', 'wood.production'),
        ('dense', 'soldiers.production.attack'),
        ('dense', 'wood.production:2,iron.production:1'),
        ('dense', 'workers.storage'),
    ],
}

CASES = SETS[sys.argv[1] if len(sys.argv) > 1 else 'full']
REFERENCE = 'restarts=96,iterations=400000,improvementPasses=80,budget=800000'
WORKERS = 4  # this machine; an 8-core one halves the share again


def run(case, goal, effort):
    started = time.perf_counter()
    out = subprocess.run([HARNESS, 'rearrange', f'tests/cases/{case}.txt', goal, effort],
                         capture_output=True, text=True)
    took = time.perf_counter() - started
    if out.returncode != 0 or out.stdout.startswith('!'):
        raise SystemExit(f'refused: {out.stdout}{out.stderr}')
    return json.loads(out.stdout), took


def worth(found):
    """One number for how good an answer is, by the rule the solver ranks by."""
    if found['ranking'] == 'weighted-sum':
        return sum(g['weight'] * g['after'] / g['alone']
                   for g in found['goals'] if g.get('alone', 0) > 0)
    return found['goals'][0]['after']


def main():
    print('finding a reference for each case (this is the slow part)...', flush=True)
    best = {}
    for case, goal in CASES:
        found, took = run(case, goal, REFERENCE)
        best[(case, goal)] = worth(found)
        print(f'  {case:15} {goal:36} {worth(found):12.5f}  ({took:.1f}s)', flush=True)

    presets = [
        ('fast now',   'restarts=8,iterations=30000,improvementPasses=24,budget=60000', 8),
        ('normal now', 'restarts=24,iterations=100000,improvementPasses=40,budget=200000', 24),
    ]
    for r, i in ((8, 30000), (8, 60000), (16, 60000), (16, 100000), (24, 100000),
                 (32, 100000), (32, 200000), (48, 200000), (64, 300000)):
        presets.append((f'r={r} i={i // 1000}k',
                        f'restarts={r},iterations={i},improvementPasses=40,budget={i * 2}', r))
    presets.append(('r=48 i=200k s=80', 'restarts=48,iterations=200000,improvementPasses=80,budget=400000', 48))

    print(f'\n{"preset":18} {"quality":>8} {"worst":>8}  {"wall on 4":>10}')

    for name, effort, restarts in presets:
        qualities = []
        for case, goal in CASES:
            found, _ = run(case, goal, effort)
            qualities.append(worth(found) / best[(case, goal)])

        share = math.ceil(restarts / WORKERS)
        wall = max(run(case, goal, f'{effort},first=0,count={share}')[1] for case, goal in CASES)

        print(f'{name:18} {100 * statistics.mean(qualities):7.2f}% {100 * min(qualities):7.2f}%  '
              f'{wall:9.2f}s', flush=True)

    return 0


if __name__ == '__main__':
    sys.exit(main())
