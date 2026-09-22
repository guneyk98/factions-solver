#!/usr/bin/env python3
"""Turns data/games/*.json into the C++ the engine compiles in.

The engine carries every game's rules rather than parsing json at runtime:
there is no json parser in here, the data is small, and generating it keeps
one description of a game rather than two.

    tools/games-to-cpp.py build/games.gen.cpp
"""

import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent.parent
GAMES = HERE / 'data' / 'games'

FIGURE = {
    ('production', 'wood'): 'Wood', ('storage', 'wood'): 'Wood',
    ('production', 'iron'): 'Iron', ('storage', 'iron'): 'Iron',
    ('production', 'workers'): 'Workers', ('storage', 'workers'): 'Workers',
    ('production', 'soldiers'): 'Soldiers', ('storage', 'soldiers'): 'Soldiers',
    ('production', 'knight'): 'Knight', ('storage', 'knight'): 'Knight',
    ('production', 'guardian'): 'Guardian', ('storage', 'guardian'): 'Guardian',
    ('production', 'market_order'): 'MarketOrder', ('storage', 'market_order'): 'MarketOrder',
    ('production', 'build_order'): 'BuildOrder', ('storage', 'build_order'): 'BuildOrder',
    ('world', 'attack'): 'Attack',
    ('world', 'defense'): 'Defense',
    ('world', 'knightPower'): 'KnightPower',
    ('world', 'guardianPower'): 'GuardianPower',
    ('world', 'map_efficiency'): 'MapEfficiency',
    ('world', 'worker_project_efficiency'): 'WorkerProjectEfficiency',
    ('buildings', 'market_tax'): 'MarketTax',
    ('buildings', 'recycling'): 'Recycling',
    ('points', 'specialization'): 'Specialization',
    ('efficiency', None): 'Efficiency',
    ('production', None): 'Efficiency',   # an aura over everything produced
    ('storage', None): 'Efficiency',      # and over everything held
}

# An aura with no subtype may still name a rate or a capacity. `efficiency`
# names neither, so it applies to both.
RATE_OR_CAPACITY = {'production': 'Rate', 'storage': 'Capacity', 'efficiency': 'Both'}

# The api's shape strings, to the engine's Shape enumerators.
SHAPE = {'1x1': 'Single', '1x2': 'Line', '2x1': 'Line', '2x2': 'Square', 'l': 'LShape'}

# games/list's status for a round still being played, the only kind whose
# players the page may query.
PLAYING = 'PLAYING'


def resources(cost):
    """A wood/iron/workers triple, as the Resources aggregate."""
    cost = cost or {}
    return ('Resources{' + ', '.join(repr(float(cost.get(r) or 0.0))
                                     for r in ('wood', 'iron', 'workers')) + '}')


def cost_of(building):
    """What this building's levels are costed from.

    `cost` is what putting one up takes. The api gives a handful of buildings
    a separate `upgradeCost`, which is the base every later level grows from
    instead; where it gives none, the build cost is that base too.
    """
    build = building.get('cost') or {}
    return (f'Cost{{{resources(build)}, {resources(building.get("upgradeCost") or build)}, '
            f'{building.get("workersStart") or 0}}}')


def quoted(text):
    return '"' + str(text).replace('\\', '\\\\').replace('"', '\\"') + '"'


class Strings:
    """Every list of names, pooled so the generated file stays small."""

    def __init__(self):
        self.lists = {}

    def add(self, names):
        names = tuple(names)
        if not names:
            return 'nothing'
        if names not in self.lists:
            self.lists[names] = f'names{len(self.lists)}'
        return self.lists[names]

    def emit(self, out):
        out.append('constexpr std::array<std::string_view, 0> nothing{};\n')
        for names, ident in self.lists.items():
            joined = ', '.join(quoted(n) for n in names)
            out.append(f'constexpr std::array<std::string_view, {len(names)}> {ident}{{{joined}}};')
        out.append('')


def effects_of(building, pool, dropped):
    """Every effect the api gives this building, in one flat list."""
    rows = []

    def add(where, e, on, by_category=False):
        typ, sub = e.get('type'), e.get('subtype')
        figure = FIGURE.get((typ, sub))
        if figure is None:
            dropped.append(f'{building["name"]}: {where} {typ}/{sub}')
            return

        for key, amount in (('base', 'Flat'), ('bonus', 'Share'), ('multiplier', 'Multiply')):
            if key in e:
                value = e[key]
                # A bonus is a percentage, and so is the tax; a multiplier is
                # the factor itself and a base is the figure as it stands.
                if amount == 'Share' or figure == 'MarketTax':
                    value = value / 100.0
                break
        else:
            dropped.append(f'{building["name"]}: {where} {typ}/{sub} with no figure')
            return

        rate_or_capacity = RATE_OR_CAPACITY.get(typ, 'Rate')

        # The api marks a woodcutter's forest bonus perLevel but not its base
        # 0.1 wood, which taken literally would mean a woodcutter on plains
        # produces the same at level 10 as at level 1. Verified in game: a
        # woodcutter's and a mine's base production does scale with level, so
        # every base effect is treated as per-level.
        per_level = bool(e.get('perLevel')) or where == 'Base'

        rows.append((where, amount, figure, rate_or_capacity, value,
                     per_level, bool(e.get('global')),
                     pool.add(on), by_category))

    for e in building.get('baseEffects') or []:
        add('Base', e, ())
    for terrain, lst in sorted((building.get('terrainBonus') or {}).items()):
        for e in lst:
            add('Terrain', e, (terrain,))
    for e in building.get('adjacencyEffects') or []:
        add('Adjacent', e, tuple(e.get('targets') or ([e['target']] if 'target' in e else ())))
    for e in building.get('providesAdjacency') or []:
        cats = e.get('categories')
        add('Provides', e,
            tuple(cats or e.get('targets') or ([e['target']] if 'target' in e else ())),
            by_category=bool(cats))
    return rows


def main():
    if len(sys.argv) != 2:
        raise SystemExit(f'usage: {sys.argv[0]} <output.cpp>')

    files = sorted((f for f in GAMES.glob('*.json') if f.name != 'index.json'),
                   key=lambda f: int(f.stem), reverse=True)
    if not files:
        raise SystemExit(f'no games in {GAMES}; run tools/fetch-games.py --rules')

    pool = Strings()
    dropped = []
    out = ['// Generated by tools/games-to-cpp.py from data/games/. Do not edit.',
           '#include "game.hpp"', '', '#include <array>', '', 'namespace Factions {', '', 'namespace Game {',
           'namespace {', '']
    pooled = []
    bodies = []
    # The two bounds effects.hpp sizes its arrays by, taken from the data
    # rather than guessed: see the header written beside the source below.
    most_effects = 0
    most_auras = 0

    for f in files:
        g = json.load(f.open())
        gid = g['id']
        if not g.get('terrain'):
            print(f'  {gid}: no terrain yet (not started), rules only, skipped from the compiled games', flush=True)
            continue
        flat = [t for row in g['terrain'] for t in row]
        terrain_ident = pool.add(flat)

        blds = []
        auras_here = 1  # the village centre provides one, and is in no game's list
        for b in sorted(g['buildings'], key=lambda b: b['name']):
            rows = effects_of(b, pool, dropped)
            ident = f'effects{gid}_{b["name"]}'
            lines = ',\n    '.join(
                f'Effect{{Where::{w}, Amount::{a}, Quantity::{fig}, RateOrCapacity::{m}, {v!r}, '
                f'{str(pl).lower()}, {str(gl).lower()}, {on}, {str(cat).lower()}}}'
                for w, a, fig, m, v, pl, gl, on, cat in rows)
            bodies.append(f'constexpr std::array<Effect, {len(rows)}> {ident}{{{{\n    {lines}\n}}}};'
                          if rows else f'constexpr std::array<Effect, 0> {ident}{{}};')
            most_effects = max(most_effects, len(rows))
            auras_here += sum(1 for row in rows if row[0] == 'Provides')

            shape = SHAPE.get(b.get('shape', '1x1').lower())
            if shape is None:
                raise SystemExit(f'{gid}: {b["name"]} has an unknown shape {b.get("shape")!r}')
            cats = b.get('category') or []
            blds.append(
                f'    Building{{{quoted(b["name"])}, {quoted(cats[0] if cats else "")}, '
                f'{b.get("hq", 0)}, {b.get("tiers", 0)}, Shape::{shape}, '
                f'{b.get("maxCount") or 0}, {str(bool(b.get("upgradeable"))).lower()}, '
                f'{str(bool(b.get("acceptModules"))).lower()}, '
                f'{pool.add(tuple(b.get("requiresAdjacentTerrain") or ()))}, '
                f'{cost_of(b)}, {ident}}}')

        bodies.append(f'constexpr std::array<Building, {len(blds)}> buildings{gid}{{{{\n'
                      + ',\n'.join(blds) + '\n}};')
        # The api writes the tax as a percentage; the engine works in shares.
        tax = float(g.get('marketTax') or 0.0) / 100.0
        cost = g.get('cost') or {}
        # Only a PLAYING round can be spectated. Anything else, including an
        # absent status, counts as finished, so a stale file offers nothing
        # rather than offering what the api will refuse.
        ongoing = str(g.get('status') or '').upper() == PLAYING
        # The seasons, and the index of the one the cost multipliers above
        # were fetched in. Game::seasonStep scales a cost from these two.
        seasons = g.get("seasons") or []
        if seasons:
            lines = ',\n    '.join(
                f'Season{{{quoted(one["type"])}, {quoted(one["start"])}, {quoted(one["end"])}}}'
                for one in seasons)
            bodies.append(f'constexpr std::array<Season, {len(seasons)}> seasons{gid}{{{{\n    {lines}\n}}}};')
            seasons_ident = f'seasons{gid}'
        else:
            seasons_ident = 'std::span<const Season>{}'
        season_now = g.get('seasonNow')
        season_now = season_now if isinstance(season_now, int) else -1

        most_auras = max(most_auras, auras_here)
        pooled.append(f'    Config{{{gid}, {quoted(g["map"])}, {str(ongoing).lower()}, {g["width"]}, {g["height"]}, {tax!r}, '
                      f'{resources(cost.get("building"))}, {resources(cost.get("village"))}, '
                      f'{resources(cost.get("villageBase"))}, {cost.get("villageWorkersStart") or 0}, '
                      f'{terrain_ident}, buildings{gid}, {seasons_ident}, {season_now}}}')

    pool.emit(out)
    out += bodies
    out.append('')
    out.append(f'constexpr std::array<Config, {len(pooled)}> games{{{{\n' + ',\n'.join(pooled) + '\n}};')
    out += ['', '} // namespace', '',
            'std::span<const Config> all() { return games; }', '',
            'const Config* find(int id)', '{',
            '    for (const Config& one : games)', '        if (one.id == id)',
            '            return &one;', '    return nullptr;', '}', '',
            '} // namespace Game', '', '} // namespace Factions']

    pathlib.Path(sys.argv[1]).write_text('\n'.join(out) + '\n')

    header = pathlib.Path(sys.argv[1]).with_suffix('.hpp')
    header.write_text('\n'.join([
        '// Generated by tools/games-to-cpp.py from data/games/. Do not edit.',
        '#pragma once',
        '',
        '#include <cstddef>',
        '',
        '/* The two bounds the effects interpreter sizes its per-building arrays by,',
        '   counted from the games compiled in rather than guessed. Regenerated with',
        '   the games themselves, so a round that adds an effect or an aura widens the',
        '   arrays instead of being silently truncated to fit them. */',
        'namespace Factions {',
        '',
        'namespace Game {',
        '',
        '// The most effects any one building has.',
        f'inline constexpr std::size_t MostEffectsPerBuilding = {most_effects};',
        '',
        '// The most auras any one game provides, the village centre included.',
        f'inline constexpr std::size_t MostAuras = {most_auras};',
        '',
        '} // namespace Game',
        '',
        '} // namespace Factions',
        '']))

    print(f'{len(pooled)} games -> {sys.argv[1]} ({most_effects} effects, {most_auras} auras at most)')
    if dropped:
        seen = sorted(set(dropped))
        print(f'{len(seen)} effect kinds this engine has no figure for:')
        for line in seen:
            print(f'  {line}')


if __name__ == '__main__':
    sys.exit(main())
