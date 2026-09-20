'use strict';

/* Starts the real page the way a browser does and checks that it comes up.

   This exists because a page that works from a clean slate and breaks on the
   next visit is the easiest kind of fault to ship: every check that starts
   from nothing passes. So each case here seeds storage first, and the page has
   to survive what the last session left behind, including rubbish.

   Needs jsdom, which this project does not depend on. Run it with jsdom on
   NODE_PATH, or skip it: tests/run.sh does the latter.
*/

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const site = path.join(root, process.argv[2] ?? 'build/site');

const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
// Real script tags share one global lexical scope; jsdom's eval does not, so
// the page's scripts go in together, in load order, the way the browser sees
// them.
const bundle = ['schema.js', 'common.js', 'app.js'].map((f) => fs.readFileSync(path.join(site, f), 'utf8')).join('\n');
const createEngine = require(path.join(site, 'engine.js'));

// The engine's own description of what each building does, to check the page
// lists all of it rather than only the parts that happen to be doing something.
// eslint-disable-next-line no-eval
const SCHEMA = eval(`${fs.readFileSync(path.join(site, 'schema.js'), 'utf8').replace('const SCHEMA', 'var SCHEMA')}; SCHEMA`);

const trouble = [];
function complain(where, what) {
  trouble.push(`${where}: ${what}`);
}

/* Whether a real player's buildings, read back at their saved positions and
   rotations, still fit the board under this game's current shapes: no
   overlaps and nothing off the edge. A village saved under an older shape can
   fail this once the game changes one, which is not a fault of the page or
   this test, just of picking that particular saved village to load. */
function fitsTheBoard(gameId, buildings) {
  const shapeByBuilding = new Map(SCHEMA.games.find((g) => g.id === gameId).shapes.map((s) => [s.building, s.shape]));
  const occupied = new Set();
  for (const b of buildings) {
    const shape = shapeByBuilding.get(b.name) ?? 'single';
    const orient = ['e', 's', 'w', 'n'][(b.rotation || 0) % 4];
    const arms = shape === 'single' ? [[0, 0]]
      : shape === 'line' ? [[0, 0], orient === 's' ? [0, 1] : [1, 0]]
      : shape === 'square' ? [[0, 0], [1, 0], [0, 1], [1, 1]]
      : [[0, 0], ...({ e: [[1, 0], [0, 1]], s: [[0, 1], [-1, 0]], w: [[-1, 0], [0, -1]], n: [[0, -1], [1, 0]] }[orient])];
    for (const [dx, dy] of arms) {
      const x = b.x + dx, y = b.y + dy;
      if (x < 0 || x >= 10 || y < 0 || y >= 10) return false;
      const key = `${x},${y}`;
      if (occupied.has(key)) return false;
      occupied.add(key);
    }
  }
  return true;
}

// `withEngine` false withholds the WebAssembly, as a browser that cannot run
// it would. `after` runs once the page has settled.
async function boot(seed, { withEngine = true, after = null, waitMs = 400, until = null, serve = null } = {}) {
  // jsdom cannot navigate, so the reload after clearing storage is expected
  // to be refused; everything else it says is a real fault.
  const console_ = new VirtualConsole();
  const noise = [];
  console_.on('jsdomError', (err) => {
    if (!/Not implemented: navigation/.test(err.message)) noise.push(err.message);
  });

  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole: console_,
  });
  const w = dom.window;

  for (const [key, value] of Object.entries(seed.local ?? {})) w.localStorage.setItem(key, value);
  for (const [key, value] of Object.entries(seed.session ?? {})) w.sessionStorage.setItem(key, value);

  if (withEngine) {
    const engine = await createEngine();
    w.createEngine = () => Promise.resolve(engine);
  }

  // Nothing should reach the server unasked; `serve` answers what may.
  let fetched = 0;
  w.fetch = (...args) => {
    fetched += 1;
    const body = serve === null ? null : serve(String(args[0]));
    if (body === null || body === undefined) {
      return Promise.reject(new Error(`the page called the server: ${args[0]}`));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(body)) });
  };

  const errors = noise;
  w.addEventListener('error', (e) => errors.push(e.message));
  const onRejection = (reason) => errors.push(`unhandled rejection: ${reason}`);
  process.on('unhandledRejection', onRejection);

  let threw = null;
  try {
    w.eval(bundle);
  } catch (err) {
    threw = String(err.message || err);
  }

  // Long enough for the engine to attach and the layout to be laid out.
  await new Promise((resolve) => { setTimeout(resolve, 1500); });

  if (after !== null) {
    try { after(w); } catch (err) { errors.push(`after startup: ${err.message}`); }

    // Wait for what `after` set off, rather than for a fixed guess at it.
    const deadline = Date.now() + waitMs;
    do {
      await new Promise((resolve) => { setTimeout(resolve, until === null ? waitMs : 100); });
    } while (until !== null && !until(w) && Date.now() < deadline);
  }

  process.off('unhandledRejection', onRejection);

  const read = (id) => (w.document.getElementById(id)?.textContent ?? '').trim();
  const tiles = [...w.document.querySelectorAll('.tile')];

  const kept = { local: {}, session: {} };
  for (let i = 0; i < w.localStorage.length; i += 1) {
    const key = w.localStorage.key(i);
    kept.local[key] = w.localStorage.getItem(key);
  }
  for (let i = 0; i < w.sessionStorage.length; i += 1) {
    const key = w.sessionStorage.key(i);
    kept.session[key] = w.sessionStorage.getItem(key);
  }

  return {
    threw,
    errors,
    fetched,
    note: read('engine-note'),
    said: w.document.getElementById('player-select')?.dataset.said ?? '',
    level: (w.document.getElementById('village-level')?.value ?? '').trim(),
    // One picture per building, drawn on the tile it stands on.
    // .art is the building; a tile also carries a .seal image, which is not
    // one and would otherwise count as another building on the same tile.
    buildings: [...w.document.querySelectorAll('.tile img.art')].filter((i) => !i.hidden).length,
    stranded: w.document.querySelectorAll('.tile.stranded').length,
    // Each tile's title opens with the name of the terrain under it.
    terrains: tiles.map((el) => el.title.split(',')[0]),
    steppedBack: w.document.body.dataset.steppedBack ?? '',
    solved: read('solve-result'),
    goals: [...w.document.querySelectorAll('.goal')].map((one) => one.dataset.goal),
    modifiers: Object.fromEntries([...w.document.querySelectorAll('[data-mod]')].map((i) => [i.dataset.mod, i.value])),
    script: w.document.getElementById('pull-script')?.value ?? '',
    yours: w.document.body.dataset.yours ?? '',
    seals: w.document.body.dataset.seals ?? '',
    chosen: w.document.body.dataset.chosen ?? '',
    tiles: tiles.length,
    painted: tiles.filter((t) => t.style.backgroundColor).length,
    totals: {
      wood: read('total-wood'), iron: read('total-iron'), workers: read('total-workers'), soldiers: read('total-soldiers'),
    },
    kept,
  };
}

/* One mode's script, read out of the panel while it is open. The panel is put
   back the way it was found, since the caller is looking at it too. */
function fetchScriptOf(w, mode) {
  const who = w.document.getElementById('pull-who');
  const was = who.value;
  who.value = mode;
  who.dispatchEvent(new w.Event('change'));
  const text = w.document.getElementById('pull-script').value;
  who.value = was;
  who.dispatchEvent(new w.Event('change'));
  return text;
}

function sound(where, page) {
  if (page.threw) return complain(where, `the page threw on startup: ${page.threw}`);
  if (page.errors.length) return complain(where, `errors on startup: ${page.errors.join(' | ')}`);
  if (page.tiles !== 100) return complain(where, `${page.tiles} tiles, expected 100`);
  if (page.painted !== 100) return complain(where, `only ${page.painted} of 100 tiles were painted`);
  return true;
}

async function main() {
  // 1. A clean slate, which is the case that always passed.
  const first = await boot({});
  sound('clean slate', first);
  if (Object.keys(first.kept.local).length === 0) complain('clean slate', 'nothing was saved for next time');

  // 2. The same storage again: the visit after the first is what breaks.
  const second = await boot(first.kept);
  sound('storage from the last visit', second);
  for (const [name, value] of Object.entries(first.totals)) {
    if (second.totals[name] !== value) {
      complain('storage from the last visit', `${name} came back as '${second.totals[name]}', not '${value}'`);
    }
  }

  /* 3. A saved village that is not the one the page starts with, so that a
        page which quietly ignores what was saved is caught as well. */
  const body = fs.readFileSync(path.join(root, 'tests/cases/full.txt'), 'utf8').trim();
  const third = await boot({ local: { 'factions-solver/v2': JSON.stringify({ v: 1, layout: body }) } });
  sound('a saved village', third);
  if (third.totals.wood === first.totals.wood) {
    complain('a saved village', `wood is still '${third.totals.wood}', so the saved layout was never laid out`);
  }

  /* 4. Rubbish in storage must not stop the page coming up. Some of these need
        a round with seasons and one without. */
  const ongoing = (SCHEMA.games.find((g) => g.seasons.length > 0) ?? SCHEMA.games[0]).id;
  const finished = (SCHEMA.games.find((g) => g.seasons.length === 0) ?? SCHEMA.games[0]).id;

  for (const [name, seed] of [
    ['not json', { local: { 'factions-solver/v2': '{{{' } }],
    ['the wrong shape', { local: { 'factions-solver/v2': JSON.stringify({ v: 1, layout: 42 }) } }],
    ['a layout the engine refuses', { local: { 'factions-solver/v2': JSON.stringify({ v: 1, layout: 'P:hut:1 and nothing else' }) } }],
    ['an undo history of nonsense', { session: { 'factions-solver/v1/undo-history': '[]' } }],
    /* A pinned season. A page following the clock saves `season: null`, and
       the check that reads one back short-circuits before touching the
       season list, so only a visit that pinned one reaches that path. */
    ['a pinned season', { local: { 'factions-solver/view/v1': JSON.stringify({ v: 1, game: ongoing, season: 1 }) } }],
    ['a season pinned past the last season', { local: { 'factions-solver/view/v1': JSON.stringify({ v: 1, game: ongoing, season: 99 }) } }],
    ['a season pinned in a round with none', { local: { 'factions-solver/view/v1': JSON.stringify({ v: 1, game: finished, season: 1 }) } }],
  ]) {
    sound(`storage holding ${name}`, await boot(seed));
  }

  // 5. Nothing is ever asked of the server.
  for (const [name, page] of [['clean slate', first], ['a saved village', third]]) {
    if (page.fetched !== 0) complain(name, `called the server ${page.fetched} times`);
  }

  // 6. No engine: the page has to say so rather than hang or call out.
  const stranded = await boot({}, { withEngine: false });
  sound('a browser that cannot run the engine', stranded);
  if (stranded.fetched !== 0) complain('a browser that cannot run the engine', 'called the server anyway');
  if (!/engine/i.test(stranded.note)) {
    complain('a browser that cannot run the engine', `says "${stranded.note}", which does not explain why`);
  }

  /* 7. Clearing saved data is the only way out of a village the engine will
        not read, so it has to actually empty both stores. */
  const cleared = await boot(first.kept, {
    after: (w) => w.document.getElementById('clear-storage').click(),
  });
  sound('clearing saved data', cleared);
  const left = [...Object.keys(cleared.kept.local), ...Object.keys(cleared.kept.session)];
  if (left.length !== 0) complain('clearing saved data', `left ${left.join(', ')} behind`);

  /* 8. Saved layouts: name one, find it in the list after a reload, load it
        back, and delete it. Driven through the page's own buttons. */
  const full = fs.readFileSync(path.join(root, 'tests/cases/full.txt'), 'utf8').trim();

  const named = await boot({ local: { 'factions-solver/v2': JSON.stringify({ v: 1, layout: full }) } }, {
    after: (w) => {
      w.document.getElementById('saves-open').click();
      w.document.getElementById('save-name').value = 'a big one';
      w.document.getElementById('save-form').dispatchEvent(new w.Event('submit'));
    },
  });
  sound('saving a layout', named);

  const kept = JSON.parse(named.kept.local['factions-solver/v1/saves'] ?? 'null');
  if (!Array.isArray(kept) || kept.length !== 1 || kept[0].name !== 'a big one') {
    complain('saving a layout', `stored ${JSON.stringify(kept)}`);
  }

  // The save survives a reload and puts its village back on the board.
  const back = await boot({ local: { 'factions-solver/v1/saves': named.kept.local['factions-solver/v1/saves'] } }, {
    after: (w) => {
      w.document.getElementById('saves-open').click();
      const rows = w.document.querySelectorAll('#save-list .save-row');
      if (rows.length !== 1) throw new Error(`${rows.length} rows listed, expected 1`);
      if (!rows[0].textContent.includes('a big one')) throw new Error('the row is not named');
      rows[0].querySelector('button').click(); // Load
    },
  });
  sound('loading a saved layout', back);
  if (back.totals.wood !== third.totals.wood) {
    complain('loading a saved layout', `wood is '${back.totals.wood}', expected '${third.totals.wood}'`);
  }

  // Deleting takes two clicks, so one must leave it alone.
  const clicks = (w, n) => {
    w.document.getElementById('saves-open').click();
    const drop = w.document.querySelector('#save-list .save-drop');
    for (let i = 0; i < n; i += 1) drop.click();
  };

  const once = await boot({ local: { 'factions-solver/v1/saves': named.kept.local['factions-solver/v1/saves'] } },
    { after: (w) => clicks(w, 1) });
  if (!once.kept.local['factions-solver/v1/saves']?.includes('a big one')) {
    complain('deleting a saved layout', 'one click was enough to delete it');
  }

  const twice = await boot({ local: { 'factions-solver/v1/saves': named.kept.local['factions-solver/v1/saves'] } },
    { after: (w) => clicks(w, 2) });
  if (JSON.parse(twice.kept.local['factions-solver/v1/saves'] ?? '[]').length !== 0) {
    complain('deleting a saved layout', 'two clicks did not delete it');
  }

  /* 9. Every effect a building has is listed on the tile, including the ones
        not doing anything there, which is how you find out what it wants. */
  const hover = (w, index) => {
    const el = w.document.querySelectorAll('.tile')[index];
    w.document.elementFromPoint = () => el; // jsdom has no layout
    w.document.getElementById('grid').dispatchEvent(
      new w.MouseEvent('pointermove', { bubbles: true, clientX: index + 1, clientY: 1 }));
  };

  /* A building standing on one of the several grounds it cares about, so that
     both a block in force and a block out of it are on show. */
  const inspected = 5 * 10 + 7;
  const listed = [];
  const grounds = [];
  const effects = await boot({ local: { 'factions-solver/v2': JSON.stringify({ v: 1, layout: full }) } }, {
    after: (w) => {
      hover(w, inspected);
      // Its own effects, not the auras the board casts on it or what it comes to.
      const own = '.fx-list.fx-base li, .fx-list.fx-terrain li, .fx-list.fx-adj li, .fx-list.fx-gives li';
      for (const li of w.document.querySelectorAll(own)) listed.push(li.textContent);
      for (const h of w.document.querySelectorAll('.fx-head.fx-terrain')) {
        // A block not in force is marked as well as greyed.
        grounds.push({ marked: h.textContent.startsWith('\u2717'), live: !h.classList.contains('fx-dim') });
      }
    },
  });
  sound('listing what a building does', effects);

  const [standing, on] = full.split(/\s+/)[1 + inspected].split(':');
  const want = SCHEMA.games[0].effects.filter((e) => e.building === on).length;
  if (listed.length !== want) {
    complain('listing what a building does', `${listed.length} lines for a ${on}, the game describes ${want}`);
  }

  /* One block per ground the building cares about, the ground it stands on in
     force and the rest greyed. Which grounds those are is drawn afresh for
     every round of the game, so the test reads them from the game rather than
     naming any. */
  const cares = new Set(SCHEMA.games[0].effects
    .filter((e) => e.building === on && e.where === 'terrain')
    .flatMap((e) => e.on));
  if (grounds.length !== cares.size) {
    complain('listing what a building does', `${grounds.length} ground blocks for a ${on}, the game gives it ${cares.size}`);
  }

  const inForce = grounds.filter((one) => one.live).length;
  const holds = cares.has(standing) ? 1 : 0;
  if (inForce !== holds) {
    complain('listing what a building does', `${inForce} ground blocks in force on ${standing}, where ${holds} should be`);
  }
  if (grounds.some((one) => one.live === one.marked)) {
    complain('listing what a building does', 'a ground block is greyed without the mark, or marked while in force');
  }

  /* 9. A search reports what it did and how long it took. jsdom has no Worker,
        so this runs the single-threaded fallback inside search(). */
  const searched = await boot({}, {
    waitMs: 30000,
    until: (w) => w.document.getElementById('solve-result').hidden === false,
    after: (w) => {
      w.document.getElementById('view-solve').click();
      w.document.getElementById('solve').click();
    },
  });
  sound('running a search', searched);
  if (!/layouts tried in \d/.test(searched.solved)) {
    complain('running a search', `reported "${searched.solved}", with no count and time`);
  }
  if (!/ in \d[\d.,]* ?(ms|s)\./.test(searched.solved)) {
    complain('running a search', `the time is not readable in "${searched.solved}"`);
  }

  /* 9b. The same search, allowed to terraform: it reports the tiles it changed
         and the board comes back holding that terrain. */
  const terraformed = await boot({ local: { 'factions-solver/v2': JSON.stringify({ v: 1, layout: body }) } }, {
    waitMs: 30000,
    until: (w) => w.document.getElementById('solve-result').hidden === false,
    after: (w) => {
      w.document.getElementById('view-solve').click();
      const allowed = w.document.getElementById('terraform-allowed');
      allowed.checked = true;
      allowed.dispatchEvent(new w.Event('change'));
      w.document.getElementById('solve').click();
    },
  });
  sound('a search that may terraform', terraformed);
  if (!/tiles? terraformed/.test(terraformed.solved)) {
    complain('a search that may terraform', `reported "${terraformed.solved}", which names no terraformed tile`);
  }

  // `third` is the same village laid out without a search, so its tiles carry
  // the map's own terrain.
  if (terraformed.terrains.join() === third.terrains.join()) {
    complain('a search that may terraform', 'the board holds the map\'s own terrain, so the terrain it found never reached the board');
  }

  /* 10. The village and the controls are kept apart on purpose: a setting can
         change what it means and have to be thrown away, and that must not be
         able to take somebody's village with it. */
  const settled = await boot({});
  const villageKey = 'factions-solver/v2';
  const viewKey = 'factions-solver/view/v1';

  if (!settled.kept.local[villageKey] || !settled.kept.local[viewKey]) {
    complain('keeping the village apart from the controls',
      `expected both keys, got ${Object.keys(settled.kept.local).join(', ')}`);
  }

  // Drop the controls, as bumping their version would. The village must stay.
  const survivor = await boot({ local: { [villageKey]: settled.kept.local[villageKey] } });
  sound('the controls thrown away', survivor);
  for (const [name, value] of Object.entries(settled.totals)) {
    if (survivor.totals[name] !== value) {
      complain('the controls thrown away',
        `${name} became '${survivor.totals[name]}', not '${value}': the village went with them`);
    }
  }

  // And the reverse: controls alone must not stop the page coming up.
  sound('the village thrown away', await boot({ local: { [viewKey]: settled.kept.local[viewKey] } }));

  /* 11. Picking a game lays that game's ground out, and takes off anything
          with nowhere left to stand. */
  const games = SCHEMA.games.map((g) => g.id);
  const switched = await boot({}, {
    after: (w) => {
      const sel = w.document.getElementById('game-select');
      sel.value = String(games[games.length - 1]);
      sel.dispatchEvent(new w.Event('change'));
    },
  });
  sound('picking another game', switched);

  if (switched.kept.local['factions-solver/view/v1'] === undefined) {
    complain('picking another game', 'the choice was not remembered');
  } else if (JSON.parse(switched.kept.local['factions-solver/view/v1']).game !== games[games.length - 1]) {
    complain('picking another game', 'the choice was remembered as a different game');
  }

  // The village that comes back must sit on the ground of the game chosen.
  const reopened = await boot({ local: { 'factions-solver/view/v1': switched.kept.local['factions-solver/view/v1'] } });
  sound('reopening on the chosen game', reopened);
  if (reopened.totals.wood !== switched.totals.wood) {
    complain('reopening on the chosen game',
      `wood came back as '${reopened.totals.wood}', not '${switched.totals.wood}'`);
  }

  /* 12. Somebody else's village: the list is only asked for when the menu is
          opened, and loading one lays out their ground and their buildings.

          A round still being played has no villages recorded for it (see
          tools/fetch-games.py), so this takes the newest round that has. */
  const game = games.find((id) => fs.existsSync(path.join(site, 'players', `${id}.json`)));
  if (game === undefined) {
    throw new Error(`no players/<game>.json under ${site}; run tools/fetch-games.py --players`);
  }
  const villages = JSON.parse(fs.readFileSync(path.join(site, 'players', `${game}.json`), 'utf8'))
    // A village saved before a shape changed can no longer fit; picking one
    // that still does keeps this test about the loading mechanism, not about
    // whether any one saved village happens to still be buildable.
    .filter((one) => one.buildings.length > 0 && fitsTheBoard(game, one.buildings));
  const served = (url) => (url.endsWith(`players/${game}.json`) ? JSON.stringify(villages) : null);

  const mine = villages[0];
  const loaded = await boot({}, {
    serve: served,
    waitMs: 3000,
    until: (w) => w.document.getElementById('player-select').options.length > 1
      && w.document.getElementById('player-select').dataset.picked === 'yes',
    after: (w) => {
      // The page opens on the newest round; the villages are on another one
      // when that round is still being played.
      const picker = w.document.getElementById('game-select');
      picker.value = String(game);
      picker.dispatchEvent(new w.Event('change'));

      const sel = w.document.getElementById('player-select');
      if (sel.options.length !== 1) complain("somebody else's village", 'the list was filled before it was opened');
      sel.dispatchEvent(new w.Event('focus'));

      // Pick as soon as the list arrives, rather than guessing how long it takes.
      const waiting = w.setInterval(() => {
        if (sel.options.length <= 1) return;
        w.clearInterval(waiting);
        sel.value = String(mine.id);
        sel.dispatchEvent(new w.Event('change'));
        // The page clears what it says after a few seconds; keep it.
        sel.dataset.said = w.document.getElementById('status').textContent.trim();
        sel.dataset.picked = 'yes';
      }, 50);
    },
  });
  sound("somebody else's village", loaded);

  if (loaded.fetched !== 1) {
    complain("somebody else's village", `${loaded.fetched} calls to the server, expected 1`);
  }
  /* A recorded village carries the modifiers the api reported over it, which
     the page applies alongside the board and says so after the village
     (see usePlayer). One recorded before those were pulled has none. */
  const bonuses = mine.effects === undefined ? '' : ' ';
  if (!loaded.said.startsWith(`${mine.name}'s village, hq ${mine.level}.${bonuses}`)) {
    complain("somebody else's village", `the page said '${loaded.said}'`);
  }
  if (mine.effects !== undefined && !/(No modifiers\.|modifiers?, .* politics\.)/.test(loaded.said)) {
    complain("somebody else's village", `no modifiers were applied with it: '${loaded.said}'`);
  }
  if (loaded.level !== String(mine.level)) {
    complain("somebody else's village", `village level ${loaded.level}, expected ${mine.level}`);
  }
  // Their buildings, and the hq that is not one of them.
  if (loaded.buildings !== mine.buildings.length + 1) {
    complain("somebody else's village",
      `${loaded.buildings} buildings on the board, expected ${mine.buildings.length} and the centre`);
  }

  /* 13. Picking a game changes the arithmetic, not only the ground. The same
          board is put back under each one (a saved layout carries its own
          terrain) so anything that moves moved because the rules did. */
  const saved = named.kept.local['factions-solver/v1/saves'];
  const byGame = new Map();

  for (const id of games) {
    // eslint-disable-next-line no-await-in-loop
    const on = await boot({ local: { 'factions-solver/v1/saves': saved } }, {
      after: (w) => {
        const sel = w.document.getElementById('game-select');
        sel.value = String(id);
        sel.dispatchEvent(new w.Event('change'));

        w.document.getElementById('saves-open').click();
        w.document.querySelector('#save-list .save-row button').click();
      },
    });
    sound(`the rules of game ${id}`, on);
    byGame.set(id, `${on.totals.wood}/${on.totals.iron}/${on.totals.workers}`);
  }

  if (new Set(byGame.values()).size < 2) {
    complain('the rules of each game',
      `one board came to ${[...byGame.values()][0]} under every game, so the rules are not being read`);
  }

  /* 14. A round whose map has different ground under the same village leaves
          every building where it is, marks whatever can no longer stand there,
          and reports no figure at all until it is moved. */
  const seeded = { local: { 'factions-solver/v2': JSON.stringify({ v: 1, layout: full }) } };
  const before = await boot(seeded);
  const moved = await boot(seeded, {
    after: (w) => {
      const sel = w.document.getElementById('game-select');
      sel.value = String(games[games.length - 1]); // the oldest round, another map
      sel.dispatchEvent(new w.Event('change'));
    },
  });
  sound('a round with different ground', moved);

  if (moved.buildings !== before.buildings) {
    complain('a round with different ground',
      `${moved.buildings} buildings left of ${before.buildings}: they should all stay`);
  }
  if (moved.stranded === 0) {
    complain('a round with different ground', 'nothing was marked as standing where it cannot');
  }
  if (moved.totals.wood !== 'N/A') {
    complain('a round with different ground', `wood reads '${moved.totals.wood}', expected N/A`);
  }

  /* 16. The goal order is dragged, so a drag has to reach the order the search
          is asked for and the order kept for next time. jsdom lays nothing
          out, so the rows are given the height a drag is measured against. */
  const dragged = await boot({}, {
    after: (w) => {
      const list = w.document.getElementById('goal-list');
      let top = 0;
      for (const row of list.children) {
        const y = top;
        top += 29; // a row and the gap under it
        row.getBoundingClientRect = () => ({ top: y, bottom: y + 26, height: 26, left: 0, right: 100, width: 100 });
      }

      const pointer = (type, clientY) => {
        // jsdom has no PointerEvent; the page reads only these fields.
        const event = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        return event;
      };

      // The last goal, dragged to the top.
      const last = list.children[list.children.length - 1];
      const from = (list.children.length - 1) * 29;
      last.dispatchEvent(pointer('pointerdown', from));
      last.dispatchEvent(pointer('pointermove', 0));
      last.dispatchEvent(pointer('pointerup', 0));
    },
  });
  sound('dragging a goal into place', dragged);

  const wanted = [first.goals[first.goals.length - 1], ...first.goals.slice(0, -1)];
  if (dragged.goals.join() !== wanted.join()) {
    complain('dragging a goal into place',
      `the order reads ${dragged.goals.join(' > ')}, expected ${wanted.join(' > ')}`);
  }
  const keptOrder = JSON.parse(dragged.kept.local['factions-solver/view/v1'] ?? '{}').goals ?? [];
  if (keptOrder.join() !== wanted.join()) {
    complain('dragging a goal into place', `the order kept was ${keptOrder.join(' > ')}`);
  }

  /* 17. An effects reply pasted into the pull panel. The api names a perk
          after the tree it was bought from, not after the figure it raises,
          so a builder\'s worker efficiency arrives as "builder" on
          world.worker. Every such row belongs on that column\'s
          specialisation row. */
  const perked = {
    world: {
      worker: { details: [{ from: 'builder', base: 0, bonus: 70, multiplier: 1, raw_value: 0 }], total: 70 },
      attack: { details: [{ from: 'attack', base: 0, bonus: 25, multiplier: 1, raw_value: 0 }], total: 25 },
      /* One row, written both ways at once: the multiplier belongs to the row
         it came from, the bonus to the pool the buildings feed. */
      worker_project_efficiency: { details: [{ from: 'talents', base: 0, bonus: 30, multiplier: 1.2, raw_value: 0 }], total: 30 },
    },
    production: {
      workers: {
        details: [
          { from: 'terrain', base: 0, bonus: 12, multiplier: 1, raw_value: 0 },
          // A shrine stands on the world map, not on the grid, so its share
          // has to be read here rather than counted off the board.
          { from: 'SHRINE', base: 0, bonus: 24.5, multiplier: 1, raw_value: 0 },
          // And a building, which the grid does count, and which must not be
          // read twice.
          { from: 'TAVERN', base: 6.9, bonus: 0, multiplier: 1, raw_value: 0 },
        ],
        total: 12,
      },
      wood: { details: [{ from: 'TRADING_POST', base: 0, bonus: 0, multiplier: 1, raw_value: 59.2 }], total: 59.2 },
    },
  };
  const pasted = await boot({}, {
    after: (w) => {
      w.document.getElementById('pull-reply').value = JSON.stringify(perked);
      w.document.getElementById('pull-apply').dispatchEvent(new w.Event('click'));
    },
  });
  sound('a perk pasted into the pull panel', pasted);

  for (const [id, want] of [
    ['efficiency.worker.specialisation', '70'],
    ['efficiency.attack.specialisation', '25'],
    ['efficiency.projects.talents', '1.2'],
    ['efficiency.projects.event_projects', '30'],
    ['workers.production.terrain', '12'],
    ['workers.production.shrine', '24.5'],
    ['wood.production.redistribution', '59.2'],
  ]) {
    if (pasted.modifiers[id] !== want) {
      complain('a perk pasted into the pull panel',
        `${id} reads '${pasted.modifiers[id]}', expected '${want}'`);
    }
  }

  /* 18. The script the page hands out, run the way a player runs it: in the
          game\'s own tab, against the api. Nothing else covers it, and it is
          the one piece of this the page cannot check for itself.

          It must leave the reply where a player can take it. The console\'s
          copy() is not in every browser and can report success without
          writing anything, so the script puts the reply in a box on the page
          instead, selected and ready to copy. */
  const handed = await boot({}, {
    after: (w) => {
      w.document.getElementById('pull-open').dispatchEvent(new w.Event('click'));
      // The whole faction, which is the reading the other two are measured
      // against; the mode the panel opens on is your own village.
      const who = w.document.getElementById('pull-who');
      who.value = 'faction';
      who.dispatchEvent(new w.Event('change'));
      w.document.body.dataset.yours = fetchScriptOf(w, 'you');
      w.document.body.dataset.chosen = fetchScriptOf(w, 'chosen');
    },
  });
  sound('the script the page hands out', handed);

  const calls = [];
  const tab = new JSDOM('<!doctype html><body></body>', {
    runScripts: 'outside-only', url: 'https://www.factions-online.com/', virtualConsole: new VirtualConsole(),
  });
  const g = tab.window;
  g.localStorage.setItem('apiToken', '"a-token"');
  g.console = { log: () => {}, warn: () => {}, error: (...a) => complain('the script the page hands out', a.join(' ')) };

  const theirs = {
    hq: { id: 7, level: 12, faction: 'YELLOW' },
    grid: { terrain: Array.from({ length: 10 }, () => Array(10).fill('PLAINS')), hqPosition: { x: 4, y: 4 } },
    buildings: [{ id: 1, name: 'TAVERN', level: 3, gridX: 1, gridY: 1, rotation: 0 }],
    modules: [{ installed_on: 1, module_type: 'LEVEL_BOOST' }],
  };
  const theirEffects = {
    production: {
      workers: {
        details: [
          { from: 'terrain', base: 0, bonus: 12, multiplier: 1, raw_value: 0 },
          { from: 'SHRINE', base: 0, bonus: 24.5, multiplier: 1, raw_value: 0 },
          { from: 'TAVERN', base: 6.9, bonus: 0, multiplier: 1, raw_value: 0 },
        ],
      },
    },
    world: { worker: { details: [{ from: 'builder', base: 0, bonus: 70, multiplier: 1, raw_value: 0 }] } },
  };
  g.fetch = async (url) => {
    calls.push(String(url).replace(/^.*\/168/, ''));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => (url.endsWith('/leaderboard') ? [{ playerId: 9, name: 'Someone', faction: 'YELLOW' }]
        : url.endsWith('/events/list') ? []
          : url.endsWith('/effects') ? theirEffects : theirs),
    };
  };

  try {
    await g.eval(handed.script);
  } catch (err) {
    // A script that leans on something the browser may not offer (the
    // console's copy, the clipboard api) fails here rather than in the hands
    // of whoever pasted it.
    complain('the script the page hands out', `it threw: ${err.message}`);
  }
  await new Promise((settle) => { setTimeout(settle, 50); });

  const box = g.document.querySelector('textarea');
  if (box === null) {
    complain('the script the page hands out', 'it left no box on the page to copy the reply from');
  } else {
    if (g.document.activeElement !== box) {
      complain('the script the page hands out', 'the reply is not selected, so Ctrl+C would miss it');
    }
    const payload = JSON.parse(box.value);
    const one = payload.players[0];
    if (payload.players.length !== 1 || one.buildings[0].seal !== 'LEVEL_BOOST') {
      complain('the script the page hands out', `it read ${payload.players.length} villages, seal ${one?.buildings?.[0]?.seal}`);
    }
    // A shrine is not on the grid, so its share has to survive the trim; a
    // tavern is, and would be counted twice.
    const named = (one.effects.production?.workers?.details ?? []).map((d) => d.from);
    if (!named.includes('SHRINE') || named.includes('TAVERN')) {
      complain('the script the page hands out', `it kept ${JSON.stringify(named)}`);
    }
    if (!(one.effects.world?.worker?.details ?? []).some((d) => d.from === 'builder')) {
      complain('the script the page hands out', 'the builder perk did not survive the trim');
    }
  }

  /* 19. A view kept from before a row was renamed. The value was typed by
          hand, so it has to survive the rename rather than fall back to
          neutral. This also holds the line against reading a renamed row from
          a const that restoreFromStorage reaches before its declaration. */
  const older = await boot({
    local: {
      'factions-solver/v2': JSON.stringify({
        v: 1,
        layout: '',
        modifiers: {
          'wood.production.competitive_projects': 0.2, // now event_projects
          'iron.storage.events': 1.1, // now seasonal_events
          'workers.production.terrain': 0.4, // never renamed
        },
      }),
    },
  });
  sound('a view kept from before a rename', older);

  for (const [id, want] of [
    ['wood.production.event_projects', '0.2'],
    ['iron.storage.seasonal_events', '1.1'],
    ['workers.production.terrain', '0.4'],
  ]) {
    if (older.modifiers[id] !== want) {
      complain('a view kept from before a rename', `${id} reads '${older.modifiers[id]}', expected '${want}'`);
    }
  }

  /* The same script asked for your village alone: it must spectate nobody and
     ask the leaderboard nothing, since hq/info already describes you. */
  const alone = new JSDOM('<!doctype html><body></body>', {
    runScripts: 'outside-only', url: 'https://www.factions-online.com/', virtualConsole: new VirtualConsole(),
  });
  const y = alone.window;
  y.localStorage.setItem('apiToken', '"a-token"');
  y.console = { log: () => {}, warn: () => {}, error: (...a) => complain('reading your village alone', a.join(' ')) };
  const yourCalls = [];
  y.fetch = async (url) => {
    yourCalls.push(String(url).replace(/^.*\/168/, ''));
    return g.fetch(url);
  };

  try {
    await y.eval(handed.yours);
  } catch (err) {
    complain('reading your village alone', `it threw: ${err.message}`);
  }
  await new Promise((settle) => { setTimeout(settle, 50); });

  const yourBox = y.document.querySelector('textarea');
  if (yourBox === null) {
    complain('reading your village alone', 'it left no box on the page');
  } else {
    const payload = JSON.parse(yourBox.value);
    if (payload.players.length !== 1 || payload.players[0].you !== true) {
      complain('reading your village alone', `it read ${payload.players.length} villages, yours flagged ${payload.players[0]?.you}`);
    }
  }
  if (yourCalls.some((path) => path.includes('spectate') || path.includes('leaderboard'))) {
    complain('reading your village alone', `it asked for ${yourCalls.join(', ')}`);
  }

  // And the picking, which needs a faction to pick from.
  if (!/Read the whole faction once first/.test(handed.chosen)) {
    complain('picking faction members', `with nobody known the panel offered: ${handed.chosen.slice(0, 60)}`);
  }

  /* 20. The mill seal multiplies the wood or iron produced on its own tile,
          so the panel offers it on a woodcutter and a mine and nowhere
          else. */
  const ground = new Array(100).fill('PLAINS');
  const village = {
    v: 1,
    game: 0, // filled in below from the round the panel opens on
    players: [{
      id: 1, name: 'Someone', you: true, level: 10, hqX: 4, hqY: 4, faction: 'YELLOW', terrain: ground,
      buildings: [
        { name: 'WOODCUTTER', level: 5, x: 1, y: 1, rotation: 0, seal: 'NONE' },
        { name: 'TAVERN', level: 5, x: 3, y: 1, rotation: 0, seal: 'NONE' },
      ],
      effects: {},
    }],
  };

  const sealed = await boot({}, {
    waitMs: 1200,
    after: (w) => {
      village.game = Number(w.document.getElementById('pull-game').value);
      w.document.getElementById('pull-reply').value = JSON.stringify(village);
      w.document.getElementById('pull-apply').dispatchEvent(new w.Event('click'));

      // jsdom lays nothing out, so say which tile the pointer is over.
      const swatchesOver = (index) => {
        const tile = w.document.querySelector(`.tile[data-i="${index}"]`);
        w.document.elementFromPoint = () => tile;
        w.document.getElementById('grid').dispatchEvent(
          new w.MouseEvent('pointermove', { bubbles: true, clientX: 1, clientY: 1 }),
        );
        return [...w.document.querySelectorAll('.seal-swatch')]
          .map((one) => `${one.dataset.seal}:${one.disabled ? 'off' : 'on'}`).join(' ');
      };

      w.document.body.dataset.seals = JSON.stringify({
        woodcutter: swatchesOver(11),
        tavern: swatchesOver(13),
      });
    },
  });
  sound('the mill seal, which only some buildings take', sealed);

  const offered = sealed.seals === '' ? null : JSON.parse(sealed.seals);
  if (offered === null) {
    complain('the mill seal, which only some buildings take', 'the panel was never read');
  } else {
    if (!/ECONOMIC_BOOST:on/.test(offered.woodcutter)) {
      complain('the mill seal, which only some buildings take',
        `a woodcutter was offered ${offered.woodcutter}`);
    }
    if (!/ECONOMIC_BOOST:off/.test(offered.tavern)) {
      complain('the mill seal, which only some buildings take',
        `a tavern was offered ${offered.tavern}`);
    }
    if (!/STORAGE_EXPANDER:on/.test(offered.tavern)) {
      complain('the mill seal, which only some buildings take',
        `a tavern should still take a barrel seal, but was offered ${offered.tavern}`);
    }
  }

  for (const line of trouble) console.error(`FAIL ${line}`);
  console.log(trouble.length === 0
    ? 'the page starts up cleanly from every kind of storage'
    : `${trouble.length} startup checks failed`);
  process.exit(trouble.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
