#!/usr/bin/env bash

# Runs every case through the harness and diffs the output against the
# recorded answers in tests/expected. `--record` overwrites those answers
# instead of comparing against them, which is how they were first produced and
# how they are updated when a change is meant to move them.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
harness="$root/build/Harness"
cases="$root/tests/cases"
expected="$root/tests/expected"

record=0
[[ ${1:-} == --record ]] && record=1

[[ -x $harness ]] || { echo "no build/Harness, run: cmake --build build" >&2; exit 1; }

mkdir -p "$expected"

passed=0
failed=0
recorded=0

# $1 name, rest: harness arguments
check() {
    local name=$1
    shift

    local got
    got=$("$harness" "$@" 2>&1)
    local status=$?
    if (( status >= 2 )); then
        printf 'ERROR %s: harness exited %d\n' "$name" "$status" >&2
        failed=$(( failed + 1 ))
        return
    fi

    local want="$expected/$name.txt"

    if (( record )); then
        printf '%s\n' "$got" > "$want"
        recorded=$(( recorded + 1 ))
        return
    fi

    if [[ ! -f $want ]]; then
        printf 'MISSING %s: nothing recorded, run --record\n' "$name" >&2
        failed=$(( failed + 1 ))
        return
    fi

    if diff -q "$want" <(printf '%s\n' "$got") >/dev/null; then
        passed=$(( passed + 1 ))
    else
        printf 'FAIL %s\n' "$name" >&2
        diff -u --label "want/$name" --label "got/$name" "$want" <(printf '%s\n' "$got") | head -30 >&2
        failed=$(( failed + 1 ))
    fi
}

for file in "$cases"/*.txt; do
    name=$(basename "$file" .txt)
    check "production-$name" production "$file"
    check "parse-$name" parse "$file"
done

# Every modifier, and a check that all() and find() agree about each.
check "modifiers" modifiers

# Every game the engine carries, and what it makes of each one's rules.
check "games" games

# Goals: the forms the grammar accepts, and the ways it can be malformed.
goals=(
    'wood.production'
    'wood.production,iron.production'
    'soldiers.production.attack'
    'wood.production.market,iron.production.market'
    'wood.production:2,iron.production:0.5'
    'wood.production:0'
    ''
    'nonsense'
    'wood.production,wood.production'
    'wood.production:2,iron.production'
    'wood.production:x'
    'wood.production:-1'
    'workers.production.map'
)

for i in "${!goals[@]}"; do
    check "goals-$i" goals "${goals[$i]}"
done

# Effort: the same coverage.
efforts=(
    ''
    'restarts=8'
    'restarts=8,iterations=30000,improvementPasses=24,budget=1000000'
    'restarts=1,,improvementPasses=2'
    'restarts'
    'nonsense=1'
    'restarts=0'
    'restarts=-4'
    'restarts=x'
    'budget=3000000000'
)

for i in "${!efforts[@]}"; do
    check "effort-$i" effort "${efforts[$i]}"
done

# The search itself, with small limits so it stays quick and deterministic.
small='restarts=2,iterations=400,improvementPasses=6,budget=6000'
check "rearrange-full-wood" rearrange "$cases/full.txt" 'wood.production' "$small"
check "rearrange-full-blended" rearrange "$cases/full.txt" 'wood.production:2,soldiers.production:1' "$small"
check "rearrange-bare" rearrange "$cases/bare.txt" 'wood.production' "$small"
check "rearrange-modifiers" rearrange "$cases/full-modifiers.txt" 'soldiers.production.attack' "$small"

if (( record )); then
    printf 'recorded %d answers\n' "$recorded"
    exit 0
fi

# The page and the engine agree on the village text format, checked against
# the actual WebAssembly build. Skipped when there is none.
if [[ -f $root/build/site/engine.js ]] && command -v node >/dev/null; then
    if node "$root/tests/roundtrip.js" build/site; then
        passed=$(( passed + 1 ))
    else
        failed=$(( failed + 1 ))
    fi
else
    printf 'skipping the round-trip: no build/site/engine.js or no node\n'
fi

# Splitting the restarts across workers finds what one undivided run finds.
if command -v python3 >/dev/null; then
    if python3 "$root/tests/split.py"; then
        passed=$(( passed + 1 ))
    else
        failed=$(( failed + 1 ))
    fi
else
    printf 'skipping the split check: no python3\n'
fi

# The page starts up, both from empty storage and from whatever a previous
# visit stored. Needs jsdom, which this project does not depend on:
#   npm install --no-save jsdom
if [[ -f $root/build/site/engine.js ]] && command -v node >/dev/null \
    && NODE_PATH="$root/node_modules" node -e "require('jsdom')" 2>/dev/null; then
    if NODE_PATH="$root/node_modules" node "$root/tests/startup.js" build/site; then
        passed=$(( passed + 1 ))
    else
        failed=$(( failed + 1 ))
    fi
else
    printf 'skipping the startup checks: no jsdom (npm install --no-save jsdom)\n'
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
(( failed == 0 ))
