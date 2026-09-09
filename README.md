# Factions solver

A layout planner and optimiser for [Factions](https://www.factions-online.com).


![](docs/screenshot.png)

## Building

Needs a C++23 compiler, CMake 4.1.2+, [cpp-httplib](https://github.com/yhirose/cpp-httplib),
[emsdk](https://emscripten.org) on `PATH`, and Python 3. `terser` and `node`
with `jsdom` are optional, for minification and the page tests.

```sh
FACTIONS_TOKEN=... tools/fetch-games.py
cmake -S . -B build && cmake --build build -j8
build/Server 8080        # then open http://localhost:8080
```
