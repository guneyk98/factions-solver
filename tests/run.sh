#!/usr/bin/env bash

# Runs every case through the harness and diffs the output against the
# recorded answers in tests/expected. `--record` overwrites those answers
# instead of comparing against them, which is how they were first produced and
# how they are updated when a change is meant to move them.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The assert-enabled build: every check below runs with the engine's own
# invariants live. build/Harness is the same code without them, for the
# benchmarks. See CMakeLists.
harness="$root/build/HarnessChecked"
cases="$root/tests/cases"
scripts="$root/tests/scripts"
repros="$root/tests/repros"
expected="$root/tests/expected"

record=0
[[ ${1:-} == --record ]] && record=1

[[ -x $harness ]] || { echo "no build/HarnessChecked, run: cmake --build build" >&2; exit 1; }

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

# Every simulator run: the rules a tick applies, and the refusals it gives.
for file in "$scripts"/*.txt; do
    check "simulate-$(basename "$file" .txt)" simulate "$file"
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
    'wood.production=4200,iron.production=2800,workers.production=35'
    'wood.production=2,iron.production'
    'wood.production=1,iron.production:2'
    'wood.production=0,iron.production=0'
    'wood.storage>=4200,iron.storage>=2800'
    'wood.production:2>=10,iron.production:1'
    'wood.production=-1'
    'wood.production>=x'
    'wood.production>=-1'
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
    'terraform=4'
    'terraform=unlimited'
    'terraform=0'
    'terraform=-1'
    'terraform=some'
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

# The ratio rule, and a minimum the layout has to reach whatever it gives up.
check "rearrange-full-ratio" rearrange "$cases/full.txt" 'wood.production=2,iron.production=1' "$small"
check "rearrange-full-minimum" rearrange "$cases/full.txt" 'wood.production,iron.storage>=30000' "$small"
# A goal carrying no target takes part in one comparison only: the tie between
# two layouts the ratio cannot separate.
check "rearrange-full-ratio-untargeted" rearrange "$cases/full.txt" 'wood.production=2,iron.production=1,wood.storage=0' "$small"

# Every debug report: the one a page copies after a search, which has to
# repeat that search, so repro-search must answer as rearrange-full-ratio
# above does; and the ways a report can be malformed.
for file in "$repros"/*.txt; do
    name=$(basename "$file" .txt)
    check "repro-$name" repro "$file"
    # And the production of the layout the report says the search answered with.
    check "found-$name" found "$file"
done

# Terraforming: a counted budget the search must stay inside, and one bounded
# only by the arrangement.
check "rearrange-terraform-3" rearrange "$cases/full.txt" 'wood.production' "$small,terraform=3"
check "rearrange-terraform-unlimited" rearrange "$cases/full.txt" 'wood.production' "$small,terraform=unlimited"

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

# Both pages start up, from empty storage and from whatever a previous visit
# stored. Needs jsdom, which this project does not depend on:
#   npm install --no-save jsdom
if [[ -f $root/build/site/engine.js ]] && command -v node >/dev/null \
    && NODE_PATH="$root/node_modules" node -e "require('jsdom')" 2>/dev/null; then
    for page in startup simulator; do
        if NODE_PATH="$root/node_modules" node "$root/tests/$page.js" build/site; then
            passed=$(( passed + 1 ))
        else
            failed=$(( failed + 1 ))
        fi
    done

    # The report the page just wrote for its own search, read back by the
    # engine. Anything the engine refuses comes out as a line starting '!'.
    if [[ -f $root/build/debug-report.txt ]]; then
        refused=''
        for mode in repro found; do
            got=$("$harness" "$mode" "$root/build/debug-report.txt") || got="the harness would not run"
            [[ $got == '!'* ]] && refused="$mode: $got"
        done

        if [[ -z $refused ]]; then
            printf 'the debug report the page writes is one the engine reads back\n'
            passed=$(( passed + 1 ))
        else
            printf 'FAIL the page debug report: %s\n' "${refused:0:200}" >&2
            failed=$(( failed + 1 ))
        fi
    fi
else
    printf 'skipping the startup checks: no jsdom (npm install --no-save jsdom)\n'
fi

# The pointer itself: a drag, and a press that turns out to be a click. jsdom
# can reach neither, so this drives a real Chrome over the debugging protocol.
# Needs a browser and `ws`; skipped when either is missing.
chrome=$(command -v google-chrome || command -v chromium || true)
[[ -n $chrome ]] || chrome='/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'

if [[ -f $root/build/site/engine.js ]] && command -v node >/dev/null \
    && [[ -f $chrome ]] \
    && NODE_PATH="$root/node_modules" node -e "require('ws')" 2>/dev/null; then

    profile="$root/build/pointer-profile"
    rm -rf "$profile"
    mkdir -p "$profile"
    # A Windows chrome.exe cannot read a WSL path, and silently fails to start
    # if given one, so hand it the Windows spelling of the same directory.
    if [[ $chrome == *.exe ]] && command -v wslpath >/dev/null; then
        profile=$(wslpath -w "$profile")
    fi

    # A browser already on the port would be attached to instead of the one
    # started below, and the checks would be run against whatever it happens to
    # be showing. That has produced failures that reproduce nowhere else.
    if curl -s -m 1 -o /dev/null http://127.0.0.1:9223/json/version; then
        printf 'ERROR pointer: something is already listening on port 9223\n' >&2
        failed=$(( failed + 1 ))
        printf '\n%d passed, %d failed\n' "$passed" "$failed"
        exit 1
    fi

    "$root/build/Server" 8123 >/dev/null 2>&1 &
    server=$!
    "$chrome" --headless=new --disable-gpu --remote-debugging-port=9223 \
        --user-data-dir="$profile" --window-size=1800,1000 \
        "http://localhost:8123/simulator.html" >/dev/null 2>&1 &
    browser=$!

    # Waited for rather than slept through: a slow start would otherwise read
    # as a failure of the page.
    up=0
    for _ in $(seq 40); do
        if curl -s -m 1 -o /dev/null http://127.0.0.1:9223/json/version; then up=1; break; fi
        sleep 0.5
    done

    if (( up == 0 )); then
        printf 'ERROR pointer: the browser never opened its debugging port\n' >&2
        failed=$(( failed + 1 ))
    elif NODE_PATH="$root/node_modules" node "$root/tests/pointer.js" 9223; then
        passed=$(( passed + 1 ))
    else
        failed=$(( failed + 1 ))
    fi

    kill $browser $server 2>/dev/null
    wait $browser $server 2>/dev/null
else
    printf 'skipping the pointer checks: no chrome, node or ws\n'
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
(( failed == 0 ))
