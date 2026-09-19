#!/usr/bin/env python3
"""Writes the per-game building rules, village terrain and villages into data/.

The api wants a bearer token and sends no CORS headers, so the page cannot ask
it anything itself. This runs once at your shell and writes what the build
reads. data/ is not in version control, so a fresh checkout needs one run of
this before it can be built.

Nothing is fetched unless asked for, because the rules the api currently
returns are wrong in places and a run that refreshed them by default would
overwrite a corrected data/games with them again:

    tools/fetch-games.py --rules-from tmp/config     # rules off saved replies
    FACTIONS_TOKEN=... tools/fetch-games.py --rules  # rules off the api
    FACTIONS_TOKEN=... tools/fetch-games.py --players
    tools/fetch-games.py --index                     # index.json only

--rules-from reads the hq/config replies saved as <dir>/config-<game>.json and
writes the same files --rules would, without the network and without a token.
Whatever only hq/info and events/list carry (terrain, seasons) is kept from the
data/games file already there, since a saved config does not hold it.

The token is read from the environment and never written anywhere. Neither is
anything else the api returns about you: hq/info carries your faction, level
and ban status, and only grid.terrain is kept out of it.

Rules and terrain are pulled for every round; the villages people built are
pulled only for rounds that have finished, since an ongoing one's villages
change from one hour to the next. Each village carries the modifiers the api
reports over it, in the same trimmed shape the console script in web/app.js
produces, so the page reads both through modifiersFromEffects.
"""

import argparse
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

API = 'https://api.factions-online.com/api'
EARLIEST = 48
# event_type values that denote a season. Each season, the first included, multiplies every
# building and village cost multiplier by 0.99, so which season a round is in
# decides what anything costs to upgrade.
SEASONS = ('SPRING', 'SUMMER', 'FALL', 'AUTUMN', 'WINTER')
# games/list marks a round that has been played out. Only those get a file of
# villages: see the players loop at the bottom of main.
FINISHED = 'COMPLETED'
ROOT = pathlib.Path(__file__).parent.parent
HERE = ROOT / 'data' / 'games'
PLAYERS = ROOT / 'data' / 'players'

# What the solver reads, plus what an upgrade costs. Build times and the rest
# are dropped: they say nothing about what a village produces once it stands.
BUILDING_FIELDS = (
    'name', 'category', 'hq', 'tiers', 'shape', 'maxCount', 'unique',
    # cost is what putting one up takes; upgradeCost, where the api gives one,
    # is the base the level-to-level cost grows from instead. workersStart is
    # the level from which an upgrade also takes workers.
    'cost', 'upgradeCost', 'workersStart',
    # upgradeable is false for exactly the buildings that never leave level 1.
    'upgradeable', 'acceptModules', 'requires', 'requiresAdjacentTerrain',
    'baseEffects', 'terrainBonus', 'adjacencyEffects', 'providesAdjacency',
)


# Which sections and subtypes of an effects reply carry a modifier column: the
# same set EFFECT_COLUMNS names in web/app.js. Support power has no subtype of
# its own, since the api adds it into both knightPower and guardianPower.
EFFECT_SECTIONS = {
    'production': ('wood', 'iron', 'workers', 'soldiers', 'knight', 'guardian'),
    'storage': ('wood', 'iron', 'workers', 'soldiers'),
    'world': ('attack', 'defense', 'worker', 'map_efficiency', 'worker_project_efficiency',
              'knightPower', 'guardianPower'),
}
# The only keys of a detail that modifiersFromEffects reads, each with the
# value that leaves a figure where it was. Everything else the api sends about
# a detail is dropped, and so is a key already at its neutral value: the page
# reads a missing key as that value, and data/players is downloaded whole.
DETAIL_FIELDS = {'bonus': 0, 'base': 0, 'multiplier': 1, 'raw_value': 0}


def get(token, path):
    # The api turns down urllib's default user agent with a 403.
    request = urllib.request.Request(f'{API}/{path}', headers={
        'authorization': f'Bearer {token}',
        'user-agent': 'factions-solver/1.0',
        'accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as answer:
            return json.load(answer)
    except urllib.error.HTTPError as err:
        raise SystemExit(f'{path}: HTTP {err.code}') from None
    except urllib.error.URLError as err:
        raise SystemExit(f'{path}: {err.reason}') from None


def trim(building):
    kept = {k: building[k] for k in BUILDING_FIELDS if building.get(k) not in (None, [], {})}
    kept['name'] = building['name']  # always, even were it somehow falsy
    # Kept even when False, which is what marks a building capped at level 1.
    kept['upgradeable'] = bool(building.get('upgradeable'))
    return kept


def detail(one):
    """One detail of a figure, or {} where it moves the figure nowhere."""
    kept = {k: one[k] for k, neutral in DETAIL_FIELDS.items()
            if isinstance(one.get(k), (int, float)) and one[k] != neutral}
    return {'from': one['from'], **kept} if kept else {}


def effects(reply, on_grid):
    """The village-wide part of an effects reply, keyed section -> subtype.

    A detail whose `from` is the uppercase name of something standing on the
    grid (a building, or the hq) is dropped: the page computes what those give
    from the board itself, so keeping them here would count them twice.
    """
    kept = {}
    for section, subtypes in EFFECT_SECTIONS.items():
        for subtype in subtypes:
            details = ((reply.get(section) or {}).get(subtype) or {}).get('details') or []
            mine = [kept_detail for d in details
                    if isinstance(d, dict) and isinstance(d.get('from'), str)
                    and (d['from'] != d['from'].upper() or d['from'] not in on_grid)
                    and (kept_detail := detail(d))]
            if mine:
                kept.setdefault(section, {})[subtype] = {'details': mine}
    return kept


def village(entry, seen, over):
    """One player's village, as the page lays one out.

    The hq is not one of the buildings: it sits at its own place on the grid,
    and without it a village has no centre and the engine turns it down.
    """
    where = (seen.get('grid') or {}).get('hqPosition') or {}
    hq = seen.get('hq') or {}

    # Seals are modules the api lists separately, keyed to a building by id.
    # The engine stores them on the tile; module_type is already its seal id.
    seals = {m['installed_on']: m['module_type']
             for m in (seen.get('modules') or [])
             if m.get('installed_on') is not None and m.get('module_type')}

    one = {
        'hqX': where.get('x', hq.get('gridX')),
        'hqY': where.get('y', hq.get('gridY')),
        'id': entry['playerId'],
        'name': entry.get('name') or f"#{entry['playerId']}",
        'faction': entry.get('faction') or '',
        'level': (seen.get('hq') or {}).get('level') or 1,
        'terrain': [t for row in seen['grid']['terrain'] for t in row],
        'buildings': [
            {'name': b['name'], 'level': b.get('level') or 1,
             'x': b.get('gridX'), 'y': b.get('gridY'), 'rotation': b.get('rotation') or 0,
             'seal': seals.get(b.get('id'), 'NONE')}
            for b in (seen.get('buildings') or [])
            if b.get('gridX') is not None and b.get('gridY') is not None
        ],
    }
    # Left out for a player whose effects the api would not show, which the
    # page reads as "leave the modifiers already set alone". An empty dict is
    # a different answer: this player has none, so the page clears them.
    if over is not None:
        one['effects'] = over
    return one


def seasons_of(token, gid):
    """The round's seasons in order, and the index of the current one.

    The index comes from the api rather than from comparing clocks: exactly one
    season is started and not ended. It is returned as the season the page
    costs by default; hq/config's multipliers are the round's own, before any
    season.

    A finished round returns no events, which is why this is offered only for
    an ongoing round.
    """
    try:
        events = get(token, f'game/{gid}/events/list')
    except SystemExit:
        return [], -1

    if not isinstance(events, list):
        return [], -1

    turning = sorted((e for e in events if e.get('event_type') in SEASONS),
                     key=lambda e: e['start'])
    now = next((i for i, e in enumerate(turning)
                if e.get('started') and not e.get('ended')), -1)
    return [{'type': e['event_type'], 'start': e['start'], 'end': e['end']}
            for e in turning], now


def players_of(token, gid, on_grid):
    """Everyone who played a finished game, with the village they left behind.

    Two calls per player: the village itself, and the modifiers over it, which
    are what the page would otherwise have to be told by hand.
    """
    board = get(token, f'game/{gid}/leaderboard')
    out = []
    for entry in board:
        pid = entry.get('playerId')
        if pid is None:
            continue
        try:
            seen = get(token, f'game/{gid}/hq/spectate/{pid}/info')
        except SystemExit:
            continue  # a player the api will not show is simply left out
        if not (seen.get('grid') or {}).get('terrain'):
            continue
        # The village is worth keeping even where the modifiers over it are
        # not to be had, so a refusal here is not a refusal of the player.
        try:
            over = effects(get(token, f'game/{gid}/hq/spectate/{pid}/effects'), on_grid)
        except SystemExit:
            over = None
        out.append(village(entry, seen, over))
        time.sleep(0.05)  # a courtesy, not a requirement
    out.sort(key=lambda p: (-p['level'], p['name'].lower()))
    return out


def rules(gid, config, game, before):
    """The data/games file for one round.

    `game` is its games/list entry, `before` what data/games already holds for
    it. Everything hq/config does not carry (terrain, seasons, and the
    games/list columns) is taken from `game` where it is there and from
    `before` otherwise, so rebuilding rules off a saved config keeps it.
    """
    misc = config.get('misc') or {}
    params = misc.get('parameters') or {}
    mode = config.get('modeConfig') or {}
    hq_upgrade = misc.get('hqUpgrade') or {}

    one = {
        # What the market takes before a village haggles it down, as a
        # percentage. misc.marketTax, per game.
        'marketTax': misc.get('marketTax'),
        # Scales the world-map bonus near your hq, not anything on the
        # village grid. Carried so it is visible rather than assumed.
        'homeBonusMultiplier': params.get('home_bonus_multiplier'),
        'resourceMultiplier': mode.get('resource_multiplier'),
        'storageMultiplier': mode.get('storage_multiplier'),
        # What each level of a building, and of the village, costs.
        # A cost grows geometrically with the level it is paid at, and
        # each game rolls its own multiplier per resource; the arithmetic
        # is in src/cost.hpp.
        'cost': {
            'building': {
                'wood': params.get('building_wood_cost_multiplier'),
                'iron': params.get('building_iron_cost_multiplier'),
                'workers': params.get('building_worker_cost_multiplier'),
            },
            'village': {
                'wood': params.get('hq_wood_cost_multiplier'),
                'iron': params.get('hq_iron_cost_multiplier'),
                'workers': params.get('hq_worker_cost_multiplier'),
            },
            'villageBase': hq_upgrade.get('baseCost') or {},
            'villageWorkersStart': hq_upgrade.get('workersStart'),
        },
        'id': gid,
        'map': game.get('map') or before.get('map') or '',
        'type': game.get('type') or before.get('type') or '',
        # PLAYING, COMPLETED, and so on. Only PLAYING rounds may be
        # queried for their players; see tools/games-to-cpp.py.
        'status': game.get('status') or before.get('status') or '',
        'buildings': [trim(b) for b in config['buildings']],
    }
    for carried in ('seasons', 'seasonNow', 'width', 'height', 'terrain'):
        if carried in before:
            one[carried] = before[carried]
    return one


def written(gid):
    """What data/games already holds for a round, or {}."""
    path = HERE / f'{gid}.json'
    return json.loads(path.read_text()) if path.exists() else {}


def store(one):
    (HERE / f'{one["id"]}.json').write_text(json.dumps(one, indent=1, sort_keys=True) + '\n')
    if one.get('terrain'):
        print(f'  {one["id"]:4} {one["map"]:14} {one["width"]}x{one["height"]} '
              f'{len(one["buildings"])} buildings', flush=True)
    else:
        print(f'  {one["id"]:4} not started yet, rules only '
              f'({len(one["buildings"])} buildings), no terrain', flush=True)


def index():
    """Rewrites data/games/index.json off every rules file now written.

    A round without terrain has not started and is left out, as the page has
    nothing to draw for it.
    """
    HERE.mkdir(parents=True, exist_ok=True)
    listed = []
    for path in sorted(HERE.glob('*.json')):
        if path.name == 'index.json':
            continue
        one = json.loads(path.read_text())
        if one.get('terrain'):
            listed.append({'id': one['id'], 'map': one.get('map') or '',
                           'type': one.get('type') or ''})
    listed.sort(key=lambda g: g['id'], reverse=True)
    (HERE / 'index.json').write_text(json.dumps(listed, indent=1) + '\n')
    print(f'wrote {len(listed)} games into {HERE}')


def wanted(games, only):
    """The games/list entries asked for, newest first."""
    chosen = [g for g in games if g.get('id', 0) >= EARLIEST
              and (not only or g['id'] in only)]
    chosen.sort(key=lambda g: g['id'], reverse=True)
    return chosen


def fetch_rules(token, only):
    games = wanted(get(token, 'games/list'), only)
    print(f'{len(games)} games', flush=True)
    HERE.mkdir(parents=True, exist_ok=True)

    for game in games:
        gid = game['id']
        config = get(token, f'game/{gid}/hq/config')

        # hq/info carries the village grid, but only once the game has
        # started; before that it 403s. The rules are worth having early
        # (a new round's buildings can be pulled and compiled in before it
        # opens), so a game without one is not skipped, just left without
        # terrain and out of index.json until a later run finds it there.
        try:
            info = get(token, f'game/{gid}/hq/info')
        except SystemExit:
            info = {}

        one = rules(gid, config, game, written(gid))
        terrain = info.get('grid', {}).get('terrain')
        if terrain:
            one['width'] = len(terrain[0])
            one['height'] = len(terrain)
            one['terrain'] = terrain
        # Only an ongoing round has seasons; a finished one returns no events
        # and keeps the cost multipliers it ended on.
        one['seasons'], one['seasonNow'] = seasons_of(token, gid)
        store(one)


def saved_rules(where, only):
    """Rewrites the rules off hq/config replies saved as config-<game>.json."""
    found = {}
    for path in sorted(where.glob('config-*.json')):
        gid = int(re.fullmatch(r'config-(\d+)', path.stem).group(1))
        if not only or gid in only:
            found[gid] = path
    if not found:
        raise SystemExit(f'no config-<game>.json in {where}')

    print(f'{len(found)} games from {where}', flush=True)
    HERE.mkdir(parents=True, exist_ok=True)
    for gid in sorted(found, reverse=True):
        config = json.loads(found[gid].read_text())
        store(rules(gid, config, {}, written(gid)))


def fetch_players(token, only):
    # Finished games let anyone's village be looked at, so they are offered as
    # starting points. Kept apart from the rules: the page fetches these only
    # when asked rather than carrying all of them.
    #
    # A round still being played is left alone: its villages change under you,
    # so a file of them would be a snapshot of a moment rather than of how the
    # round was played, and the page says as much when it finds none.
    PLAYERS.mkdir(parents=True, exist_ok=True)
    for game in wanted(get(token, 'games/list'), only):
        gid = game['id']
        if game.get('status') != FINISHED:
            print(f'  {gid:4} still {(game.get("status") or "unknown").lower()}, '
                  'no villages written', flush=True)
            continue
        # What stands on this round's grid, for effects() to tell a
        # village-wide source from one the page computes off the board.
        on_grid = {b['name'] for b in written(gid).get('buildings', [])} | {'HQ'}
        found = players_of(token, gid, on_grid)
        (PLAYERS / f'{gid}.json').write_text(json.dumps(found, separators=(',', ':')) + '\n')
        print(f'  {gid:4} {len(found):3} villages', flush=True)


def token_of():
    token = os.environ.get('FACTIONS_TOKEN', '').strip()
    if not token:
        raise SystemExit('set FACTIONS_TOKEN to a bearer token for api.factions-online.com')
    return token


def main():
    parse = argparse.ArgumentParser(
        description='Writes game rules and villages into data/. Nothing is '
                    'fetched unless asked for.')
    parse.add_argument('--rules', action='store_true',
                       help='fetch each round\'s building rules and terrain into data/games')
    parse.add_argument('--rules-from', metavar='DIR', type=pathlib.Path,
                       help='rewrite the rules off hq/config replies saved as '
                            'DIR/config-<game>.json, without the api')
    parse.add_argument('--players', action='store_true',
                       help='fetch the villages of finished rounds into data/players')
    parse.add_argument('--index', action='store_true',
                       help='rewrite data/games/index.json off the rules already written')
    parse.add_argument('--game', metavar='ID', type=int, action='append', dest='games',
                       help='act on this round only; repeat for several '
                            '(default: every round from {EARLIEST} up)'.format(EARLIEST=EARLIEST))
    args = parse.parse_args()

    if not (args.rules or args.rules_from or args.players or args.index):
        parse.error('nothing to do: pass --rules, --rules-from, --players or --index')
    if args.rules and args.rules_from:
        parse.error('--rules and --rules-from both write data/games; pass one')

    only = set(args.games or ())

    if args.rules:
        fetch_rules(token_of(), only)
    if args.rules_from:
        saved_rules(args.rules_from, only)
    if args.rules or args.rules_from or args.index:
        index()
    if args.players:
        fetch_players(token_of(), only)


if __name__ == '__main__':
    sys.exit(main())
