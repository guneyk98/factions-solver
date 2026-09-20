'use strict';

/* The simulator. What it shares with the planner is in common.js, loaded
   first.

   The page holds no rules: it holds a starting point and a list of entries,
   sends both to the engine as one script, and draws the reply.

   An entry is either a step or a wait. The engine knows nothing of waits, only
   the tick each step falls on; waits are entries here so the run can be shown
   at any point in it. */

const STORED = 'factions-solver/simulator/v1';
/* What the planner saves under, read only, to start a run from its village.
   The village is a {v, layout, modifiers} object rather than the layout text;
   which round it belongs to is kept apart from it, with the controls. */
const PLANNER_VILLAGE = 'factions-solver/v2';
const PLANNER_VIEW = 'factions-solver/view/v1';

const SEAL_COOLDOWN = 100;
const FULL_CHARGE = 100;
const TIER_COUNT = Math.max(...TIERS);
const DRAG_THRESHOLD = 4;

const WAIT = 'wait';

function noSeals() {
  return Object.fromEntries(SEALS.filter((s) => s.key !== NO_SEAL).map((s) => [s.key, 0]));
}

const state = {
  game: GAMES[0].id,
  tier: TIER_COUNT,
  // The village the run starts from, and what the player holds at that tick.
  start: { tick: 0, tiles: [], level: 1, stock: { wood: 500, iron: 500, workers: 0, soldiers: 0 }, seals: noSeals() },
  entries: [],
  /* How many entries the board is showing the state after, so `entries.length`
     is the end of the run and 0 is the moment before anything happened. */
  shown: 0,
  panel: 'build',
  buildTool: null,
  buildOrientation: EAST,
  buildTier: 1,
  selected: null,
  hovered: null,
  modifiers: {
    ...Object.fromEntries(GAME_MODIFIERS.map((m) => [m.id, m.neutral])),
    [POLITICS_ID]: NO_POLITICS,
  },
};

// What the engine last replied, and the village standing at the shown entry.
let report = null;
let tiles = blankTiles(state.game);
let drag = null;

function blankTiles(game) {
  const ground = terrainRows(GAME_BY_ID.get(game) ?? GAMES[0]);
  const made = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      made.push({ terrain: ground[y][x], building: EMPTY, level: 0, orientation: EAST, seal: NO_SEAL });
    }
  }
  return made;
}

/* A village starts as its centre on otherwise bare ground, on the first tile
   that can hold one: the centre of one round's map is sea in the next. */
function freshStart(game) {
  const made = blankTiles(game);
  const first = made.findIndex((tile) => !UNBUILDABLE.has(tile.terrain));
  made[first].building = CENTRE;
  made[first].level = 1;
  return { tick: 0, tiles: made, level: 1, stock: { wood: 500, iron: 500, workers: 0, soldiers: 0 }, seals: noSeals() };
}

/* ------------------------------- the run -------------------------------- */

// Every entry with the tick it leaves the clock at.
function timeline() {
  let tick = state.start.tick;
  return state.entries.map((entry) => {
    if (entry.action === WAIT) tick += entry.ticks;
    return { ...entry, tick };
  });
}

// What the shared panels read, both from the last reply.
function board() {
  return { tiles, result: report === null ? null : report.production };
}

// Where the next entry would fall.
function tickShown() {
  const timed = timeline();
  return state.shown === 0 ? state.start.tick : timed[state.shown - 1].tick;
}

function tileToken(tile) {
  // Trailing flags, each optional; the parser tells them apart by length.
  let token = `${tile.terrain}:${tile.building}:${tile.level}`;
  if (isMultiTile(tile.building)) token += `:${tile.orientation}`;
  if (tile.seal !== NO_SEAL) token += `:${tile.seal}`;
  return token;
}

function stepLine(entry) {
  const at = (i) => `${i % WIDTH},${Math.floor(i / WIDTH)}`;

  switch (entry.action) {
    case 'build': return `${entry.tick} build ${at(entry.tile)} ${entry.building} ${entry.orientation}`;
    case 'move': return `${entry.tick} move ${at(entry.from)} ${at(entry.tile)} ${entry.orientation}`;
    case 'village': return `${entry.tick} village`;
    case 'seal': return `${entry.tick} seal ${entry.seal} ${at(entry.tile)}`;
    default: return `${entry.tick} ${entry.action} ${at(entry.tile)}`;
  }
}

/* The run as Parse::script reads it, up to the entry being shown. Waits are
   not written: they are already in the ticks the steps carry and in `until`. */
function scriptText(upTo = state.shown) {
  const timed = timeline().slice(0, upTo);
  const until = timed.length === 0 ? state.start.tick : timed[timed.length - 1].tick;

  const settings = [`game=${state.game}`, `tier=${state.tier}`, `tick=${state.start.tick}`, `until=${until}`];

  for (const { key } of RESOURCES) settings.push(`stock.${key}=${state.start.stock[key]}`);
  for (const [key, held] of Object.entries(state.start.seals)) {
    if (held > 0) settings.push(`seals.${key}=${held}`);
  }

  for (const { id, neutral, percent } of GAME_MODIFIERS) {
    const entered = state.modifiers[id];
    if (entered === neutral) continue;
    settings.push(`${id}=${(percent ? entered / 100 : entered).toFixed(MODIFIER_DECIMALS)}`);
  }
  if (state.modifiers[POLITICS_ID] !== NO_POLITICS) settings.push(`${POLITICS_ID}=${state.modifiers[POLITICS_ID]}`);

  const village = [String(state.start.level), ...state.start.tiles.map(tileToken)].join(' ');
  const steps = timed.filter((entry) => entry.action !== WAIT).map(stepLine);

  return [`${village} ${settings.join(' ')}`, 'steps', ...steps].join('\n');
}

// Which reply step each entry produced, or null for a wait, which produces
// none: the two lists are not the same length.
function stepOfEntry() {
  const which = [];
  let step = 0;
  for (const entry of state.entries) which.push(entry.action === WAIT ? null : step++);
  return which;
}

/* -------------------------- appending an entry -------------------------- */

/* Two waits in a row become one wait, and a building moved twice before the
   clock advances becomes one move. Any entry between them ends the run. */
function merged(entry) {
  const last = state.entries[state.entries.length - 1];
  if (last === undefined) return false;

  if (entry.action === WAIT && last.action === WAIT) {
    last.ticks += entry.ticks;
    return true;
  }

  if (entry.action === 'move' && last.action === 'move' && last.tile === entry.from) {
    last.tile = entry.tile;
    last.orientation = entry.orientation;
    // Moved back to where it started, facing as it did: nothing happened.
    if (last.tile === last.from && last.orientation === last.wasOrientation) state.entries.pop();
    return true;
  }

  return false;
}

/* Applies `change` and runs it. If the engine refuses a step it did not refuse
   before, the change is reverted and the refusal shown instead. */
function attempt(change) {
  const before = JSON.stringify({ entries: state.entries, shown: state.shown, start: state.start });
  const refusedBefore = report !== null && report.refusal !== null;

  change();
  run();

  if (report === null || report.refusal === null || refusedBefore) return;
  const refusal = report.refusal;
  ({ entries: state.entries, shown: state.shown, start: state.start } = JSON.parse(before));
  run();
  showStatus(refusal, true);
}

function add(entry) {
  attempt(() => {
    // Acting part way through the run removes the entries after it.
    if (state.shown < state.entries.length) state.entries.length = state.shown;
    if (!merged(entry)) state.entries.push(entry);
    state.shown = state.entries.length;
    state.buildTool = null;
  });
}

function addMove(from, to, orientation) {
  // At the first tick the centre's position is the starting village's, not
  // something a step set.
  if (tiles[from].building === CENTRE && tickShown() === state.start.tick) {
    const was = state.start.tiles.findIndex((tile) => tile.building === CENTRE);
    if (was !== -1) {
      attempt(() => {
        state.start.tiles[was] = { ...state.start.tiles[was], building: EMPTY, level: 0 };
        state.start.tiles[to] = { ...state.start.tiles[to], building: CENTRE, level: state.start.level, orientation };
      });
      state.selected = to;
      render();
      return;
    }
  }

  // `wasOrientation` says whether a merged pair of moves left it as it was.
  add({ action: 'move', from, tile: to, orientation, wasOrientation: tiles[from].orientation });
}

/* ------------------------------- elements ------------------------------- */

const gridEl = document.getElementById('grid');
const statusEl = document.getElementById('status');
const boardNote = document.getElementById('board-note');
const stepListEl = document.getElementById('step-list');
const stepsEmptyEl = document.getElementById('steps-empty');
const refusalEl = document.getElementById('refusal');
const replayWhere = document.getElementById('replay-where');
const tierTabs = document.getElementById('tier-tabs');
const paletteEl = document.getElementById('building-palette');
const rotateHint = document.getElementById('rotate-hint');
const sealStoreEl = document.getElementById('seal-store');
const inspEmpty = document.getElementById('insp-empty');
const inspBody = document.getElementById('insp-body');
const inspBasics = document.getElementById('insp-basics');
const inspActions = document.getElementById('insp-actions');
const inspSeals = document.getElementById('insp-seals');
const inspDetail = document.getElementById('insp-detail');
const sealButtons = document.getElementById('seal-buttons');
const runBarEl = document.getElementById('run-bar');
const waitInput = document.getElementById('wait-ticks');
const waitAffordable = document.getElementById('wait-affordable');
const undoStep = document.getElementById('undo-step');
const gameSelect = document.getElementById('game-select');
const tierSelect = document.getElementById('tier-select');

const tileEls = [];
for (let i = 0; i < TILE_COUNT; i += 1) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'tile tiled';
  el.dataset.i = String(i);

  const frame = document.createElement('div');
  frame.className = 'frame';

  const img = document.createElement('img');
  img.className = 'art';
  img.hidden = true;
  img.alt = '';

  const seal = document.createElement('img');
  seal.className = 'seal';
  seal.hidden = true;
  seal.alt = '';

  frame.append(img, seal);
  const level = span('level');
  el.append(frame, level);
  gridEl.append(el);
  tileEls.push({ el, frame, img, seal, level });
}

let statusTimer = null;

function showStatus(text, bad = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('bad', bad);
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 6000);
}

/* ------------------------------- the board ------------------------------ */

function buildable(i) {
  return !UNBUILDABLE.has(tiles[i].terrain);
}

function tileAt(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const tileEl = el && el.closest ? el.closest('.tile') : null;
  return tileEl && gridEl.contains(tileEl) ? Number(tileEl.dataset.i) : null;
}

// The cell under the pointer, less the offset of the grabbed footprint cell.
function anchorForDrop(cell) {
  if (cell === null || drag.grabIndex === 0) return cell;
  const [dx, dy] = footprintOffsets(tiles[drag.from].building, drag.orientation)[drag.grabIndex];
  return cellAt((cell % WIDTH) - dx, Math.floor(cell / WIDTH) - dy);
}

function blockedReason(cells, key, occupancy, ignoreAnchor = null) {
  const name = BUILDING_BY_KEY.get(key).name.toLowerCase();
  if (!cells) return `A ${name} doesn't fit there.`;

  for (const cell of cells) {
    if (!buildable(cell)) return `Nothing can be built on ${TERRAIN_BY_KEY.get(tiles[cell].terrain).name.toLowerCase()}.`;
    const occupant = occupancy[cell];
    if (occupant !== null && occupant !== ignoreAnchor) return `A ${name} doesn't fit there.`;
  }
  return null;
}

// Where a drag would put the building it holds, and whether it may go there.
function dragPreview() {
  if (drag === null || !drag.moved) return null;

  const { building: key, level } = tiles[drag.from];
  const anchor = anchorForDrop(drag.over);
  const cells = anchor === null ? null : footprintCells(anchor, key, drag.orientation);
  const shape = { key, level, orientation: drag.orientation };
  if (!cells) return { anchor: null, cells: [], ok: false, ...shape };

  const occupancy = occupancyMap(tiles);
  const ok = cells.every((cell) => buildable(cell) && (occupancy[cell] === null || occupancy[cell] === drag.from));
  return { anchor, cells, ok, ...shape };
}

// Where a building picked from the palette would go, under the pointer.
function hoverPreview(occupancy) {
  if (drag !== null || state.buildTool === null) return null;

  const i = state.hovered;
  if (i === null || occupancy[i] !== null) return null;

  const cells = footprintCells(i, state.buildTool, state.buildOrientation);
  return {
    anchor: i,
    cells: cells ?? [i],
    ok: cells !== null && blockedReason(cells, state.buildTool, occupancy) === null,
    key: state.buildTool,
    level: 1,
    orientation: state.buildOrientation,
  };
}

function renderGrid() {
  const occupancy = occupancyMap(tiles);
  const preview = dragPreview() ?? hoverPreview(occupancy);
  const previewCells = preview === null ? null : new Set(preview.cells);
  const dragging = drag !== null && drag.moved;
  const draggedCells = dragging
    ? new Set(footprintCells(drag.from, tiles[drag.from].building, tiles[drag.from].orientation) ?? [drag.from])
    : null;
  const selectedAnchor = state.selected === null ? null : occupancy[state.selected];

  for (let i = 0; i < TILE_COUNT; i += 1) {
    const tile = tiles[i];
    const view = tileEls[i];
    const el = view.el;
    const anchor = occupancy[i];
    const isAnchor = anchor === i;

    applyTerrain(el, tile.terrain, terrainMask(tiles, i));
    el.classList.toggle('selected', selectedAnchor === null ? state.selected === i : anchor === selectedAnchor);
    el.classList.toggle('drag-source', dragging && draggedCells.has(i));
    el.classList.toggle('drop-ok', previewCells !== null && previewCells.has(i) && preview.ok);
    el.classList.toggle('drop-bad', previewCells !== null && previewCells.has(i) && !preview.ok);
    el.classList.toggle('no-build', !buildable(i));
    el.classList.toggle('grabbable', anchor !== null);

    // A tile draws the preview anchored on it, and what stands on it otherwise.
    const ghosting = preview !== null && preview.anchor === i && (!isAnchor || dragging);
    const spanningKey = ghosting ? preview.key : (isAnchor ? tile.building : EMPTY);
    const spans = ghosting ? preview.cells.length > 1 : isAnchor && isMultiTile(tile.building);
    const facing = ghosting ? preview.orientation : tile.orientation;
    const shape = shapeOf(spanningKey);

    el.classList.toggle('spanning', spans);
    view.frame.classList.toggle('span-h', spans && shape === 'line' && facing !== SOUTH);
    view.frame.classList.toggle('span-v', spans && shape === 'line' && facing === SOUTH);
    view.frame.classList.toggle('span-block', spans && shape === 'square');
    const bent = spans && shape === 'l';
    view.frame.classList.toggle('span-l', bent);
    for (const one of SCHEMA.orientations) view.frame.classList.toggle(`l-${one}`, bent && facing === one);

    view.img.classList.toggle('ghost', ghosting);
    view.img.classList.toggle('ghost-bad', ghosting && !preview.ok);
    view.frame.classList.toggle('ghost', ghosting && dragging);
    view.frame.classList.toggle('ghost-bad', ghosting && dragging && !preview.ok);

    const src = ghosting ? buildingImage(preview.key, preview.level)
      : (isAnchor ? buildingImage(tile.building, tile.level) : null);
    if (src) {
      if (view.img.getAttribute('src') !== src) view.img.setAttribute('src', src);
      view.img.hidden = false;
    } else {
      view.img.hidden = true;
    }

    const framed = ghosting ? preview.key : (isAnchor ? tile.building : null);
    const frameImg = framed === null ? null : TYPE_BY_KEY.get(BUILDING_BY_KEY.get(framed).type).img;
    const source = frameImg === null ? 'none' : `url("${frameImg}")`;
    if (view.frame.style.getPropertyValue('--frame-src') !== source) {
      view.frame.style.setProperty('--frame-src', source);
    }

    const sealImg = isAnchor ? SEAL_BY_KEY.get(tile.seal).img : null;
    if (sealImg) {
      if (view.seal.getAttribute('src') !== sealImg) view.seal.setAttribute('src', sealImg);
      view.seal.hidden = false;
    } else {
      view.seal.hidden = true;
    }

    view.level.textContent = anchor !== null && levelCell(tiles, anchor) === i ? String(tiles[anchor].level) : '';

    const ground = TERRAIN_BY_KEY.get(tile.terrain).name;
    el.title = anchor === null ? ground
      : `${ground}, ${BUILDING_BY_KEY.get(tiles[anchor].building).name} lv${tiles[anchor].level}`;
  }
}

/* ------------------------------ the figures ----------------------------- */

function row(list, what, value, cls = '', title = '') {
  const li = document.createElement('li');
  li.append(span('fx-what', what));
  li.append(span(`fx-value ${cls}`, value));
  if (title) li.title = title;
  list.append(li);
  return li;
}

// The four resources, then the two units, which charge to FullCharge.
const STORED_QUANTITIES = [
  ...RESOURCES.map(({ key, name, cls }) => ({ key, name, cls, unit: false })),
  ...UNITS.map(({ one, key, cls }) => ({ key, name: one, cls: cls ?? 'power-value', unit: true })),
];

// Ticks until the store reaches its capacity.
function ticksToCap(held, rate, cap) {
  if (held >= cap) return 'full';
  if (rate <= 0) return '\u2014';
  return String(Math.ceil((cap - held) / rate));
}

const runColumns = new Map();

function buildRunBar() {
  for (const one of STORED_QUANTITIES) {
    const column = document.createElement('div');
    column.className = 'run-column';

    const head = document.createElement('h4');
    head.className = `fx-head ${one.cls}`;
    head.textContent = one.name;
    column.append(head);

    const rows = {};
    const list = document.createElement('ul');
    list.className = 'fx-list';
    for (const [field, what, title] of [
      ['storage', 'storage', one.unit ? 'Charge, out of one whole unit' : 'Stored, out of storage capacity'],
      ['production', 'production', 'Produced per tick'],
      ['cap', 'to cap', 'Ticks until storage reaches capacity'],
    ]) {
      const li = document.createElement('li');
      li.title = title;
      const value = span(`fx-value ${one.cls}`, '0');
      rows[field] = value;
      li.append(span('fx-what', what), value);
      list.append(li);
    }

    column.append(list);
    runBarEl.append(column);
    runColumns.set(one.key, rows);
  }
}

function renderRunBar() {
  const end = report === null ? null : report.end;

  for (const one of STORED_QUANTITIES) {
    const rows = runColumns.get(one.key);
    if (end === null) {
      for (const field of ['storage', 'production', 'cap']) rows[field].textContent = '\u2014';
      continue;
    }

    const held = one.unit ? end.charge[one.key] : end.stock[one.key];
    const cap = one.unit ? FULL_CHARGE : end.capacity[one.key];
    const rate = one.unit ? end.unitProduction[one.key] : end.production[one.key];

    rows.storage.textContent = `${one.unit ? fmt(held, 1) : fmtStore(held)} / ${fmtStore(cap)}`;
    rows.production.textContent = fmt(rate, 3);
    rows.cap.textContent = ticksToCap(held, rate, cap);
  }

  document.getElementById('tick-now').textContent = end === null ? '0' : String(end.tick);
  document.getElementById('season-now').textContent = end === null ? '0' : String(end.season);
  document.getElementById('slot-count').textContent = end === null ? '0 / 1' : `${end.slotsUsed} / ${end.villageLevel}`;
}

// Mirrors Simulation::ticksUntilAffordable: set by the resource that takes
// longest, and never for a cost above the storage capacity.
function ticksUntilAffordable(cost) {
  if (report === null) return -1;
  let longest = 0;

  for (const resource of COSTED) {
    const owed = (cost[resource] ?? 0) - report.end.stock[resource];
    if (owed <= 0) continue;
    if (report.end.production[resource] <= 0 || cost[resource] > report.end.capacity[resource]) return -1;
    longest = Math.max(longest, Math.ceil(owed / report.end.production[resource]));
  }
  return longest;
}

// The village level under the centre, the building's next level elsewhere.
function costOfNextPurchase() {
  if (report === null || state.selected === null) return null;

  const anchor = occupancyMap(tiles)[state.selected];
  if (anchor === null) return null;
  if (tiles[anchor].building === CENTRE) return report.production.cost.village.next;

  const entry = report.production.cost.buildings.find((one) => one.tile === anchor);
  return entry ? entry.next : null;
}

/* ------------------------------ the replay ------------------------------ */

// The action's own name, as src/simulate.hpp lists them.
const ACTION_NAMES = {
  wait: 'Wait',
  build: 'Build',
  upgrade: 'Upgrade',
  destroy: 'Destroy',
  move: 'Move',
  village: 'Upgrade village',
  seal: 'Attach seal',
  unseal: 'Detach seal',
};

// The tile an entry acted on, and for a move the tile it started from.
function coordinates(i) {
  return i === null || i === undefined ? '' : `${i % WIDTH}, ${Math.floor(i / WIDTH)}`;
}

/* What the entry acted on: the building for everything that stands, the seal
   for the two seal actions, and the number of ticks for a wait. */
function actedOn(entry, applied) {
  if (entry.action === WAIT) return `${entry.ticks} ticks`;
  if (entry.action === 'seal') return SEAL_BY_KEY.get(entry.seal).name;
  if (entry.action === 'village') return applied ? `level ${applied.level}` : '';

  const building = entry.building ?? applied?.building ?? EMPTY;
  const named = BUILDING_BY_KEY.get(building)?.name ?? building;
  if (entry.action === 'upgrade' && applied) return `${named} to level ${applied.level}`;
  if (entry.action === 'unseal') return applied && applied.seal !== NO_SEAL ? SEAL_BY_KEY.get(applied.seal).name : named;
  return named;
}

function renderSteps() {
  stepListEl.replaceChildren();
  stepsEmptyEl.hidden = state.entries.length > 0;
  undoStep.disabled = state.entries.length === 0;

  const timed = timeline();
  const which = stepOfEntry();
  // The entry the engine refused, if it refused one, so it and what follows can
  // be marked as never having happened.
  const refusedEntry = report === null || report.refusal === null
    ? -1
    : which.findIndex((step) => step === report.refusedAt);

  timed.forEach((entry, n) => {
    const item = document.createElement('li');
    item.className = 'step';
    item.classList.toggle('step-shown', n === state.shown - 1);
    item.classList.toggle('step-ahead', n >= state.shown);
    item.classList.toggle('step-refused', refusedEntry >= 0 && n >= refusedEntry && n < state.shown);

    /* The reply covers only the entries up to the one being shown, so an entry
       past it has no step to read: `?? null` rather than the undefined the
       lookup gives back. */
    const applied = report === null || which[n] === null ? null : (report.steps[which[n]] ?? null);

    item.append(span('step-tick', String(entry.tick)));
    item.append(span('step-action', ACTION_NAMES[entry.action] ?? entry.action));
    item.append(span('step-subject', actedOn(entry, applied)));
    item.append(span('step-from', entry.action === 'move' ? coordinates(entry.from) : ''));
    item.append(span('step-to', entry.action === WAIT || entry.action === 'village' ? '' : coordinates(entry.tile)));

    const cost = applied === null ? [] : [
      ...COSTED.filter((r) => applied.paid[r] > 0).map((r) => `${fmtStoreShort(applied.paid[r])} ${r}`),
      ...COSTED.filter((r) => applied.refunded[r] > 0).map((r) => `+${fmtStoreShort(applied.refunded[r])} ${r}`),
    ];
    item.append(span('step-cost', cost.join(' ')));

    // Clicking the row shows the village after this entry, and selects the
    // tile the entry acted on.
    item.addEventListener('click', (event) => {
      if (event.target.closest('.step-drop') !== null) return;
      state.selected = entry.action === WAIT || entry.action === 'village' ? state.selected : entry.tile;
      state.shown = n + 1;
      run();
    });

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'step-drop';
    drop.title = 'Remove this step and every step after it';
    drop.textContent = '✕';
    drop.addEventListener('click', () => {
      state.entries.length = n;
      state.shown = state.entries.length;
      run();
    });
    item.append(drop);

    stepListEl.append(item);
  });

  const refused = report !== null && report.refusal !== null;
  refusalEl.hidden = !refused;
  if (refused) refusalEl.textContent = `Refused: ${report.refusal}`;

  replayWhere.textContent = state.entries.length === 0 ? '' : `${state.shown} of ${state.entries.length}`;

  document.getElementById('replay-start').disabled = state.shown === 0;
  document.getElementById('replay-back').disabled = state.shown === 0;
  document.getElementById('replay-forward').disabled = state.shown >= state.entries.length;
  document.getElementById('replay-end').disabled = state.shown >= state.entries.length;

  const behind = state.shown < state.entries.length;
  boardNote.hidden = !behind;
  if (behind) {
    boardNote.textContent = `Step ${state.shown} of ${state.entries.length}.`
      + ' Acting here removes the steps after it.';
  }

  /* Scrolled directly rather than with scrollIntoView, which would scroll the
     window and move the board. */
  const showing = stepListEl.children[state.shown - 1];
  if (showing !== undefined) {
    const top = showing.offsetTop;
    const bottom = top + showing.offsetHeight;
    if (top < stepListEl.scrollTop) stepListEl.scrollTop = top;
    else if (bottom > stepListEl.scrollTop + stepListEl.clientHeight) {
      stepListEl.scrollTop = bottom - stepListEl.clientHeight;
    }
  }
}

function goTo(shown) {
  const wanted = Math.min(Math.max(shown, 0), state.entries.length);
  if (wanted === state.shown) return;
  state.shown = wanted;
  run();
}

/* ----------------------------- the inspector ---------------------------- */

function actionButton(label, onClick, { title = '', enabled = true } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (title) button.title = title;
  button.disabled = !enabled;
  button.addEventListener('click', onClick);
  inspActions.append(button);
  return button;
}

function renderInspector() {
  const i = state.selected;
  inspEmpty.hidden = i !== null;
  inspBody.hidden = i === null;
  if (i === null) return;

  const anchor = occupancyMap(tiles)[i];
  const tile = anchor === null ? tiles[i] : tiles[anchor];
  const ground = TERRAIN_BY_KEY.get(tiles[i].terrain);

  inspBasics.replaceChildren();
  inspBasics.append(span('tile-ground', ground.name));
  inspBasics.append(span('tile-where', `${i % WIDTH}, ${Math.floor(i / WIDTH)}`));

  if (anchor !== null) {
    const face = span('tile-face');
    const art = document.createElement('img');
    art.className = 'tile-art';
    art.src = buildingImage(tile.building, tile.level);
    art.alt = '';
    face.append(art, span('', `${BUILDING_BY_KEY.get(tile.building).name} · level ${tile.level}`));
    inspBasics.append(face);
  }

  inspActions.replaceChildren();

  if (anchor === null) {
    if (state.buildTool !== null) {
      actionButton(`Build ${BUILDING_BY_KEY.get(state.buildTool).name}`,
        () => add({ action: 'build', tile: i, building: state.buildTool, orientation: state.buildOrientation }));
    }
    renderSealButtons(null);
    inspDetail.innerHTML = tileDetail(board(), i, null);
    return;
  }

  const info = BUILDING_BY_KEY.get(tile.building);

  const cost = costOfNextPurchase();
  const affordable = cost !== null && ticksUntilAffordable(cost) === 0;

  if (tile.building === CENTRE) {
    actionButton(`Upgrade village to ${tile.level + 1}`, () => add({ action: 'village', tile: anchor }),
      { enabled: affordable });
  } else {
    actionButton(`Upgrade to ${tile.level + 1}`, () => add({ action: 'upgrade', tile: anchor }),
      { enabled: affordable && tile.level < info.maxLevel });
    actionButton('Destroy', () => add({ action: 'destroy', tile: anchor }), {
      title: report !== null && report.end.recycling > 0
        ? `Refunds ${Math.round(report.end.recycling * 100)}% of its total cost`
        : 'No recycling workshop: no refund',
    });
  }

  if (isRotatable(tile.building)) {
    actionButton('Rotate', () => addMove(anchor, anchor, rotate(tile.building, tile.orientation)),
      { title: 'R' });
  }

  renderSealButtons(anchor);
  inspDetail.innerHTML = tileDetail(board(), i, anchor);
}

function renderSealButtons(anchor) {
  sealButtons.replaceChildren();
  const tile = anchor === null ? null : tiles[anchor];
  inspSeals.hidden = tile === null || !sealable(tile.building);
  if (inspSeals.hidden) return;

  if (tile.seal !== NO_SEAL) {
    const off = document.createElement('button');
    off.type = 'button';
    off.textContent = `Detach ${SEAL_BY_KEY.get(tile.seal).name}`;
    off.title = 'No cooldown';
    off.addEventListener('click', () => add({ action: 'unseal', tile: anchor }));
    sealButtons.append(off);
    return;
  }

  const now = tickShown();
  for (const seal of SEALS) {
    if (seal.key === NO_SEAL) continue;

    const held = report === null ? 0 : report.end.sealsStored[seal.key];
    const readyAt = report === null ? 0 : report.end.sealReadyAt[seal.key];
    const fits = sealFits(seal.key, tile.building);
    const ready = held > 0 && readyAt <= now;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'seal-swatch';
    button.disabled = !ready || !fits;
    button.title = !fits ? `Does not fit a ${BUILDING_BY_KEY.get(tile.building).name.toLowerCase()}`
      : held === 0 ? 'None in storage'
        : ready ? `${seal.name}: ${SEAL_COOLDOWN} tick cooldown once attached`
          : `On cooldown until tick ${readyAt}`;

    const img = document.createElement('img');
    img.src = seal.img;
    img.alt = '';
    button.append(img, span('seal-count', String(held)));
    button.addEventListener('click', () => add({ action: 'seal', tile: anchor, seal: seal.key }));
    sealButtons.append(button);
  }
}

function renderSealStore() {
  sealStoreEl.replaceChildren();
  const now = tickShown();

  for (const seal of SEALS) {
    if (seal.key === NO_SEAL) continue;

    const held = report === null ? state.start.seals[seal.key] : report.end.sealsStored[seal.key];
    const readyAt = report === null ? 0 : report.end.sealReadyAt[seal.key];

    const item = document.createElement('div');
    item.className = 'seal-held';
    const img = document.createElement('img');
    img.src = seal.img;
    img.alt = '';
    item.append(img, span('seal-count', String(held)));
    item.title = held === 0 ? `${seal.name}: none in storage`
      : readyAt > now ? `${seal.name}: on cooldown until tick ${readyAt}`
        : `${seal.name}: ready`;
    item.classList.toggle('seal-waiting', held > 0 && readyAt > now);
    sealStoreEl.append(item);
  }
}

/* ------------------------------ the palette ----------------------------- */

function renderTierTabs() {
  tierTabs.replaceChildren();
  for (const tier of TIERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tier-tab';
    button.textContent = `T${tier}`;
    button.title = `Tier ${tier} buildings`;
    button.disabled = tier > state.tier;
    button.setAttribute('aria-pressed', String(tier === state.buildTier));
    button.addEventListener('click', () => { state.buildTier = tier; render(); });
    tierTabs.append(button);
  }
}

function renderPalette() {
  paletteEl.replaceChildren();

  for (const building of placeableInTier(state.buildTier)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.setAttribute('aria-pressed', String(state.buildTool === building.key));

    const chip = span('swatch-chip');
    const img = document.createElement('img');
    img.src = building.img;
    img.alt = '';
    chip.append(img);

    const standing = tiles.filter((tile) => tile.building === building.key).length;
    button.append(chip, span('swatch-name', building.name),
      span('swatch-count', building.limit > 0 ? `${standing}/${building.limit}` : ''));
    button.title = building.limit > 0 ? `At most ${building.limit} per village` : building.name;

    button.addEventListener('click', () => {
      state.buildTool = state.buildTool === building.key ? null : building.key;
      state.buildOrientation = EAST;
      render();
    });
    paletteEl.append(button);
  }

  const turning = state.buildTool !== null && isRotatable(state.buildTool);
  rotateHint.hidden = !turning;
  if (turning) rotateHint.textContent = 'R rotates';

  sizePalette();
}

const PALETTE_GAP = 3;
const PALETTE_ROW_MIN = 30;

function rowsThatFit(room, count) {
  return Math.floor((room - (count - 1) * PALETTE_GAP) / count);
}

/* The palette fills the panel: its rows take whatever height is left once the
   tabs above and the seals below have had theirs, and every tier is given the
   same row height so switching tier does not resize the list. */
function sizePalette() {
  const view = document.getElementById('build-view');
  const bottom = document.getElementById('place-bottom');
  if (view.clientHeight === 0) return; // the start view is showing

  const tabs = tierTabs;
  /* Fractional heights, not offsetHeight: these boxes are not a whole number
     of pixels tall, and rounding leaves the list a pixel too tall, which clips
     what sits below it. */
  const above = tabs.getBoundingClientRect().height
    + (parseFloat(getComputedStyle(tabs).marginBottom) || 0);
  const below = bottom.getBoundingClientRect().height
    + (parseFloat(getComputedStyle(paletteEl).marginBottom) || 0);
  const room = Math.max(0, Math.floor(view.getBoundingClientRect().height - above - below));

  /* The fullest tier sets the row height, so every tier shares it and
     switching tier does not resize the list. */
  const cap = rowsThatFit(room, Math.max(...TIERS.map((tier) => placeableInTier(tier).length)));
  const row = Math.max(PALETTE_ROW_MIN, Math.min(cap, rowsThatFit(room, placeableInTier(state.buildTier).length)));

  if (paletteEl.style.height !== `${room}px`) paletteEl.style.height = `${room}px`;
  if (paletteEl.style.getPropertyValue('--palette-row') !== `${row}px`) {
    paletteEl.style.setProperty('--palette-row', `${row}px`);
  }
}

window.addEventListener('resize', sizePalette);

/* ---------------------------- the starting point ------------------------ */

function numberField(parent, label, value, least, onChange) {
  const field = document.createElement('label');
  field.className = 'field sim-field';
  field.append(span('', label));

  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(least);
  input.step = '1';
  input.value = String(value);
  input.addEventListener('change', () => {
    const typed = Number(input.value);
    onChange(Number.isFinite(typed) ? Math.max(least, typed) : least);
    run();
  });

  field.append(input);
  parent.append(field);
  return input;
}

function buildStartFields() {
  const stock = document.getElementById('start-stock');
  stock.replaceChildren();
  for (const { key, name } of RESOURCES) {
    numberField(stock, name, state.start.stock[key], 0, (value) => { state.start.stock[key] = value; });
  }

  const seals = document.getElementById('start-seals');
  seals.replaceChildren();
  for (const seal of SEALS) {
    if (seal.key === NO_SEAL) continue;
    numberField(seals, seal.name, state.start.seals[seal.key], 0, (value) => { state.start.seals[seal.key] = value; });
  }
}

/* -------------------------------- running ------------------------------- */

function applyReport(reply) {
  report = reply;

  const village = reply.village;
  for (let i = 0; i < TILE_COUNT; i += 1) {
    tiles[i] = {
      terrain: village.terrain[i],
      building: village.buildings[i],
      seal: village.seals[i],
      orientation: village.orientations[i],
      level: village.levels[i],
    };
  }
}

function run() {
  save();

  if (engine === null) {
    render();
    return;
  }

  try {
    applyReport(JSON.parse(engine.simulate(scriptText())));
  } catch (err) {
    showStatus(reason(err), true);
    report = null;
  }
  render();
}

function render() {
  renderTierTabs();
  renderPalette();
  renderGrid();
  renderRunBar();
  renderSteps();
  renderSealStore();
  renderInspector();
  renderStatsPanel(report === null ? null : report.production, state.modifiers);
  renderModifierPanel(state.modifiers);

  const cost = costOfNextPurchase();
  const wait = cost === null ? -1 : ticksUntilAffordable(cost);
  waitAffordable.disabled = wait <= 0;
  waitAffordable.title = cost === null ? ''
    : wait < 0 ? 'Storage capacity is below this cost'
      : wait === 0 ? 'Affordable now'
        : `Affordable in ${plural(wait, 'tick')}`;
}

/* ------------------------------- the engine ----------------------------- */

let engine = null;

const engineLoaded = (async () => {
  await null;
  try {
    if (typeof createEngine !== 'function') throw new Error('the page did not receive it');
    engine = attachEngine(await createEngine());
  } catch (err) {
    showStatus(`Could not load the engine: ${reason(err)}`, true);
  }
  return engine !== null;
})();

// Runs the stored run once the engine is there, which is the first the board
// hears of anything. Nothing waits on this; it is started for its effect.
void (async () => {
  await engineLoaded;
  run();
})();

/* ------------------------------ persistence ----------------------------- */

/* The script text plus the waits, which the script does not carry: the ticks
   say when each step fell, not where the waits are. Written as comments, which
   Parse::script skips. */
function storedText() {
  const waits = state.entries
    .map((entry, n) => (entry.action === WAIT ? `${n}:${entry.ticks}` : null))
    .filter((one) => one !== null);

// The text runs through build/Harness simulate exactly as it is.
  return [scriptText(state.entries.length), `# waits ${waits.join(' ')}`, `# shown ${state.shown}`].join('\n');
}

function save() {
  try {
    localStorage.setItem(STORED, storedText());
  } catch {
    // A full or disabled store loses the run, and nothing else.
  }
}

function readScript(text) {
  const lines = text.split('\n');
  const marker = lines.findIndex((line) => line.trim() === 'steps');
  if (marker < 0) throw new Error('a run needs a line reading ‘steps’');

  const settings = {};
  const layout = [];
  for (const token of lines.slice(0, marker).join(' ').split(/\s+/)) {
    if (!token) continue;
    const equals = token.indexOf('=');
    if (equals < 0) layout.push(token);
    else settings[token.slice(0, equals)] = token.slice(equals + 1);
  }

  if (layout.length !== TILE_COUNT + 1) throw new Error(`expected ${TILE_COUNT + 1} tokens, got ${layout.length}`);

  const start = freshStart(Number(settings.game) || GAMES[0].id);
  start.level = Number(layout[0]) || 1;
  start.tick = Number(settings.tick) || 0;

  start.tiles = layout.slice(1).map((token) => {
    const [terrain, building, level, ...flags] = token.split(':');
    const tile = { terrain, building, level: Number(level) || 0, orientation: EAST, seal: NO_SEAL };
    for (const flag of flags) {
      if (flag.length === 1) tile.orientation = flag;
      else tile.seal = flag;
    }
    return tile;
  });

  for (const { key } of RESOURCES) {
    const held = Number(settings[`stock.${key}`]);
    if (Number.isFinite(held)) start.stock[key] = held;
  }
  for (const seal of SEALS) {
    const held = Number(settings[`seals.${seal.key}`]);
    if (Number.isFinite(held)) start.seals[seal.key] = held;
  }

  const modifiers = { ...Object.fromEntries(GAME_MODIFIERS.map((m) => [m.id, m.neutral])), [POLITICS_ID]: NO_POLITICS };
  for (const one of GAME_MODIFIERS) {
    const written = Number(settings[one.id]);
    if (Number.isFinite(written)) modifiers[one.id] = one.percent ? written * 100 : written;
  }
  if (settings[POLITICS_ID]) modifiers[POLITICS_ID] = settings[POLITICS_ID];

  // The two lines this page writes after the steps, which the engine never sees.
  const waits = new Map();
  let shown = null;
  const stepWords = [];

  for (const line of lines.slice(marker + 1)) {
    const word = line.trim().split(/\s+/).filter(Boolean);
    if (word.length === 0) continue;

    if (word[0] === '#' && word[1] === 'waits') {
      word.splice(0, 1);
    }
    if (word[0] === '#' && word[1] === 'shown') {
      word.splice(0, 1);
    }

    if (word[0] === 'waits') {
      for (const one of word.slice(1)) {
        const [at, ticks] = one.split(':').map(Number);
        if (Number.isFinite(at) && Number.isFinite(ticks)) waits.set(at, ticks);
      }
      continue;
    }
    if (word[0] === 'shown') {
      shown = Number(word[1]);
      continue;
    }
    if (word.length >= 2) stepWords.push(word);
  }

  const at = (written) => {
    const [x, y] = written.split(',').map(Number);
    return index(x, y);
  };

  const steps = stepWords.map((word) => {
    const entry = { tick: Number(word[0]), action: word[1], orientation: EAST };

    if (entry.action === 'build') {
      entry.tile = at(word[2]);
      entry.building = word[3];
      if (word[4]) entry.orientation = word[4];
    } else if (entry.action === 'move') {
      entry.from = at(word[2]);
      entry.tile = at(word[3]);
      if (word[4]) entry.orientation = word[4];
    } else if (entry.action === 'seal') {
      entry.seal = word[2];
      entry.tile = at(word[3]);
    } else if (entry.action === 'village') {
      entry.tile = 0;
    } else {
      entry.tile = at(word[2]);
    }
    return entry;
  });

  /* The waits back among the steps. A script written for the harness records
     none, so there the ticks are turned back into them. */
  const entries = [];
  if (waits.size > 0) {
    let step = 0;
    for (let n = 0; n < steps.length + waits.size; n += 1) {
      if (waits.has(n)) entries.push({ action: WAIT, ticks: waits.get(n) });
      else if (step < steps.length) { entries.push(steps[step]); step += 1; }
    }
  } else {
    let tick = start.tick;
    for (const step of steps) {
      if (step.tick > tick) entries.push({ action: WAIT, ticks: step.tick - tick });
      tick = step.tick;
      entries.push(step);
    }
    const until = Number(settings.until);
    if (Number.isFinite(until) && until > tick) entries.push({ action: WAIT, ticks: until - tick });
  }

  return {
    game: Number(settings.game) || GAMES[0].id,
    tier: Number(settings.tier) || TIER_COUNT,
    start,
    entries,
    shown: shown === null || !Number.isFinite(shown) ? entries.length : shown,
    modifiers,
  };
}

function adopt(read) {
  state.game = read.game;
  state.tier = Math.min(Math.max(read.tier, 1), TIER_COUNT);
  state.start = read.start;
  state.entries = read.entries;
  state.shown = Math.min(Math.max(read.shown, 0), read.entries.length);
  state.modifiers = read.modifiers;
  state.selected = null;
  state.buildTool = null;
  if (state.buildTier > state.tier) state.buildTier = state.tier;
  readEffects(state.game);
  buildStartFields();
  document.getElementById('start-tick').value = String(state.start.tick);
  gameSelect.value = String(state.game);
  tierSelect.value = String(state.tier);
}

function startOver() {
  state.start = freshStart(state.game);
  state.entries = [];
  state.shown = 0;
  state.selected = null;
  state.buildTool = null;
  buildStartFields();
  document.getElementById('start-tick').value = '0';
  run();
}

/* --------------------------- the board's pointer ------------------------ */

/* A tile is a button, so it acts on click; pointer events only carry the drag.
   A drag ends with a click on the tile it started from, so a finished drag
   discards the click that follows it. */
let swallowClick = false;

gridEl.addEventListener('click', (event) => {
  if (swallowClick) {
    swallowClick = false;
    return;
  }

  const tileEl = event.target.closest('.tile');
  if (tileEl === null) return;

  const i = Number(tileEl.dataset.i);
  const anchor = occupancyMap(tiles)[i];

  if (anchor === null && state.buildTool !== null) {
    state.selected = i;
    add({ action: 'build', tile: i, building: state.buildTool, orientation: state.buildOrientation });
    return;
  }

  state.selected = i;
  render();
});

gridEl.addEventListener('pointerdown', (event) => {
  const i = tileAt(event.clientX, event.clientY);
  if (i === null || event.button !== 0) return;

  const anchor = occupancyMap(tiles)[i];
  if (anchor === null) return;

  const tile = tiles[anchor];
  const cells = footprintCells(anchor, tile.building, tile.orientation) ?? [anchor];
  drag = {
    from: anchor,
    // Which footprint cell was grabbed, so a rotation mid-drag still tracks
    // the pointer. See anchorForDrop.
    grabIndex: Math.max(0, cells.indexOf(i)),
    orientation: tile.orientation,
    over: i,
    moved: false,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
  };
});

gridEl.addEventListener('pointermove', (event) => {
  const i = tileAt(event.clientX, event.clientY);
  const wandered = i !== state.hovered;
  state.hovered = i;

  if (drag === null) {
    if (wandered && state.buildTool !== null) renderGrid();
    return;
  }

  if (!drag.moved) {
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD) return;
    drag.moved = true;
    drag.over = i;
    // Taken now, not on the press: a captured pointer sends the closing click
    // to the grid rather than to the tile.
    gridEl.setPointerCapture(drag.pointerId);
    renderGrid(); // dim the source and draw the preview at the drop target
    return;
  }

  if (i !== drag.over) {
    drag.over = i;
    renderGrid();
  }
});

function endPointer(event) {
  if (drag === null) return;
  if (drag.moved && gridEl.hasPointerCapture(drag.pointerId)) gridEl.releasePointerCapture(drag.pointerId);

  drag.over = tileAt(event.clientX, event.clientY);
  const preview = dragPreview();
  const { from, moved, orientation } = drag;
  const turned = orientation !== tiles[from].orientation;
  drag = null;

  // A press that never became a drag is a click, and selects the tile.
  if (!moved) return;
  swallowClick = true;

  if (preview === null || !preview.ok) {
    const key = tiles[from].building;
    showStatus(blockedReason(preview && preview.cells.length ? preview.cells : null, key, occupancyMap(tiles), from)
      ?? `A ${BUILDING_BY_KEY.get(key).name.toLowerCase()} doesn't fit there.`);
    render();
    return;
  }

  if (preview.anchor !== from || turned) {
    state.selected = preview.anchor;
    addMove(from, preview.anchor, orientation);
    return;
  }
  render();
}

gridEl.addEventListener('pointerup', endPointer);
gridEl.addEventListener('pointercancel', endPointer);

gridEl.addEventListener('pointerleave', () => {
  if (state.hovered === null) return;
  state.hovered = null;
  renderGrid(); // clear the ghost from the last hovered tile
});

gridEl.addEventListener('contextmenu', (event) => event.preventDefault());
gridEl.addEventListener('dragstart', (event) => event.preventDefault());

/* -------------------------------- controls ------------------------------ */

for (const game of GAMES) {
  addOption(gameSelect, String(game.id), `${game.id} · ${game.map.toLowerCase().replace(/_/g, ' ')}`);
}

for (let tier = 1; tier <= TIER_COUNT; tier += 1) {
  addOption(tierSelect, String(tier), `Tier ${tier}`, 'Nothing above the unlocked tier can be built');
}

gameSelect.addEventListener('change', () => {
  state.game = Number(gameSelect.value);
  readEffects(state.game);
  // Another round is another map, so nothing that stood can be assumed to
  // still stand on ground that holds it.
  startOver();
});

tierSelect.addEventListener('change', () => {
  state.tier = Number(tierSelect.value);
  if (state.buildTier > state.tier) state.buildTier = state.tier;
  run();
});

document.getElementById('start-tick').addEventListener('change', (event) => {
  const typed = Math.max(0, Number(event.target.value) || 0);
  state.start.tick = typed;
  event.target.value = String(typed);
  run();
});

document.getElementById('wait').addEventListener('click', () => {
  add({ action: WAIT, ticks: Math.max(1, Number(waitInput.value) || 1) });
});

waitAffordable.addEventListener('click', () => {
  const wait = ticksUntilAffordable(costOfNextPurchase() ?? {});
  if (wait <= 0) return;
  add({ action: WAIT, ticks: wait });
});

undoStep.addEventListener('click', () => {
  state.entries.pop();
  state.shown = Math.min(state.shown, state.entries.length);
  run();
});

document.getElementById('replay-start').addEventListener('click', () => goTo(0));
document.getElementById('replay-back').addEventListener('click', () => goTo(state.shown - 1));
document.getElementById('replay-forward').addEventListener('click', () => goTo(state.shown + 1));
document.getElementById('replay-end').addEventListener('click', () => goTo(state.entries.length));

document.getElementById('reset').addEventListener('click', startOver);

document.getElementById('reset-modifiers').addEventListener('click', () => {
  for (const one of GAME_MODIFIERS) state.modifiers[one.id] = one.neutral;
  state.modifiers[POLITICS_ID] = NO_POLITICS;
  run();
});

for (const tab of document.querySelectorAll('.view-tab')) {
  tab.addEventListener('click', () => {
    state.panel = tab.dataset.view;
    document.getElementById('build-view').hidden = state.panel !== 'build';
    document.getElementById('start-view').hidden = state.panel !== 'start';
    if (state.panel === 'build') sizePalette();
    for (const other of document.querySelectorAll('.view-tab')) {
      other.setAttribute('aria-pressed', String(other === tab));
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea, select')) return;

  if (event.key === 'r' || event.key === 'R') {
    /* Mid-drag the turn is part of the drag; otherwise it turns whatever is
       picked from the palette, or carries the selected building to the tile it
       already stands on, facing the other way. */
    if (drag !== null) {
      drag.orientation = rotate(tiles[drag.from].building, drag.orientation);
      renderGrid();
      return;
    }
    if (state.buildTool !== null && isRotatable(state.buildTool)) {
      state.buildOrientation = rotate(state.buildTool, state.buildOrientation);
      render();
      return;
    }
    const anchor = state.selected === null ? null : occupancyMap(tiles)[state.selected];
    if (anchor !== null && isRotatable(tiles[anchor].building)) {
      addMove(anchor, anchor, rotate(tiles[anchor].building, tiles[anchor].orientation));
    }
    return;
  }

  if (event.key === 'ArrowLeft') goTo(state.shown - 1);
  if (event.key === 'ArrowRight') goTo(state.shown + 1);

  if (event.key === 'Escape') {
    state.buildTool = null;
    state.selected = null;
    render();
  }
});

// Storage a private window or a full quota can refuse, which loses the run
// and nothing else.
function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/* A run starting from a planner layout, everything on it already standing and
   uncosted. The round is this page's: a layout carries terrain, not the round
   that costed it. */
function runFrom(layout, game = state.game) {
  return { ...readScript(`${layout} game=${game}\nsteps`), entries: [], shown: 0 };
}

// The planner's village, as a run starting from it with no steps taken.
function plannerVillage() {
  const written = readStored(PLANNER_VILLAGE);
  if (!written) throw new Error('the planner has saved nothing in this browser');

  let made = null;
  try {
    made = JSON.parse(written);
  } catch {
    made = null;
  }
  if (made === null || typeof made !== 'object' || made.v !== 1 || typeof made.layout !== 'string') {
    throw new Error('the planner has stored nothing this page can read');
  }

// The round is stored with the planner's controls, not its village.
  let view = null;
  try {
    view = JSON.parse(readStored(PLANNER_VIEW) ?? 'null');
  } catch {
    view = null;
  }
  const game = view !== null && GAME_BY_ID.has(view.game) ? view.game : state.game;

  const read = runFrom(made.layout, game);

  // The planner keeps its modifiers in the units its fields show, as this
  // page does, so they are read directly rather than through the script.
  if (made.modifiers !== null && typeof made.modifiers === 'object') {
    for (const one of GAME_MODIFIERS) {
      const value = made.modifiers[one.id];
      if (Number.isFinite(value)) read.modifiers[one.id] = value;
    }
    if (POLITICS_KEYS.has(made.modifiers[POLITICS_ID])) {
      read.modifiers[POLITICS_ID] = made.modifiers[POLITICS_ID];
    }
  }

  return read;
}

document.getElementById('import-planner').addEventListener('click', () => {
  const note = document.getElementById('import-note');
  try {
    adopt(plannerVillage());
    note.textContent = 'Loaded.';
    run();
  } catch (err) {
    note.textContent = `Could not read it: ${reason(err)}`;
  }
});


/* ------------------------------ saved runs ------------------------------ */

// This page's own saves, kept apart from the planner's layouts.
const RUNS = 'factions-solver/simulator/v1/runs';
const RUNS_MAX = 50;

const runsModal = document.getElementById('runs-modal');
const runList = document.getElementById('run-list');
const runsNote = document.getElementById('runs-note');
const runForm = document.getElementById('run-form');
const runName = document.getElementById('run-name');

function readRuns() {
  try {
    const raw = JSON.parse(readStored(RUNS));
    if (!Array.isArray(raw)) return [];
    return raw.filter((one) => one !== null && typeof one === 'object'
      && typeof one.name === 'string' && one.name !== ''
      && typeof one.run === 'string');
  } catch {
    return [];
  }
}

function writeRuns(list) {
  try {
    localStorage.setItem(RUNS, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

// Newest first, since the one just saved is the one most likely wanted.
function renderRuns() {
  const saved = readRuns();
  runList.replaceChildren();

  if (saved.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'save-empty';
    empty.textContent = 'Nothing saved yet.';
    runList.append(empty);
    return;
  }

  for (const one of saved) {
    const row = document.createElement('li');
    row.className = 'save-row';

    const name = span('save-title', one.name);
    name.title = one.name;
    const when = span('save-when', Number.isFinite(one.at) ? new Date(one.at).toLocaleDateString() : '');

    const load = document.createElement('button');
    load.type = 'button';
    load.textContent = 'Load';
    load.addEventListener('click', () => {
      try {
        adopt(readScript(one.run));
        runsModal.hidden = true;
        showStatus(`Loaded \u201c${one.name}\u201d.`);
        run();
      } catch (err) {
        runsNote.textContent = `Could not load \u201c${one.name}\u201d: ${reason(err)}`;
      }
    });

    // Two clicks to delete: a saved run cannot be recovered, and the button is
    // next to Load.
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'save-drop';
    drop.textContent = 'Delete';
    drop.addEventListener('click', () => {
      if (drop.dataset.armed !== 'yes') {
        drop.dataset.armed = 'yes';
        drop.textContent = 'Sure?';
        setTimeout(() => {
          if (!drop.isConnected) return;
          delete drop.dataset.armed;
          drop.textContent = 'Delete';
        }, 3000);
        return;
      }
      writeRuns(readRuns().filter((other) => other.name !== one.name));
      renderRuns();
      runsNote.textContent = `Deleted \u201c${one.name}\u201d.`;
    });

    row.append(name, when, load, drop);
    runList.append(row);
  }
}

runForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const name = runName.value.trim();
  if (name === '') {
    runsNote.textContent = 'Give it a name first.';
    runName.focus();
    return;
  }

  const saved = readRuns();
  const already = saved.findIndex((one) => one.name === name);
  if (already === -1 && saved.length >= RUNS_MAX) {
    runsNote.textContent = `${RUNS_MAX} saved runs is the limit. Delete one first.`;
    return;
  }

  if (already !== -1) saved.splice(already, 1);
  saved.unshift({ name, run: storedText(), at: Date.now() });

  if (!writeRuns(saved)) {
    runsNote.textContent = 'This browser would not store it. Its storage may be full.';
    return;
  }

  runName.value = '';
  renderRuns();
  runsNote.textContent = already === -1 ? `Saved \u201c${name}\u201d.` : `Replaced \u201c${name}\u201d.`;
});

document.getElementById('runs-open').addEventListener('click', () => {
  runsNote.textContent = '';
  runName.value = '';
  renderRuns();
  runsModal.hidden = false;
  runName.focus();
});

for (const close of runsModal.querySelectorAll('[data-close]')) {
  close.addEventListener('click', () => { runsModal.hidden = true; });
}

/* ---------------------------- saved villages ---------------------------- */

const savesModal = document.getElementById('saves-modal');
const saveList = document.getElementById('save-list');
const savesNote = document.getElementById('saves-note');

// The planner's saved layouts, newest first as it lists them. Read only: the
// planner owns them, so this page does not delete them.
function renderSaves() {
  const saved = readPlannerSaves();
  saveList.replaceChildren();

  if (saved.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'save-empty';
    empty.textContent = 'The planner has saved nothing in this browser.';
    saveList.append(empty);
    return;
  }

  for (const one of saved) {
    const row = document.createElement('li');
    row.className = 'save-row';

    const name = span('save-title', one.name);
    name.title = one.name;
    const when = span('save-when', Number.isFinite(one.at) ? new Date(one.at).toLocaleDateString() : '');

    const load = document.createElement('button');
    load.type = 'button';
    load.textContent = 'Load';
    load.addEventListener('click', () => {
      try {
        adopt(runFrom(one.layout));
        savesModal.hidden = true;
        showStatus(`Loaded \u201c${one.name}\u201d.`);
        run();
      } catch (err) {
        savesNote.textContent = `Could not load \u201c${one.name}\u201d: ${reason(err)}`;
      }
    });

    row.append(name, when, load);
    saveList.append(row);
  }
}

document.getElementById('saves-open').addEventListener('click', () => {
  savesNote.textContent = '';
  renderSaves();
  savesModal.hidden = false;
});

for (const close of savesModal.querySelectorAll('[data-close]')) {
  close.addEventListener('click', () => { savesModal.hidden = true; });
}

/* ------------------------------ export/import --------------------------- */

const shareModal = document.getElementById('share-modal');
const shareText = document.getElementById('share-text');
const shareNote = document.getElementById('share-note');

function closeShare() {
  shareModal.hidden = true;
}

// A run travels as base64 of the same {v, ...} envelope the planner exports,
// so what is pasted about is one unbroken token.
function exportText() {
  return toBase64(JSON.stringify({ v: 1, run: storedText() }));
}

// Either the exported token or the script text itself, so what
// build/Harness simulate reads can be pasted straight in.
function importText(text) {
  const written = String(text).trim();
  if (!written) throw new Error('Nothing to import. Paste an exported run first.');

  if (written.includes('\n') || written.includes(' ')) return readScript(written);

  let payload = null;
  try {
    payload = JSON.parse(fromBase64(written));
  } catch {
    throw new Error('That does not look like an exported run.');
  }
  if (payload === null || typeof payload !== 'object' || payload.v !== 1 || typeof payload.run !== 'string') {
    throw new Error('That does not look like an exported run.');
  }
  return readScript(payload.run);
}

document.getElementById('share-open').addEventListener('click', () => {
  shareModal.hidden = false;
  shareText.value = exportText();
  shareNote.textContent = '';
});

for (const close of shareModal.querySelectorAll('[data-close]')) close.addEventListener('click', closeShare);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!shareModal.hidden) closeShare();
  if (!savesModal.hidden) savesModal.hidden = true;
  if (!runsModal.hidden) runsModal.hidden = true;
});

document.getElementById('share-export').addEventListener('click', () => {
  shareText.value = exportText();
  shareText.select();
  shareNote.textContent = `${shareText.value.length} characters, ready to copy.`;
});

document.getElementById('share-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareText.value);
    shareNote.textContent = 'Copied.';
  } catch (err) {
    shareNote.textContent = `Could not copy: ${reason(err)}`;
  }
});

document.getElementById('share-import').addEventListener('click', () => {
  try {
    adopt(importText(shareText.value));
    run();
    shareNote.textContent = 'Read in.';
  } catch (err) {
    shareNote.textContent = `Could not read it: ${reason(err)}`;
  }
});

/* ------------------------------- startup -------------------------------- */

document.getElementById('view-help').title = 'Build: the palette and the seals held.'
  + ' Start: the tick the run begins at, what is stored then, and the seals owned.';

state.start = freshStart(state.game);
readEffects(state.game);
gameSelect.value = String(state.game);
tierSelect.value = String(state.tier);
buildRunBar();
buildStatsPanel();
buildModifierPanel(state.modifiers, run);
buildStartFields();

try {
  const last = readStored(STORED);
  if (last) adopt(readScript(last));
} catch (err) {
  showStatus(`Could not reopen the last run: ${reason(err)}`, true);
  state.start = freshStart(state.game);
  state.entries = [];
  state.shown = 0;
}

render();
