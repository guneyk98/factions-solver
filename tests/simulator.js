'use strict';

/* Starts the simulator page the way a browser does and plays a few ticks of a
   round through it.

   The page holds no rules of its own: it writes a script, hands it to the
   engine, and draws the reply. So what is checked here is that it comes up,
   that acting on the board produces a step the engine accepts, and that a run
   survives being stored and reopened, including rubbish left behind.

   Needs jsdom, which this project does not depend on. Run it with jsdom on
   NODE_PATH, or skip it: tests/run.sh does the latter.
*/

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const site = path.join(root, process.argv[2] ?? 'build/site');

const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(site, 'simulator.html'), 'utf8');
// Real script tags share one global lexical scope; jsdom's eval does not, so
// the page's scripts go in together, in load order, the way the browser sees
// them.
const bundle = ['schema.js', 'common.js', 'simulator.js']
  .map((f) => fs.readFileSync(path.join(site, f), 'utf8')).join('\n');
const createEngine = require(path.join(site, 'engine.js'));

const trouble = [];
function complain(where, what) {
  trouble.push(`${where}: ${what}`);
}

// `after` runs once the page has settled, and `waitMs` is how long its work is
// given before the page is read.
async function boot(stored, { after = null, waitMs = 500 } = {}) {
  const console_ = new VirtualConsole();
  const noise = [];
  console_.on('jsdomError', (err) => noise.push(err.message));

  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/simulator.html', virtualConsole: console_,
  });
  const w = dom.window;

  for (const [key, value] of Object.entries(stored ?? {})) w.localStorage.setItem(key, value);

  const engine = await createEngine();
  w.createEngine = () => Promise.resolve(engine);

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

  await new Promise((resolve) => { setTimeout(resolve, 1200); });

  if (after !== null) {
    try { after(w); } catch (err) { errors.push(`after startup: ${err.message}`); }
    await new Promise((resolve) => { setTimeout(resolve, waitMs); });
  }

  process.off('unhandledRejection', onRejection);

  const read = (id) => (w.document.getElementById(id)?.textContent ?? '').trim();

  return {
    threw,
    errors,
    tick: read('tick-now'),
    season: read('season-now'),
    slots: read('slot-count'),
    status: read('status'),
    refusal: w.document.getElementById('refusal').hidden ? '' : read('refusal'),
    where: read('replay-where'),
    steps: [...w.document.querySelectorAll('.step')].map((li) => li.textContent.trim()),
    // One picture per building, drawn on the tile it stands on. A tile also
    // carries a .seal image, which is not a building.
    buildings: [...w.document.querySelectorAll('.tile img.art')].filter((i) => !i.hidden).length,
    store: read('store-list'),
    script: w.localStorage.getItem('factions-solver/simulator/v1') ?? '',
    window: w,
  };
}

// The first tile holding a building, which on a fresh start is the centre.
function centreTile(w) {
  return [...w.document.querySelectorAll('.tile')].find((tile) => !tile.querySelector('img.art').hidden);
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
}

function button(w, label) {
  return [...w.document.querySelectorAll('#insp-actions button')].find((b) => b.textContent.includes(label));
}

async function main() {
  /* A clean slate: the centre stands on the first tile that can hold one, at
     the first tick, with nothing bought. */
  {
    const page = await boot({});
    const where = 'fresh';
    if (page.threw) complain(where, `the page threw: ${page.threw}`);
    for (const err of page.errors) complain(where, err);
    if (page.tick !== '0') complain(where, `starts at tick ${page.tick}, not 0`);
    if (page.season !== '0') complain(where, `starts in season ${page.season}, not 0`);
    if (page.buildings !== 1) complain(where, `${page.buildings} buildings stand, expected only the centre`);
    if (page.steps.length !== 0) complain(where, `${page.steps.length} steps before anything was done`);
    if (!page.script.includes('steps')) complain(where, 'the run was not stored');
  }

  /* Waiting produces wood, and the tick and the season both follow the clock.
     3240 ticks is one whole season. */
  {
    const page = await boot({}, {
      after: (w) => {
        w.document.getElementById('wait-ticks').value = '3240';
        click(w.document.getElementById('wait'));
      },
    });
    const where = 'waiting';
    for (const err of page.errors) complain(where, err);
    if (page.tick !== '3240') complain(where, `waited to tick ${page.tick}, not 3240`);
    if (page.season !== '1') complain(where, `a wait of 3240 ticks left season ${page.season}, not 1`);
  }

  /* Building: pick a hut from the palette and click a tile beside the centre.
     The engine decides whether it may be built, so what is checked is that a
     step appears and is not refused. */
  {
    let placed = false;
    const page = await boot({}, {
      after: (w) => {
        const tiles = [...w.document.querySelectorAll('.tile')];
        const centre = tiles.indexOf(centreTile(w));

        for (const near of [centre + 1, centre - 1, centre + 10, centre - 10]) {
          if (near < 0 || near >= tiles.length) continue;
          if (tiles[near].classList.contains('no-build')) continue;

          const hut = [...w.document.querySelectorAll('#building-palette .swatch')]
            .find((b) => b.textContent.includes('Hut'));
          if (hut === undefined) throw new Error('the palette has no hut');

          click(hut);
          click(tiles[near]);
          placed = true;
          break;
        }
      },
    });
    const where = 'building';
    for (const err of page.errors) complain(where, err);
    if (!placed) complain(where, 'no buildable tile beside the centre');
    else if (page.steps.length !== 1) complain(where, `${page.steps.length} steps after one build`);
    else if (page.refusal) complain(where, `the build was refused: ${page.refusal}`);
    else if (page.buildings !== 2) complain(where, `${page.buildings} buildings stand after building one beside the centre`);
  }

  /* Two waits in a row are one entry, and reading the run back to before them
     shows the tick they started from. */
  {
    const page = await boot({}, {
      after: (w) => {
        const wait = w.document.getElementById('wait');
        w.document.getElementById('wait-ticks').value = '250';
        click(wait);
        click(wait);
      },
    });
    const where = 'merging waits';
    for (const err of page.errors) complain(where, err);
    if (page.steps.length !== 1) complain(where, `two waits made ${page.steps.length} entries, not one`);
    if (page.tick !== '500') complain(where, `two waits of 250 reached tick ${page.tick}, not 500`);
    if (!page.steps[0].includes('500 ticks')) complain(where, `the entry reads ${JSON.stringify(page.steps[0])}`);
  }

  /* Reading the run back: clicking a step shows the board as it was after that
     step, and the run itself is untouched. */
  {
    const page = await boot({}, {
      after: (w) => {
        w.document.getElementById('wait-ticks').value = '100';
        click(w.document.getElementById('wait'));

        const hut = [...w.document.querySelectorAll('#building-palette .swatch')]
          .find((b) => b.textContent.includes('Hut'));
        const tiles = [...w.document.querySelectorAll('.tile')];
        const centre = tiles.indexOf(centreTile(w));
        const near = [centre + 1, centre - 1, centre + 10, centre - 10]
          .find((i) => i >= 0 && i < tiles.length && !tiles[i].classList.contains('no-build'));
        click(hut);
        click(tiles[near]);

        // Back to just after the wait, before the hut went up.
        click(w.document.querySelectorAll('.step')[0]);
      },
    });
    const where = 'reading back';
    for (const err of page.errors) complain(where, err);
    if (page.steps.length !== 2) complain(where, `${page.steps.length} entries, expected a wait and a build`);
    if (page.buildings !== 1) complain(where, `${page.buildings} buildings stand at the step before the build`);
    if (page.tick !== '100') complain(where, `the board shows tick ${page.tick}, not 100`);
    if (page.where !== '1 of 2') complain(where, `the replay says ${JSON.stringify(page.where)}, not '1 of 2'`);
  }

  /* Moving a building is a step of its own, a second move before the clock
     advances folds into it, and a move that ends where it began leaves no step
     at all.

     jsdom lays nothing out, so elementFromPoint answers null and a drag cannot
     be driven through the pointer. The R key moves a building to the tile it
     already stands on, facing the other way, which is the entry a drag makes.
     It needs a building with more than one orientation, which no tier-1
     building has, so the run starts from a village that already holds one. */
  {
    // (2, 8), a guild hall, which is a 1x2 in this round with open ground
    // south of it, so it has somewhere to rotate into.
    const guildHall = 82;
    const standing = `${fs.readFileSync(path.join(root, 'tests/cases/full.txt'), 'utf8').trim()}\nsteps`;

    const page = await boot({ 'factions-solver/simulator/v1': standing }, {
      after: (w) => {
        click([...w.document.querySelectorAll('.tile')][guildHall]);
        const count = () => w.document.querySelectorAll('.step').length;
        // Dispatched on the body, which is where a browser sends a keystroke
        // when nothing is focused; the page reads the target to ignore typing.
        const turn = () => w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'r', bubbles: true }));

        turn();
        w.afterOneTurn = count();
        // A line has two orientations, so the second turn faces it as it began
        // and the two together did nothing.
        turn();
        w.afterTwoTurns = count();

        // The clock advances, so the next one cannot fold into anything.
        click(w.document.getElementById('wait'));
        turn();
      },
    });
    const where = 'moving';
    for (const err of page.errors) complain(where, err);
    if (page.refusal) complain(where, `the move was refused: ${page.refusal}`);
    if (page.window.afterOneTurn !== 1) complain(where, `one rotation made ${page.window.afterOneTurn} entries, not one`);
    if (page.window.afterTwoTurns !== 0) complain(where, `two rotations left ${page.window.afterTwoTurns} entries, not none`);
    // The wait, and the rotation the wait separated from the pair before it.
    if (page.steps.length !== 2) complain(where, `a rotation after a wait made ${page.steps.length} entries, not 2`);
  }

  /* A stored run is reopened exactly as it was left: the page stores the
     script it last gave the engine, so what comes back is what went out. */
  {
    const first = await boot({}, {
      after: (w) => {
        w.document.getElementById('wait-ticks').value = '300';
        click(w.document.getElementById('wait'));
      },
    });

    const again = await boot({ 'factions-solver/simulator/v1': first.script });
    const where = 'reopening';
    for (const err of again.errors) complain(where, err);
    if (again.tick !== first.tick) complain(where, `reopened at tick ${again.tick}, left at ${first.tick}`);
    if (again.script !== first.script) complain(where, 'the run changed as it was reopened');
  }

  // Rubbish in storage loses the run and nothing else: the page still comes up.
  for (const rubbish of ['', '{]', 'steps', 'not a village at all\nsteps\n0 build 1,1 NOPE']) {
    const page = await boot({ 'factions-solver/simulator/v1': rubbish });
    const where = `rubbish ${JSON.stringify(rubbish).slice(0, 24)}`;
    if (page.threw) complain(where, `the page threw: ${page.threw}`);
    for (const err of page.errors) complain(where, err);
    if (page.buildings !== 1) complain(where, `${page.buildings} buildings stand, expected only the centre`);
  }

  if (trouble.length) {
    for (const one of trouble) process.stderr.write(`${one}\n`);
    process.stderr.write(`\nthe simulator page: ${trouble.length} faults\n`);
    process.exit(1);
  }

  process.stdout.write('the simulator page starts up, builds and reopens cleanly\n');
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
