#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$root/build/site}"

mkdir -p "$out"

# -flto optimises across the ten translation units at link rather than each
# on its own, which measured faster than -O3 alone and is what the timings in
# tools/tune.py and tools/wasm-bench.js were taken with.
# -DNDEBUG because this build is both what the page ships and what
# tools/wasm-bench.js times: asserts have no business in either. The checked
# build is HarnessChecked, native. See CMakeLists.
em++ -O3 -flto -DNDEBUG -std=c++23 -I "$root/src" -I "$(dirname "${GAMES_CPP:-$root/build/games.gen.cpp}")" -Wall -Wextra -pedantic -Werror \
    -o "$out/engine.js" \
    "$root/src/wasm.cpp" "$root/src/parse.cpp" "$root/src/json.cpp" "$root/src/game.cpp" "$root/src/solver.cpp" \
    "$root/src/simulate.cpp" \
    "$root/src/village.cpp" "$root/src/effects.cpp" "$root/src/cost.cpp" "${GAMES_CPP:-$root/build/games.gen.cpp}" \
    -s MODULARIZE=1 \
    -s EXPORT_NAME=createEngine \
    -s EXPORT_ES6=0 \
    -s ENVIRONMENT=web,worker,node \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=16MB \
    -s EXPORTED_FUNCTIONS='["_apiParse","_apiProduction","_apiRearrange","_apiSimulate","_apiFree","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","stringToNewUTF8"]' \
    --closure 0

# wasm.cpp is compiled here rather than by cmake, so cmake's
# compile_commands.json has no entry for it and clangd falls back to host
# flags: emscripten.h is then missing and every EMSCRIPTEN_KEEPALIVE reads as
# an unknown type. This records what em++ actually does with the file and
# merges that one entry in, so the editor sees it the way the compiler does.
# The flags come from whatever emsdk is in use, so nothing machine-specific is
# committed. -MJ keeps only the last input it is given, hence a pass of its
# own; -fsyntax-only makes that pass cheap.
cdb="$(dirname "$out")/compile_commands.json"
if [[ -f $cdb ]]; then
    em++ -std=c++23 -I "$root/src" -I "$(dirname "${GAMES_CPP:-$root/build/games.gen.cpp}")" \
        -fsyntax-only "$root/src/wasm.cpp" -MJ "$out/wasm.cdb.json"

    python3 - "$out/wasm.cdb.json" "$cdb" <<'EOF'
import json, pathlib, sys

fragment, database = (pathlib.Path(p) for p in sys.argv[1:3])

# -MJ writes one comma-terminated object per input, which is not yet an array.
entries = json.loads('[' + fragment.read_text().strip().rstrip(',') + ']')
wasm = [e for e in entries if e['file'].endswith('wasm.cpp')]
if not wasm:
    raise SystemExit(0)

kept = [e for e in json.loads(database.read_text()) if not e['file'].endswith('wasm.cpp')]
database.write_text(json.dumps(kept + wasm, indent=1))
EOF
fi
rm -f "$out/wasm.cdb.json"

printf '\n%s\n' "built:"
ls -l --time-style=+%H:%M:%S "$out/engine.js" "$out/engine.wasm"
