#!/usr/bin/env python3
"""Every key an effects reply can carry, gathered over whole rounds.

    FACTIONS_TOKEN=... tools/effects-shape.py [--from 48] [--to 168]

The api leaves a key out when a player has nothing under it: a village with no
shrine has no SHRINE row, a player who bought no perk has no row for the tree.
So no one reply shows what a reply can hold. This walks every player of every
round it is given and merges what it finds into one shape: which sections
exist, which figures sit under each, which sources feed each figure, and which
fields each source writes. Values are counted, never kept.

Writes the shape as json (--out) and prints it as a tree.

    tools/effects-shape.py --out shape.json --cache data/effects

--cache keeps one file per player, so a second run costs no requests. The
token is read from the environment and written nowhere.
"""

import argparse
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

API = 'https://api.factions-online.com/api'


def get(token, path):
    # The api turns down urllib's default user agent with a 403.
    request = urllib.request.Request(f'{API}/{path}', headers={
        'authorization': f'Bearer {token}',
        'user-agent': 'factions-solver/1.0',
        'accept': 'application/json',
    })
    with urllib.request.urlopen(request, timeout=30) as answer:
        return json.load(answer)


def maybe(token, path):
    """The reply, or None where the api will not give one."""
    try:
        return get(token, path)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        return None


class Shape:
    """What every reply seen so far, put together, is allowed to hold."""

    def __init__(self):
        # section -> figure -> {'fields', 'sources': source -> record}
        self.sections = {}
        self.replies = 0
        self.games = []

    def figure(self, section, name):
        return self.sections.setdefault(section, {}).setdefault(name, {'fields': set(), 'sources': {}})

    def source(self, section, figure, name):
        return self.figure(section, figure)['sources'].setdefault(name, {
            'fields': set(), 'seen': 0, 'where': None, 'nested': {},
        })

    def add(self, reply, where):
        """One player's reply, merged in. `where` is game/player, for a note."""
        if not isinstance(reply, dict):
            return
        self.replies += 1

        for section, figures in reply.items():
            if not isinstance(figures, dict):
                # A section that is not figure-shaped is still worth recording.
                self.sections.setdefault(section, {})
                continue
            for figure, body in figures.items():
                held = self.figure(section, figure)
                if not isinstance(body, dict):
                    continue
                held['fields'].update(k for k in body if k != 'details')

                for detail in body.get('details') or []:
                    if not isinstance(detail, dict):
                        continue
                    name = detail.get('from')
                    if not isinstance(name, str):
                        name = '<no from>'
                    record = self.source(section, figure, name)
                    record['seen'] += 1
                    record['fields'].update(k for k in detail if k != 'from')
                    if record['where'] is None:
                        record['where'] = where
                    # subfrom, the only field that holds a list of its own.
                    for part in detail.get('subfrom') or []:
                        if isinstance(part, dict):
                            record['nested'].setdefault('subfrom', set()).update(part)

    def asJson(self):
        return {
            'replies': self.replies,
            'games': self.games,
            'sections': {
                section: {
                    figure: {
                        'fields': sorted(body['fields']),
                        'sources': {
                            name: {
                                'fields': sorted(record['fields']),
                                'seen': record['seen'],
                                'firstSeen': record['where'],
                                **({'nested': {k: sorted(v) for k, v in record['nested'].items()}}
                                   if record['nested'] else {}),
                            }
                            for name, record in sorted(body['sources'].items())
                        },
                    }
                    for figure, body in sorted(figures.items())
                }
                for section, figures in sorted(self.sections.items())
            },
        }

    def astree(self):
        lines = []
        for section, figures in sorted(self.sections.items()):
            lines.append(section)
            for figure, body in sorted(figures.items()):
                held = ', '.join(sorted(body['fields'])) or 'no fields of its own'
                lines.append(f'  {figure}  [{held}]')
                for name, record in sorted(body['sources'].items()):
                    fields = ', '.join(sorted(record['fields']))
                    lines.append(f'      {name:<28} {fields:<44} x{record["seen"]}  first at {record["where"]}')
        return '\n'.join(lines)


def playersOf(token, game):
    """Everyone the api will show for a round, by id."""
    board = maybe(token, f'game/{game}/leaderboard')
    if not isinstance(board, list):
        return []
    return [(entry['playerId'], entry.get('name') or str(entry['playerId']))
            for entry in board if entry.get('playerId') is not None]


def effectsOf(token, game, player, cache):
    """One player's effects, from the cache where there is one."""
    kept = None if cache is None else cache / f'{game}-{player}.json'
    if kept is not None and kept.exists():
        return json.loads(kept.read_text())

    reply = maybe(token, f'game/{game}/hq/spectate/{player}/effects')
    if reply is not None and kept is not None:
        kept.write_text(json.dumps(reply))
    return reply


def main():
    parse = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parse.add_argument('--from', dest='first', type=int, default=48, help='lowest round to walk (default 48)')
    parse.add_argument('--to', dest='last', type=int, default=168, help='highest round to walk (default 168)')
    parse.add_argument('--players', type=int, default=0, help='stop after this many players per round (0: all)')
    parse.add_argument('--out', type=pathlib.Path, help='where to write the shape as json')
    parse.add_argument('--cache', type=pathlib.Path, help='directory to keep each reply in, so a rerun costs nothing')
    args = parse.parse_args()

    token = os.environ.get('FACTIONS_TOKEN', '').strip()
    if not token:
        raise SystemExit('set FACTIONS_TOKEN to a bearer token for api.factions-online.com')

    if args.cache is not None:
        args.cache.mkdir(parents=True, exist_ok=True)

    shape = Shape()
    for game in range(args.first, args.last + 1):
        players = playersOf(token, game)
        if not players:
            continue  # a round that never ran, or one this token cannot see

        read = 0
        for player, name in players:
            if args.players and read >= args.players:
                break
            reply = effectsOf(token, game, player, args.cache)
            if reply is None:
                continue
            shape.add(reply, f'{game}/{name}')
            read += 1
            time.sleep(0.03)  # a courtesy, not a requirement

        if read:
            shape.games.append(game)
            print(f'  {game:4} {read:3} of {len(players)} players', flush=True)

    if not shape.replies:
        raise SystemExit('no replies read; check the token')

    print(f'\n{shape.replies} replies over rounds {", ".join(str(g) for g in shape.games)}\n', flush=True)
    print(shape.astree())

    if args.out is not None:
        args.out.write_text(json.dumps(shape.asJson(), indent=1, sort_keys=True) + '\n')
        print(f'\nwritten to {args.out}', file=sys.stderr)


if __name__ == '__main__':
    main()
