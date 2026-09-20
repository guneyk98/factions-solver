'use strict';

/* The planner: the board, the build menu and the rearrange search. What the
   simulator page needs too is in common.js, which the page loads first. */

const DRAG_THRESHOLD = 4;

/* The user's own work: the village and the game it belongs to. This key is
   never versioned. Bumping a key discards everything stored under it, and a
   change to how a setting is read must never discard a village, which is what
   happened when `budget` changed meaning. */
const VILLAGE = 'factions-solver/v2';

/* The state of the controls. Versioned, because a setting can change meaning
   and the stored value must then be discarded. Losing this costs panel state
   rather than a village, which is why it is a separate key. */
const VIEW = 'factions-solver/view/v1';

const UNDO_HISTORY = 'factions-solver/v1/undo-history';
const UNDO_HISTORY_MAX = 60;


const state = {
  game: GAMES[0].id,
  // The season index to cost against, or null to follow the clock. Setting it
  // prices the village at a chosen season's multiplier.
  season: null,
  villageLevel: 5,
  // What a terraformed tile scales its terrain effects by: the fertile
  // grounds perk, 1 + 0.05 a point. grid.terrainBonusFactor in the api.
  terrainBonusFactor: 1,
  tiles: [],
  panel: 'place',
  mode: 'build',
  buildTier: 1,
  buildTool: null,
  buildOrientation: EAST,
  buildLevel: MIN_BUILDING_LEVEL,
  terrainTool: 'PLAINS',
  selected: null,
  hovered: null,
  result: null,
  showOutput: true,
  modifiers: {
    ...Object.fromEntries(GAME_MODIFIERS.map((m) => [m.id, m.neutral])),
    [POLITICS_ID]: NO_POLITICS,
  },
  goals: [...GOAL_ORDER],
  soldierMode: SOLDIER_MODES[0].key,
  workerMode: WORKER_MODES[0].key,
  unit: UNIT_READINGS[0].key,
  marketGoals: false,
  /* Whether the search may terraform the tiles a building stands on, and how
     many tiles it may terraform: `tiles` when counted, unbounded when
     unlimited. */
  terraform: { allowed: false, tiles: 6, unlimited: false },
  effort: 'normal',
  customEffort: { ...EFFORTS.normal },
  balance: false,
  weights: Object.fromEntries(OBJECTIVES.map((o) => [o.id, 1])),
};

let drag = null;
let painting = false;
let saveTimer = null;

// The layout restored from storage, held until the engine is ready to parse it.
let savedLayout = null;

const startingGround = terrainRows(GAME_BY_ID.get(state.game) ?? GAMES[0]);
for (let y = 0; y < HEIGHT; y += 1) {
  for (let x = 0; x < WIDTH; x += 1) {
    state.tiles.push({ terrain: startingGround[y][x], building: EMPTY, level: 0, orientation: EAST, seal: NO_SEAL, terraformed: false });
  }
}
/* A village starts as its centre on otherwise bare ground, placed on the
   first buildable tile rather than a fixed one: the centre of one round's map
   is sea in the next, and a centre on unbuildable terrain is a village the
   engine rejects, leaving the page with nothing computed. */
setBuilding(state.tiles.findIndex((tile) => !UNBUILDABLE.has(tile.terrain)), CENTRE, state.villageLevel);


function setBuilding(i, key, level, orientation = EAST, seal = NO_SEAL) {
  const tile = state.tiles[i];
  tile.building = key;
  tile.level = key === EMPTY ? 0 : level;
  tile.orientation = orientation;
  tile.seal = sealable(key) ? seal : NO_SEAL;
}

function buildable(i) {
  return !UNBUILDABLE.has(state.tiles[i].terrain);
}

/* Terrain can change under a building, by loading another round's map or by
   painting. The building stays and is marked rather than removed, since only
   the user knows what they intended. The engine rejects such a village, so
   every quantity reads N/A until the building is moved. */
function strandedCells() {
  const stranded = new Set();

  for (let i = 0; i < TILE_COUNT; i += 1) {
    if (state.tiles[i].building === EMPTY) continue;

    const cells = footprintCells(i, state.tiles[i].building, state.tiles[i].orientation) ?? [i];
    if (cells.some((cell) => !buildable(cell))) {
      for (const cell of cells) stranded.add(cell);
    }
  }
  return stranded;
}

function anythingStranded() {
  return strandedCells().size > 0;
}














function centreIndex() {
  return state.tiles.findIndex((tile) => tile.building === CENTRE);
}

function slotsUsed() {
  return state.tiles.reduce(
    (n, tile) => n + (BUILDING_BY_KEY.get(tile.building)?.slots ?? 0),
    0,
  );
}

function buildingCap() {
  return state.villageLevel;
}

function builtCount(key) {
  return state.tiles.reduce((n, tile) => n + (tile.building === key ? 1 : 0), 0);
}

function atLimit(key) {
  const info = BUILDING_BY_KEY.get(key);
  return info.limit > 0 && builtCount(key) >= info.limit;
}

// Also called with null: the palette holds a level before a building is picked.
function levelCap(key) {
  return BUILDING_BY_KEY.get(key)?.maxLevel ?? MAX_LEVEL;
}

function placementLevel(key) {
  return Math.min(state.buildLevel, levelCap(key));
}

function setVillageLevel(value) {
  const floor = Math.max(MIN_VILLAGE_LEVEL, slotsUsed());
  const wanted = clampLevel(value);
  const next = Math.max(floor, wanted);

  if (wanted >= MIN_VILLAGE_LEVEL && wanted < floor) {
    showStatus(`Village level ${wanted} only supports ${plural(wanted, 'building')}. Remove some first.`);
  }

  state.villageLevel = next;
  const centre = centreIndex();
  if (centre >= 0) state.tiles[centre].level = next;
  return next;
}

/* ------------------------------ elements ------------------------------ */

const gridEl = document.getElementById('grid');
const statusEl = document.getElementById('status');
const emptyEl = document.getElementById('insp-empty');
const bodyEl = document.getElementById('insp-body');
const basicsEl = document.getElementById('insp-basics');
const detailEl = document.getElementById('insp-detail');
const levelEl = document.getElementById('insp-level');
const levelInput = document.getElementById('tile-level');
const levelHintEl = document.getElementById('level-hint');
const villageLevelInput = document.getElementById('village-level');
const terrainBonusInput = document.getElementById('terrain-bonus');
const countEl = document.getElementById('building-count');
const terrainToggle = document.getElementById('terrain-toggle');
const terrainPalette = document.getElementById('terrain-palette');
const paintHint = document.getElementById('paint-hint');
const tierTabs = document.getElementById('tier-tabs');
const rotateHintEl = document.getElementById('rotate-hint');
const buildLevelField = document.getElementById('build-level-field');
const buildLevelInput = document.getElementById('build-level');
const sealPickerEl = document.getElementById('insp-seals');
const sealNoteEl = document.getElementById('seal-note');
const placeView = document.getElementById('place-view');
const solveView = document.getElementById('solve-view');
const viewHelp = document.getElementById('view-help');
const undoButton = document.getElementById('undo');
const redoButton = document.getElementById('redo');
const historyStep = document.getElementById('history-step');

buildStatsPanel();
const restored = restoreFromStorage();
readEffects(state.game);
setTerrainFromGame(state.game);
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

  const yield_ = span('yield');
  const level = span('level');

  el.append(frame, yield_, level);
  gridEl.append(el);
  tileEls.push({ el, frame, img, seal, level, yield: yield_ });
}

/* ------------------------------ rendering ------------------------------ */






function hoverPreview(occupancy) {
  if (drag !== null || painting) return null;
  if (state.mode !== 'build' || state.buildTool === null) return null;

  const i = state.hovered;
  if (i === null || occupancy[i] !== null) return null;

  const key = state.buildTool;
  const cells = footprintCells(i, key, state.buildOrientation);
  const ok = cells !== null
    && blockedReason(cells, key, occupancy) === null
    && slotsUsed() + BUILDING_BY_KEY.get(key).slots <= buildingCap()
    && !atLimit(key);

  return {
    anchor: i,
    cells: cells ?? [i],
    ok,
    swapWith: null,
    key,
    level: placementLevel(key),
    orientation: state.buildOrientation,
  };
}

function renderGrid() {
  const tiles = state.result ? state.result.tiles : null;
  const terrainMode = state.mode === 'terrain';
  const adrift = strandedCells();
  const occupancy = occupancyMap(state.tiles);
  const preview = dragPreview() ?? hoverPreview(occupancy);
  const previewCells = preview ? new Set(preview.cells) : null;
  const dragging = drag !== null && drag.moved;
  const draggedFrom = dragging ? drag.from : null;
  const draggedCells = dragging
    ? new Set(footprintCells(drag.from, state.tiles[drag.from].building, state.tiles[drag.from].orientation) ?? [drag.from])
    : null;
  // Selecting one tile of a building selects every tile of it; bare ground
  // selects only itself, having no footprint.
  const selectedAnchor = state.selected === null ? null : occupancy[state.selected];

  for (let i = 0; i < TILE_COUNT; i += 1) {
    const tile = state.tiles[i];
    const view = tileEls[i];
    const el = view.el;
    const anchor = occupancy[i];
    const isAnchor = anchor === i;

    applyTerrain(el, tile.terrain, terrainMask(state.tiles, i));
    el.classList.toggle('selected', selectedAnchor === null ? state.selected === i : anchor === selectedAnchor);

    el.classList.toggle('drag-source', dragging && draggedCells.has(i));
    el.classList.toggle('drop-ok', previewCells !== null && previewCells.has(i) && preview.ok);
    el.classList.toggle('drop-bad', previewCells !== null && previewCells.has(i) && !preview.ok);
    el.classList.toggle('no-build', !terrainMode && !buildable(i));
    el.classList.toggle('stranded', adrift.has(i));
    el.classList.toggle('grabbable', !terrainMode && anchor !== null);
    el.classList.toggle('terrain-mode', terrainMode);

    const ghosting = preview !== null && preview.anchor === i
      && (!isAnchor || i === draggedFrom);
    const spanningKey = ghosting ? preview.key : (isAnchor ? tile.building : EMPTY);
    const spans = ghosting ? preview.cells.length > 1 : isAnchor && isMultiTile(tile.building);
    const facing = ghosting ? preview.orientation : tile.orientation;
    const spanShape = shapeOf(spanningKey);
    el.classList.toggle('spanning', spans);
    view.frame.classList.toggle('span-h', spans && spanShape === 'line' && facing !== SOUTH);
    view.frame.classList.toggle('span-v', spans && spanShape === 'line' && facing === SOUTH);
    // A Square's four tiles share a centre point, so the frame is stretched
    // over the 2x2 block and the icon is drawn there. An LShape has no such
    // point (the centre of its bounding box is the one tile it does not
    // cover), so its icon stays on the anchor, the corner tile.
    view.frame.classList.toggle('span-block', spans && spanShape === 'square');
    // An LShape covers three tiles of a 2x2 block, and which three depends on
    // the orientation, so the frame reads both shape and orientation.
    const bent = spans && spanShape === 'l';
    view.frame.classList.toggle('span-l', bent);
    for (const one of SCHEMA.orientations)
      view.frame.classList.toggle(`l-${one}`, bent && facing === one);
    view.img.classList.toggle('ghost', ghosting);
    view.img.classList.toggle('ghost-bad', ghosting && !preview.ok);

    const src = terrainMode ? null
      : ghosting ? buildingImage(preview.key, preview.level)
        : (isAnchor ? buildingImage(tile.building, tile.level) : null);
    if (src) {
      if (view.img.getAttribute('src') !== src) view.img.setAttribute('src', src);
      view.img.hidden = false;
    } else {
      view.img.hidden = true;
    }

    view.level.textContent = !terrainMode && anchor !== null && levelCell(state.tiles, anchor) === i
      ? String(state.tiles[anchor].level)
      : '';

    const ghostFrame = dragging && ghosting;
    const framed = terrainMode ? null : (ghostFrame ? preview.key : (isAnchor ? tile.building : null));
    view.frame.classList.toggle('ghost', ghostFrame);
    view.frame.classList.toggle('ghost-bad', ghostFrame && !preview.ok);

    const frameImg = framed === null ? null : TYPE_BY_KEY.get(BUILDING_BY_KEY.get(framed).type).img;
    // Read by the frame element, and by the two arms of an LShape's frame.
    const source = frameImg === null ? 'none' : `url("${frameImg}")`;
    if (view.frame.style.getPropertyValue('--frame-src') !== source)
      view.frame.style.setProperty('--frame-src', source);

    const sealImg = !terrainMode && isAnchor ? SEAL_BY_KEY.get(tile.seal).img : null;
    if (sealImg) {
      if (view.seal.getAttribute('src') !== sealImg) view.seal.setAttribute('src', sealImg);
      view.seal.hidden = false;
    } else {
      view.seal.hidden = true;
    }

    const badges = [];
    if (state.showOutput && tiles && !terrainMode) {
      for (const { key, cls } of RESOURCES) {
        if (tiles.production[key][i] > 0) badges.push(`<span class="${cls}">${fmt(tiles.production[key][i])}</span>`);
      }
      for (const { key, cls } of RESOURCES) {
        if (tiles.storage[key][i] > 0) badges.push(`<span class="${cls} cap">+${fmtStoreShort(tiles.storage[key][i])}</span>`);
      }
    }
    view.yield.innerHTML = badges.join('<br>');

    const terrainName = TERRAIN_BY_KEY.get(tile.terrain).name;
    if (anchor === null) {
      el.title = terrainName;
    } else {
      const owner = state.tiles[anchor];
      const seal = owner.seal === NO_SEAL ? '' : ` + ${SEAL_BY_KEY.get(owner.seal).name.toLowerCase()}`;
      el.title = `${terrainName}, ${BUILDING_BY_KEY.get(owner.building).name} lv${owner.level}${seal}`;
    }
  }
}

function renderHeader() {
  const used = slotsUsed();
  countEl.textContent = `${used} / ${buildingCap()}`;
  countEl.classList.toggle('at-cap', used >= buildingCap());

  villageLevelInput.min = String(Math.max(MIN_VILLAGE_LEVEL, used));
  if (document.activeElement !== villageLevelInput
    || Number(villageLevelInput.value) !== state.villageLevel) {
    villageLevelInput.value = String(state.villageLevel);
  }

  // entered as the percentage it adds, held as the factor
  const percent = Math.round((state.terrainBonusFactor - 1) * 100);
  if (document.activeElement !== terrainBonusInput || Number(terrainBonusInput.value) !== percent) {
    terrainBonusInput.value = String(percent);
  }
  terrainBonusInput.classList.toggle('modifier-on', percent !== 0);
}

let noticeTimer = null;

function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
  clearTimeout(noticeTimer);
  if (message && !isError) noticeTimer = setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

let inspected = null;
let inspectedAnchor = null;

/* Leaving the grid clears the hover, which would take the tile out from under
   the inspector's own controls, so the panel holds the tile it is showing
   while the pointer is over it, as it does while its level field has focus. */
let pointerOverInspector = false;
const inspectorEl = document.querySelector('.inspector');

inspectorEl.addEventListener('pointerenter', () => { pointerOverInspector = true; });
inspectorEl.addEventListener('pointerleave', () => {
  pointerOverInspector = false;
  renderInspector();
});

function renderInspector() {
  const editing = document.activeElement === levelInput;
  const holding = editing || pointerOverInspector;
  const i = holding ? inspected : (state.hovered !== null ? state.hovered : state.selected);
  inspected = i;

  emptyEl.hidden = i !== null;
  bodyEl.hidden = i === null;
  if (i === null) return;

  const anchor = occupancyMap(state.tiles)[i];
  inspectedAnchor = anchor;

  const tile = state.tiles[i];
  const owner = anchor === null ? null : state.tiles[anchor];
  const [x, y] = [i % WIDTH, Math.floor(i / WIDTH)];
  const terrain = TERRAIN_BY_KEY.get(tile.terrain);
  const info = owner === null ? null : BUILDING_BY_KEY.get(owner.building);

  // The terrain and the coordinates: a swatch and a corner label rather than
  // list rows, since both are recognisable at a glance.
  const picture = info === null
    ? `<span class="tile-none">${buildable(i) ? '' : 'no build'}</span>`
    : `<img class="tile-art" src="${buildingImage(owner.building, owner.level)}"
         alt="${info.name}" title="${info.name}">`;

  // A terraform only ever swaps one buildable ground for another.
  const terraformable = buildable(i);
  const terraformed = tile.terraformed === true;
  const mark = terraformable
    ? `<button type="button" class="tile-terraformed${terraformed ? ' on' : ''}" data-terraform="${i}"
         aria-pressed="${terraformed}"
         title="Terraformed ground: its terrain bonuses are worth the fertile grounds perk more">terraformed</button>`
    : '';

  basicsEl.innerHTML = `<span class="tile-ground ${terrain.key}">${terrain.name}</span>`
    + mark
    + `<span class="tile-where">${x}, ${y}</span>`
    + `<span class="tile-face">${picture}</span>`;

  const isCentre = owner !== null && owner.building === CENTRE;
  const cap = owner === null || isCentre ? MAX_LEVEL : levelCap(owner.building);
  levelEl.hidden = owner === null;
  levelInput.min = String(isCentre ? Math.max(MIN_VILLAGE_LEVEL, slotsUsed()) : MIN_BUILDING_LEVEL);
  levelInput.max = String(cap);
  levelHintEl.textContent = isCentre ? 'village level' : 'level';
  if (!editing) levelInput.value = String(isCentre ? state.villageLevel : (owner?.level ?? 0));

  const takesSeal = owner !== null && sealable(owner.building);
  sealPickerEl.hidden = owner === null;
  if (owner !== null) {
    sealPickerEl.classList.toggle('no-seal', !takesSeal);
    sealPickerEl.querySelectorAll('.seal-swatch').forEach((btn) => {
      const fits = sealFits(btn.dataset.seal, owner.building);
      btn.disabled = !fits;
      btn.title = fits
        ? SEAL_BY_KEY.get(btn.dataset.seal).name
        : `${SEAL_BY_KEY.get(btn.dataset.seal).name}: not for a ${info.name.toLowerCase()}`;
      btn.setAttribute('aria-pressed', takesSeal && btn.dataset.seal === owner.seal ? 'true' : 'false');
    });

    // What the seal on this tile does, or why the tile takes none. A seal the
    // building does not fit is still displayed: a village imported from the
    // game is shown as the game reports it, whatever this page would allow.
    const { note } = SEAL_BY_KEY.get(owner.seal);
    const reason = takesSeal ? note : `A ${info.name.toLowerCase()} takes no seal.`;
    sealNoteEl.hidden = reason === null;
    sealNoteEl.innerHTML = reason ?? '';
  }

  detailEl.innerHTML = tileDetail(
    { tiles: state.tiles, result: state.result, terrainBonusFactor: state.terrainBonusFactor }, i, anchor,
  );
}

function render() {
  renderHeader();
  renderGrid();
  renderStatsPanel(state.result, state.modifiers);
  renderInspector();
  renderPaletteLimits();
  renderModifierPanel(state.modifiers);

  /* Last, because the hints under the list are shown and hidden above: a
     two-tile building adds one, and the list has to give up the room for it
     rather than push the rest of the column past the bottom. */
  sizePalette();
}

levelInput.addEventListener('input', () => {
  if (inspectedAnchor === null) return;
  if (state.tiles[inspectedAnchor].building === CENTRE) {
    setVillageLevel(Number(levelInput.value));
    renderHeader();
  } else {
    const tile = state.tiles[inspectedAnchor];
    tile.level = clampBuildingLevel(Number(levelInput.value), tile.building);
  }
  renderGrid();
  recompute();
});

levelEl.querySelectorAll('[data-step]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (inspectedAnchor !== null) adjustLevel(inspectedAnchor, Number(btn.dataset.step));
  });
});

/* ------------------------------ seals ------------------------------ */

function buildSealPicker() {
  const container = document.getElementById('seal-buttons');
  for (const seal of SEALS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seal-swatch';
    btn.dataset.seal = seal.key;
    btn.title = seal.name;

    if (seal.img) {
      const img = document.createElement('img');
      img.src = seal.img;
      img.alt = seal.name;
      btn.append(img);
    } else {
      btn.textContent = '—';
    }

    btn.addEventListener('click', () => setSeal(seal.key));
    container.append(btn);
  }
}

function setSeal(key) {
  if (inspectedAnchor === null) return;
  const tile = state.tiles[inspectedAnchor];
  if (!sealFits(key, tile.building) || tile.seal === key) return;
  tile.seal = key;
  render();
  recompute();
}

buildSealPicker();

/* --------------------------- game modifiers --------------------------- */


buildModifierPanel(state.modifiers, recompute);

document.getElementById('reset-modifiers').addEventListener('click', () => {
  for (const { id, neutral } of GAME_MODIFIERS) {
    state.modifiers[id] = neutral;
    modifierInputs.get(id).value = String(neutral);
  }
  state.modifiers[POLITICS_ID] = NO_POLITICS;
  renderModifierPanel(state.modifiers);
  recompute();
});

/* ------------------------------ palette ------------------------------ */

function buildPalette(containerId, items, kind) {
  const container = document.getElementById(containerId);
  items.forEach((item, n) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.dataset.kind = kind;
    btn.dataset.key = item.key;
    if (item.tier !== null && item.tier !== undefined) btn.dataset.tier = String(item.tier);

    const chip = span('swatch-chip');
    if (kind === 'terrain') {
      chip.classList.add('tiled');
      applyTerrain(chip, item.key, MASK_SURROUNDED);
    } else {
      const img = document.createElement('img');
      img.src = item.img;
      img.alt = '';
      chip.append(img);
    }

    const shortcut = kind === 'terrain' && n < 9 ? String(n + 1) : '';
    btn.append(chip, span('swatch-name', item.name), span('swatch-count'), span('swatch-key', shortcut));

    btn.addEventListener('click', () => {
      const off = kind === 'building' && state.buildTool === item.key;
      selectTool(kind, off ? null : item.key);
    });
    container.append(btn);
  });
}

function selectTool(kind, key) {
  if (kind === 'terrain') state.terrainTool = key;
  else state.buildTool = key;

  document.querySelectorAll('.swatch').forEach((btn) => {
    const active = btn.dataset.kind === kind && btn.dataset.key === key;
    if (btn.dataset.kind === kind) btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  if (kind === 'building') {
    renderPaletteOrientation();
    renderPaletteLevel();
    renderGrid(); // the hover ghost follows the selected building, or clears
    sizePalette(); // a multi-tile building adds a hint below the list
  }
  saveSoon(); // selecting a tool triggers no recompute, so it saves on its own
}

function renderPaletteLimits() {
  document.querySelectorAll('#building-palette .swatch').forEach((btn) => {
    const info = BUILDING_BY_KEY.get(btn.dataset.key);
    const full = atLimit(info.key);
    btn.querySelector('.swatch-count').textContent = info.limit > 0
      ? `${builtCount(info.key)}/${info.limit}`
      : '';
    btn.classList.toggle('at-limit', full);
    btn.title = info.limit > 0 ? `At most ${info.limit} per village` : '';
  });
}

// A Line is described by its axis, an LShape by the pair of arms it has,
// there being no icon for either.
const LINE_FACING = { [EAST]: 'horizontal', [SOUTH]: 'vertical' };
const L_FACING = {
  [EAST]: 'right + down', [SOUTH]: 'down + left', [WEST]: 'left + up', [NORTH]: 'up + right',
};

function orientationLabel(key, orientation) {
  return (shapeOf(key) === 'line' ? LINE_FACING : L_FACING)[orientation] ?? '';
}

function renderPaletteOrientation() {
  const rotatable = isRotatable(state.buildTool) && state.mode !== 'terrain';

  // Written whether or not it is visible, so measuring it while hidden gives
  // the height it will occupy once shown.
  const facing = orientationLabel(state.buildTool, state.buildOrientation);
  rotateHintEl.innerHTML = `Placing <strong>${facing}</strong>. Press <kbd>R</kbd> to rotate.`;
  rotateHintEl.hidden = !rotatable;
}

function renderPaletteLevel() {
  const key = state.buildTool;
  const armed = key !== null && state.mode !== 'terrain';
  buildLevelField.hidden = !armed;
  if (!armed) return;

  // A building capped at level 1 disables the field rather than explaining.
  const cap = levelCap(key);
  buildLevelInput.max = String(cap);
  buildLevelInput.disabled = cap < MAX_LEVEL;

  const shown = String(placementLevel(key));
  if (buildLevelInput.value !== shown) buildLevelInput.value = shown;
}

function setBuildLevel(value) {
  state.buildLevel = clampBuildingLevel(value, null);
  renderPaletteLevel();
  saveSoon();
}

buildLevelInput.addEventListener('input', () => {
  const typed = Number(buildLevelInput.value);
  if (buildLevelInput.value !== '' && Number.isFinite(typed)) setBuildLevel(typed);
});
buildLevelInput.addEventListener('change', () => setBuildLevel(Number(buildLevelInput.value)));
buildLevelInput.addEventListener('wheel', (event) => {
  if (buildLevelInput.disabled) return;
  event.preventDefault();
  setBuildLevel(state.buildLevel + (event.deltaY < 0 ? 1 : -1));
}, { passive: false });

function buildTierTabs() {
  const container = document.getElementById('tier-tabs');
  for (const tier of TIERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tier-tab';
    btn.dataset.tier = String(tier);
    btn.textContent = `T${tier}`;
    btn.title = `Tier ${tier} buildings`;
    btn.addEventListener('click', () => showTier(tier));
    container.append(btn);
  }
}

function showTier(tier) {
  state.buildTier = tier;

  let shown = 0;
  document.querySelectorAll('#building-palette .swatch').forEach((btn) => {
    const visible = Number(btn.dataset.tier) === tier;
    btn.hidden = !visible;
    if (visible) shown += 1;
    btn.querySelector('.swatch-key').textContent = visible && shown <= 9 ? String(shown) : '';
  });

  document.querySelectorAll('.tier-tab').forEach((btn) => {
    btn.setAttribute('aria-pressed', Number(btn.dataset.tier) === tier ? 'true' : 'false');
  });

  const tools = placeableInTier(tier);
  if (state.buildTool !== null && !tools.some((b) => b.key === state.buildTool)) {
    selectTool('building', tools[0].key);
  }
  sizePalette(); // row height depends on how many buildings this tier holds
  saveSoon();
}

const buildingPalette = document.getElementById('building-palette');
const PALETTE_GAP = 3;

/* The controls below the list are pinned to the bottom of the column and the
   list takes the remaining height.

   Row height is the largest at which the fullest tier still fits the column at
   its roomiest, with nothing selected; that is the cap. Tiers with fewer
   buildings never exceed it, so selecting a building, which adds a line or two
   below the list, does not shrink their rows: they have spare height. The
   fullest tier has none, so only it gives way.

   Which tier is fullest is computed rather than hard-coded, so moving a
   building between tiers needs no change here. */
function roomForList(list, bottom) {
  const view = document.getElementById('place-view');
  const tabs = document.getElementById('tier-tabs');

  /* Fractional heights, not offsetHeight: these boxes are not a whole number
     of pixels tall, and rounding leaves the list one pixel too tall, which
     clips the bottom of the button below it. */
  const above = tabs.hidden ? 0 : tabs.getBoundingClientRect().height
    + (parseFloat(getComputedStyle(tabs).marginBottom) || 0);
  const below = bottom + (parseFloat(getComputedStyle(list).marginBottom) || 0);
  return Math.max(0, Math.floor(view.getBoundingClientRect().height - above - below));
}

function rowsThatFit(room, count) {
  return Math.floor((room - (count - 1) * PALETTE_GAP) / count);
}

function sizePalette() {
  const view = document.getElementById('place-view');
  const bottom = document.getElementById('place-bottom');
  if (view.clientHeight === 0) return; // the solve view is showing

  // Whichever of the two lists is visible takes the space.
  const list = state.mode === 'terrain' ? terrainPalette : buildingPalette;

  // The minimum height of the controls below the list gives the maximum
  // height of the list, and so the maximum row height.
  const showing = [buildLevelField, rotateHintEl].filter((one) => !one.hidden);
  for (const one of showing) one.hidden = true;
  const cap = rowsThatFit(roomForList(list, bottom.getBoundingClientRect().height),
    Math.max(...TIERS.map((tier) => placeableInTier(tier).length)));
  for (const one of showing) one.hidden = false;

  const room = roomForList(list, bottom.getBoundingClientRect().height);
  const count = state.mode === 'terrain' ? TERRAINS.length : placeableInTier(state.buildTier).length;
  const row = Math.max(30, Math.min(cap, rowsThatFit(room, count)));

  if (list.style.height !== `${room}px`) list.style.height = `${room}px`;
  if (list.style.getPropertyValue('--palette-row') !== `${row}px`) {
    list.style.setProperty('--palette-row', `${row}px`);
  }
}

buildPalette('building-palette', PLACEABLE, 'building');
buildPalette('terrain-palette', TERRAINS, 'terrain');
buildTierTabs();
showTier(state.buildTier);
sizePalette();
window.addEventListener('resize', sizePalette);
selectTool('building', state.buildTool);
selectTool('terrain', state.terrainTool);

/* Terrain painting and building placement are separate modes, and the column
   shows one at a time: the terrain palette replaces the building palette, and
   the button that switches between them stays at the bottom of the column. */
function setMode(mode) {
  state.mode = mode;
  const terrainOn = mode === 'terrain';

  terrainToggle.setAttribute('aria-pressed', terrainOn ? 'true' : 'false');
  terrainToggle.textContent = terrainOn ? 'Done editing terrain' : 'Edit terrain';

  tierTabs.hidden = terrainOn;
  buildingPalette.hidden = terrainOn;
  terrainPalette.hidden = !terrainOn;
  paintHint.hidden = !terrainOn;

  renderGrid();
  renderPaletteLevel(); // no building is selected, so the level field hides
  sizePalette();
  saveSoon();
}

terrainToggle.addEventListener('click', () => {
  setMode(state.mode === 'terrain' ? 'build' : 'terrain');
});

/* --------------------------- views and help --------------------------- */

function showView(name) {
  state.panel = name === 'solve' ? 'solve' : 'place';
  placeView.hidden = state.panel !== 'place';
  solveView.hidden = state.panel !== 'solve';

  document.querySelectorAll('.view-tab').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.view === state.panel ? 'true' : 'false');
  });

  if (state.panel === 'solve' && state.mode === 'terrain') setMode('build');
  // The palette can only be measured while it is displayed.
  if (state.panel === 'place') sizePalette();
  renderHelp();
  saveSoon();
}

document.querySelectorAll('.view-tab').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

const PLACING_HELP = 'Click to place, drag to move, right-click to remove. '
  + 'Esc puts the building down.\n\nWheel over a tile changes its level. G paints terrain.';

const SEARCH_HELP = 'Rearranges the buildings and seals you have. Nothing is built, removed '
  + 'or levelled. Undo/redo steps between before and after.';

function renderHelp() {
  viewHelp.title = state.panel === 'solve' ? `${goalHelp()}\n\n${SEARCH_HELP}` : PLACING_HELP;
}

/* ------------------------------ editing ------------------------------ */

function clampLevel(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_LEVEL, Math.round(value)));
}

function clampBuildingLevel(value, key) {
  if (!Number.isFinite(value)) return MIN_BUILDING_LEVEL;
  return Math.max(MIN_BUILDING_LEVEL, Math.min(levelCap(key), Math.round(value)));
}

function adjustLevel(i, delta) {
  const tile = state.tiles[i];
  if (tile.building === EMPTY) return;

  if (tile.building === CENTRE) {
    const before = state.villageLevel;
    setVillageLevel(before + delta);
    if (state.villageLevel !== before) {
      render();
      recompute();
    }
    return;
  }

  const next = clampBuildingLevel(tile.level + delta, tile.building);
  if (next === tile.level) return;
  tile.level = next;
  render();
  recompute();
}

function blockedReason(cells, key, occupancy, ignoreAnchor = null) {
  const name = BUILDING_BY_KEY.get(key).name.toLowerCase();
  if (!cells) return `A ${name} doesn't fit there.`;

  for (const cell of cells) {
    if (!buildable(cell)) {
      return `Nothing can be built on ${TERRAIN_BY_KEY.get(state.tiles[cell].terrain).name.toLowerCase()}.`;
    }
    const occupant = occupancy[cell];
    if (occupant !== null && occupant !== ignoreAnchor) return `A ${name} doesn't fit there.`;
  }
  return null;
}

function placeBuilding(i) {
  if (state.buildTool === null) return false; // no building selected: the click only selects

  const occupancy = occupancyMap(state.tiles);
  if (occupancy[i] !== null) return false; // clicking an occupied tile places nothing

  const key = state.buildTool;
  const info = BUILDING_BY_KEY.get(key);
  const cells = footprintCells(i, key, state.buildOrientation);

  const blocked = blockedReason(cells, key, occupancy);
  if (blocked) {
    showStatus(blocked);
    return false;
  }

  if (slotsUsed() + info.slots > buildingCap()) {
    showStatus(`A ${info.name.toLowerCase()} needs ${plural(info.slots, 'slot')}; `
      + `village level ${state.villageLevel} allows ${buildingCap()}.`);
    return false;
  }

  if (atLimit(key)) {
    showStatus(`A village may hold at most ${info.limit} × ${info.name.toLowerCase()}.`);
    return false;
  }

  setBuilding(i, key, placementLevel(key), state.buildOrientation);
  return true;
}

function eraseBuilding(i) {
  const anchor = occupancyMap(state.tiles)[i];
  if (anchor === null) return false;
  if (state.tiles[anchor].building === CENTRE) {
    showStatus('The village centre stays. Drag it to move it.');
    return false;
  }
  setBuilding(anchor, EMPTY, 0);
  return true;
}

function paintTerrain(i) {
  const tile = state.tiles[i];
  const key = state.terrainTool;
  if (tile.terrain === key) return false;

  // Painting under a building is allowed; the building is then marked stranded.
  tile.terrain = key;
  return true;
}

/* ------------------------------ pointer ------------------------------ */

function tileAt(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const tileEl = el && el.closest ? el.closest('.tile') : null;
  return tileEl && gridEl.contains(tileEl) ? Number(tileEl.dataset.i) : null;
}

function anchorForDrop(cell) {
  if (cell === null || drag.grabIndex === 0) return cell;
  const [dx, dy] = footprintOffsets(state.tiles[drag.from].building, drag.orientation)[drag.grabIndex];
  return cellAt((cell % WIDTH) - dx, Math.floor(cell / WIDTH) - dy);
}

function dragPreview() {
  if (drag === null || !drag.moved) return null;

  const { building: key, level } = state.tiles[drag.from];
  const anchor = anchorForDrop(drag.over);
  const cells = anchor === null ? null : footprintCells(anchor, key, drag.orientation);
  const shape = { key, level, orientation: drag.orientation };
  if (!cells) return { anchor: null, cells: [], ok: false, swapWith: null, ...shape };

  const occupancy = occupancyMap(state.tiles);
  const others = new Set();
  let ok = true;

  for (const cell of cells) {
    if (!buildable(cell)) ok = false;
    const occupant = occupancy[cell];
    if (occupant !== null && occupant !== drag.from) others.add(occupant);
  }

  let swapWith = null;
  if (others.size === 1) {
    const other = [...others][0];
    if (!isMultiTile(key) && !isMultiTile(state.tiles[other].building)) swapWith = other;
    else ok = false;
  } else if (others.size > 1) {
    ok = false;
  }

  return { anchor, cells, ok, swapWith, ...shape };
}

gridEl.addEventListener('pointerdown', (event) => {
  const i = tileAt(event.clientX, event.clientY);
  if (i === null) return;

  state.selected = i;

  if (event.button === 2) {
    if (state.mode === 'build' && eraseBuilding(i)) recompute();
    render();
    return;
  }
  if (event.button !== 0) return;

  if (state.mode === 'terrain') {
    painting = true;
    gridEl.setPointerCapture(event.pointerId);
    if (paintTerrain(i)) recompute();
    render();
    return;
  }

  const anchor = occupancyMap(state.tiles)[i];
  if (anchor !== null) {
    const tile = state.tiles[anchor];
    const cells = footprintCells(anchor, tile.building, tile.orientation) ?? [anchor];
    drag = {
      from: anchor,
      // Which cell of the footprint was grabbed, so a rotation mid-drag still
      // tracks the pointer: anchorForDrop reinterprets it under the current
      // orientation rather than the one it was grabbed at.
      grabIndex: Math.max(0, cells.indexOf(i)),
      orientation: tile.orientation,
      over: i,
      moved: false,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    gridEl.setPointerCapture(event.pointerId);
    render();
    return;
  }

  if (placeBuilding(i)) recompute();
  render();
});

gridEl.addEventListener('pointermove', (event) => {
  const i = tileAt(event.clientX, event.clientY);
  if (i !== state.hovered) {
    state.hovered = i;
    renderInspector();
    if (state.mode === 'build' && state.buildTool !== null) renderGrid();
  }

  if (painting) {
    if (i !== null && paintTerrain(i)) {
      recompute();
      renderGrid();
    }
    return;
  }

  if (drag === null) return;

  if (!drag.moved) {
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD) return;
    drag.moved = true;
    drag.over = i;
    renderGrid(); // dim the source and draw the preview at the drop target
    return;
  }

  if (i !== drag.over) {
    drag.over = i;
    renderGrid();
  }
});

function endPointer(event) {
  if (gridEl.hasPointerCapture(event.pointerId)) gridEl.releasePointerCapture(event.pointerId);
  painting = false;

  if (drag === null) return;

  drag.over = tileAt(event.clientX, event.clientY);
  const preview = dragPreview();
  const { from, moved, orientation } = drag;
  const rotated = orientation !== state.tiles[from].orientation;
  drag = null;

  if (moved && preview !== null) {
    const moving = preview.anchor !== null && preview.anchor !== from;
    if (!preview.ok) {
      const key = state.tiles[from].building;
      showStatus(blockedReason(preview.cells.length ? preview.cells : null, key, occupancyMap(state.tiles), from)
        ?? `A ${BUILDING_BY_KEY.get(key).name.toLowerCase()} doesn't fit there.`);
    } else if (moving || rotated) {
      const dragged = { ...state.tiles[from] };
      const swap = preview.swapWith === null ? null : { ...state.tiles[preview.swapWith] };

      setBuilding(from, EMPTY, 0);
      if (swap) setBuilding(from, swap.building, swap.level, swap.orientation, swap.seal);
      setBuilding(preview.anchor, dragged.building, dragged.level, orientation, dragged.seal);

      state.selected = preview.anchor;
      recompute();
    }
  }
  render();
}

gridEl.addEventListener('pointerup', endPointer);
gridEl.addEventListener('pointercancel', endPointer);

gridEl.addEventListener('pointerleave', () => {
  if (state.hovered === null) return;
  state.hovered = null;
  renderInspector();
  renderGrid(); // clear the ghost from the last hovered tile
});

gridEl.addEventListener('contextmenu', (event) => event.preventDefault());
gridEl.addEventListener('dragstart', (event) => event.preventDefault());

gridEl.addEventListener('wheel', (event) => {
  const i = tileAt(event.clientX, event.clientY);
  if (i === null) return;
  const anchor = occupancyMap(state.tiles)[i];
  if (anchor === null) return;
  event.preventDefault();
  adjustLevel(anchor, event.deltaY < 0 ? 1 : -1);
}, { passive: false });

/* ------------------------------ controls ------------------------------ */

basicsEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-terraform]');
  if (button === null) return;

  const at = Number(button.dataset.terraform);
  state.tiles[at].terraformed = !state.tiles[at].terraformed;
  render();
  recompute();
  saveSoon();
});

terrainBonusInput.addEventListener('input', () => {
  const percent = Number(terrainBonusInput.value);
  const factor = 1 + (Number.isFinite(percent) ? Math.max(0, percent) : 0) / 100;
  if (factor === state.terrainBonusFactor) return;

  state.terrainBonusFactor = factor;
  render();
  recompute();
});

villageLevelInput.addEventListener('input', () => {
  const before = state.villageLevel;
  setVillageLevel(Number(villageLevelInput.value));
  if (state.villageLevel !== before) recompute();
  render();
});

document.getElementById('show-output').addEventListener('change', (event) => {
  state.showOutput = event.target.checked;
  renderGrid();
  saveSoon();
});

document.getElementById('clear-buildings').addEventListener('click', () => {
  state.tiles.forEach((tile, i) => {
    if (tile.building !== CENTRE) setBuilding(i, EMPTY, 0);
  });
  state.buildOrientation = EAST;
  render();
  recompute();
});

document.addEventListener('keydown', (event) => {
  const typing = event.target
    && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA');
  const key = event.key.toLowerCase();

  if ((event.ctrlKey || event.metaKey) && !typing && (key === 'z' || key === 'y')) {
    event.preventDefault();
    travel(key === 'y' || event.shiftKey ? 1 : -1);
    return;
  }
  if (event.key === 'Escape' && openModal !== null) {
    hideModal();
    return;
  }
  if (typing) return;

  if (key === 'r') {
    if (drag !== null && isRotatable(state.tiles[drag.from].building)) {
      event.preventDefault();
      drag.orientation = rotate(state.tiles[drag.from].building, drag.orientation);
      renderGrid();
      return;
    }
    if (state.mode === 'build' && isRotatable(state.buildTool)) {
      event.preventDefault();
      state.buildOrientation = rotate(state.buildTool, state.buildOrientation);
      renderPaletteOrientation();
      renderGrid(); // rotate the ghost with it
      return;
    }
    return;
  }

  if (event.key === 'Escape') {
    if (state.mode === 'build' && state.buildTool !== null) selectTool('building', null);
    return;
  }

  if (key === 'g') {
    showView('place');
    setMode(state.mode === 'terrain' ? 'build' : 'terrain');
    return;
  }

  const digit = Number(event.key);
  if (!Number.isInteger(digit) || digit < 1) return;

  if (state.mode === 'terrain') {
    if (digit <= TERRAINS.length) selectTool('terrain', TERRAINS[digit - 1].key);
    return;
  }
  const visible = placeableInTier(state.buildTier);
  if (digit <= visible.length) selectTool('building', visible[digit - 1].key);
});

/* ------------------------------ the engine ------------------------------ */


function layoutText() {
  const parts = [String(state.villageLevel)];
  for (const tile of state.tiles) {
    // Trailing flags, each optional; the parser distinguishes them by length.
    let token = `${tile.terrain}:${tile.building}:${tile.level}`;
    if (isMultiTile(tile.building)) token += `:${tile.orientation}`;
    if (tile.seal !== NO_SEAL) token += `:${tile.seal}`;
    parts.push(token);
  }

  /* With the layout rather than the settings, so every saved, shared and
     undone layout carries the ground. */
  const terraformed = state.tiles.flatMap((tile, i) => (tile.terraformed ? [i] : []));
  if (terraformed.length > 0) {
    parts.push(`terrain_bonus_factor=${state.terrainBonusFactor}`, `terraformed=${terraformed.join(',')}`);
  }

  return parts.join(' ');
}

/* The engine parses layouts; this file only writes them. One grammar, one
   implementation, and a layout the engine rejects never reaches the grid. */
async function loadLayout(text) {
  const village = await parseOnEngine(text);

  for (let i = 0; i < TILE_COUNT; i += 1) {
    state.tiles[i].terrain = village.terrain[i];
    state.tiles[i].terraformed = village.terraformed?.[i] === true;
  }
  if (Number.isFinite(village.terrainBonusFactor)) state.terrainBonusFactor = village.terrainBonusFactor;
  applyLayout(village);
  setVillageLevel(village.level);
  return village.level;
}

function serialize() {
  const parts = [layoutText(), `game=${state.game}`];

  const season = pricingSeason();
  if (season !== null) parts.push(`season=${season}`);

  for (const { id, neutral, percent } of GAME_MODIFIERS) {
    const entered = state.modifiers[id];
    if (entered === neutral) continue;
    parts.push(`${id}=${(percent ? entered / 100 : entered).toFixed(MODIFIER_DECIMALS)}`);
  }

  const politics = state.modifiers[POLITICS_ID];
  if (politics !== NO_POLITICS) parts.push(`${POLITICS_ID}=${politics}`);

  return parts.join(' ');
}

let engine = null;
let engineTrouble = null;


/* Awaits engineLoaded rather than engineReady: startup parses a layout with
   this function, so awaiting the end of startup would deadlock. */
async function parseOnEngine(text) {
  await engineLoaded;
  if (engine === null) throw new Error(engineTrouble);
  return JSON.parse(engine.parse(text));
}

// Resolves once the engine has loaded, or once loading has failed.
const engineLoaded = (async () => {
  await null;

  try {
    if (typeof createEngine !== 'function') throw new Error('the page did not receive it');
    engine = attachEngine(await createEngine());
  } catch (err) {
    engineTrouble = `Could not load the engine: ${reason(err)}`;
    showStatus(engineTrouble, true);
  }

  return engine !== null;
})();

// Resolves once the page has started up: engine loaded, the stored village
// restored, and its output computed.
const engineReady = (async () => {
  await engineLoaded;

  renderSettings();

  if (savedLayout !== null) {
    try {
      await loadLayout(savedLayout);
    } catch (err) {
      showStatus(`Could not reopen the saved village: ${reason(err)}`, true);
    }
    savedLayout = null;
  }

  // Both depend on the restored layout: the undo history is diffed against
  // what is on the grid.
  restoreUndoHistory();
  render();
  recompute();
  return engine !== null;
})();

function recompute() {
  if (engine === null) {
    saveAndRender();
    return;
  }

  // A stranded building makes the village one the engine rejects, so there is
  // nothing to compute and nothing to display.
  if (anythingStranded()) {
    state.result = null;
    saveAndRender();
    return;
  }

  try {
    state.result = JSON.parse(engine.production(serialize()));
  } catch (err) {
    // Clear rather than keep the previous village's output, which loading
    // villages in succession makes easy to hit and easy to miss.
    state.result = null;
    showStatus(reason(err), true);
  }
  saveAndRender();
}

function saveAndRender() {
  saveSoon();
  renderStatsPanel(state.result, state.modifiers);
  renderGrid();
  renderInspector();
}

const goalListEl = document.getElementById('goal-list');
const solveButton = document.getElementById('solve');
const solveResult = document.getElementById('solve-result');
const soldierModeSelect = document.getElementById('soldier-mode');
const workerModeSelect = document.getElementById('worker-mode');
const unitChoice = document.getElementById('unit-choice');
const marketBox = document.getElementById('goal-market');
// Every variant has an id of its own, which is what a search returns, so each
// must be resolvable to a name here.
const GOAL_BY_ID = new Map([...OBJECTIVES, ...SOLDIER_MODES, ...WORKER_MODES, ...MARKET_GOALS,
...UNIT_READINGS.flatMap((one) => [one.power, one.production])].map((o) => [o.id, o]));
const balanceBox = document.getElementById('goal-balance');

function soldierMode() {
  return SOLDIER_MODES.find((m) => m.key === state.soldierMode) ?? SOLDIER_MODES[0];
}

function workerMode() {
  return WORKER_MODES.find((m) => m.key === state.workerMode) ?? WORKER_MODES[0];
}

function unitReading() {
  return UNIT_READINGS.find((one) => one.key === state.unit) ?? UNIT_READINGS[0];
}

// A goal's label and requested id depend on the variant selected for it; a
// goal with a single variant always resolves to that one.
function goalReading(id) {
  if (id === SOLDIER_GOAL) return soldierMode();
  if (id === WORKER_GOAL) return workerMode();
  if (id === POWER_GOAL) return unitReading().power;
  if (id === UNIT_GOAL) return unitReading().production;
  if (state.marketGoals && MARKET_BY_BASE.has(id)) return MARKET_BY_BASE.get(id);
  return GOAL_BY_ID.get(id);
}

function goalHelp() {
  return state.balance
    ? 'Weighted: 1 weight = 1% of that goal\u2019s own best, so different units compare.'
    : 'Ranked: each goal breaks ties left by the one above. Drag a goal, or use the arrow keys, to reorder them.';
}

function renderGoals() {
  goalListEl.replaceChildren();
  goalListEl.classList.toggle('weighed', state.balance);
  renderHelp(); // the ranked-or-weighted line is part of it


  state.goals.forEach((id, rank) => {
    const item = document.createElement('li');
    item.className = 'goal';
    item.dataset.goal = id;
    item.dataset.rank = String(rank);
    // Order is set by dragging, so each row is also a tab stop the arrow keys
    // can move.
    item.tabIndex = state.balance ? -1 : 0;

    const grip = span('goal-grip', '\u2807\u2807');
    grip.setAttribute('aria-hidden', 'true');
    item.append(grip);

    const name = span('goal-name', goalReading(id).name);
    item.title = goalReading(id).full;
    item.append(name);

    const weight = document.createElement('input');
    weight.type = 'number';
    weight.className = 'goal-weight';
    weight.min = '0';
    weight.step = '1';
    weight.value = String(state.weights[id]);
    weight.title = `How much ${goalReading(id).full.toLowerCase()} counts for`;
    weight.hidden = !state.balance;
    weight.addEventListener('input', () => {
      const typed = Number(weight.value);
      // A blank field mid-edit is not yet a weight; a negative one never is.
      if (weight.value !== '' && Number.isFinite(typed) && typed >= 0) {
        state.weights[id] = typed;
        saveSoon();
      }
    });
    weight.addEventListener('change', () => {
      if (!(Number(weight.value) >= 0)) weight.value = String(state.weights[id]);
    });
    item.append(weight);

    goalListEl.append(item);
  });
}

function moveGoal(rank, by) {
  const to = rank + by;
  if (to < 0 || to >= state.goals.length) return;
  const [id] = state.goals.splice(rank, 1);
  state.goals.splice(to, 0, id);
  renderGoals();
  saveSoon();
  // The row moved out from under the pointer, so keep keyboard focus on it.
  goalListEl.children[to]?.focus({ preventScroll: true });
}

/* Drags a goal to a new rank.

   Every row has the same height, so the landing rank is the distance dragged
   divided by that height rather than a comparison against the other rows. Rows
   the dragged one passes slide by one place to show where it will land, and
   the order is committed on release. */
function dragGoal(event, item) {
  const rows = [...goalListEl.children];
  const from = rows.indexOf(item);
  if (from < 0) return;

  // Top to top rather than row height, so the gap between rows is included.
  const step = rows.length > 1
    ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top
    : item.getBoundingClientRect().height;
  const startY = event.clientY;
  let to = from;

  goalListEl.classList.add('dragging');
  item.classList.add('dragged');
  // Pointer capture keeps the drag alive once the pointer leaves the row,
  // which happens immediately. Not every environment provides it; without it
  // the drag still works over the row itself.
  try {
    item.setPointerCapture(event.pointerId);
  } catch {
    /* no capture to be had */
  }

  const follow = (moved) => {
    const dy = moved.clientY - startY;
    item.style.transform = `translateY(${dy}px)`;

    const wanted = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / step)));
    if (wanted === to) return;
    to = wanted;
    for (const [rank, row] of rows.entries()) {
      if (row === item) continue;
      let slide = 0;
      if (to > from && rank > from && rank <= to) slide = -step;
      if (to < from && rank >= to && rank < from) slide = step;
      row.style.transform = slide === 0 ? '' : `translateY(${slide}px)`;
    }
  };

  const drop = () => {
    item.removeEventListener('pointermove', follow);
    item.removeEventListener('pointerup', drop);
    item.removeEventListener('pointercancel', drop);
    goalListEl.classList.remove('dragging');

    if (to !== from) {
      const [id] = state.goals.splice(from, 1);
      state.goals.splice(to, 0, id);
      saveSoon();
    }
    renderGoals(); // rebuilding clears every transform left by the drag
    goalListEl.children[to]?.focus({ preventScroll: true });
  };

  item.addEventListener('pointermove', follow);
  item.addEventListener('pointerup', drop);
  item.addEventListener('pointercancel', drop);
}

goalListEl.addEventListener('pointerdown', (event) => {
  // With weights on, order does not affect the result, so dragging is off;
  // and the weight field needs the pointer for itself.
  if (state.balance || event.button !== 0) return;
  if (event.target.closest('.goal-weight') !== null) return;

  const item = event.target.closest('.goal');
  if (item === null) return;

  event.preventDefault(); // otherwise the drag selects the text it passes over
  item.focus({ preventScroll: true });
  dragGoal(event, item);
});

goalListEl.addEventListener('keydown', (event) => {
  if (state.balance || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
  const item = event.target.closest('.goal');
  if (item === null) return;
  event.preventDefault();
  moveGoal(Number(item.dataset.rank), event.key === 'ArrowUp' ? -1 : 1);
});

balanceBox.addEventListener('change', () => {
  state.balance = balanceBox.checked;
  renderGoals();
  saveSoon();
});

/* The soldier and worker goals each offer a choice of variant, so both menus
   are filled and wired the same way. Picking one relabels the goal it
   belongs to, which is why each writes to state and re-renders the list. */
function buildModeSelect(select, modes, chosen) {
  for (const mode of modes) addOption(select, mode.key, mode.option, `Ask the search for ${mode.full}`);

  select.addEventListener('change', () => {
    const picked = modes.find((mode) => mode.key === select.value);
    chosen((picked ?? modes[0]).key);
    renderGoals();
    saveSoon();
  });
}

buildModeSelect(soldierModeSelect, SOLDIER_MODES, (key) => { state.soldierMode = key; });
buildModeSelect(workerModeSelect, WORKER_MODES, (key) => { state.workerMode = key; });

/* Two buttons rather than a menu: one choice of unit, which relabels both the
   power goal and the production goal. */
function renderUnitChoice() {
  for (const button of unitChoice.querySelectorAll('button'))
    button.setAttribute('aria-pressed', String(button.dataset.unit === state.unit));
}

for (const reading of UNIT_READINGS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.unit = reading.key;
  button.textContent = reading.name;
  button.title = `Ask the search for ${reading.power.full} and ${reading.production.full}`;
  button.addEventListener('click', () => {
    state.unit = reading.key;
    renderUnitChoice();
    renderGoals();
    saveSoon();
  });
  unitChoice.append(button);
}
renderUnitChoice();

marketBox.addEventListener('change', () => {
  state.marketGoals = marketBox.checked;
  renderGoals();
  saveSoon();
});

const terraformBox = document.getElementById('terraform-allowed');
const terraformTilesInput = document.getElementById('terraform-tiles');
const terraformUnlimitedBox = document.getElementById('terraform-unlimited');
const terraformBudgetRow = document.getElementById('terraform-budget-row');
const terraformUnlimitedRow = document.getElementById('terraform-unlimited-row');

function renderTerraform() {
  terraformBox.checked = state.terraform.allowed;
  terraformUnlimitedBox.checked = state.terraform.unlimited;
  terraformUnlimitedRow.hidden = !state.terraform.allowed;
  terraformBudgetRow.hidden = !state.terraform.allowed || state.terraform.unlimited;

  const shown = String(state.terraform.tiles);
  if (terraformTilesInput.value !== shown) terraformTilesInput.value = shown;
}

terraformBox.addEventListener('change', () => {
  state.terraform.allowed = terraformBox.checked;
  renderTerraform();
  saveSoon();
});

terraformUnlimitedBox.addEventListener('change', () => {
  state.terraform.unlimited = terraformUnlimitedBox.checked;
  renderTerraform();
  saveSoon();
});

terraformTilesInput.addEventListener('input', () => {
  const typed = Number(terraformTilesInput.value);
  if (!Number.isInteger(typed) || typed < 0) return;
  state.terraform.tiles = Math.min(typed, TILE_COUNT);
  saveSoon();
});

function applyLayout(layout) {
  for (let i = 0; i < TILE_COUNT; i += 1) {
    // Terrain first: a search allowed to terraform returns terrain of its
    // own, and the tiles it changed are terraformed ground from here on.
    state.tiles[i].terrain = layout.terrain[i];
    state.tiles[i].terraformed = layout.terraformed?.[i] === true;
    setBuilding(i, layout.buildings[i], layout.levels[i], layout.orientations[i], layout.seals[i]);
  }
}

function goalValue(id, value) {
  return id.endsWith('.storage') ? fmtStore(value) : fmt(value);
}

// Milliseconds below a second, seconds above it.
function elapsed(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${fmt(ms / 1000, ms < 10000 ? 1 : 0)}s`;
}

/* One row per goal that changed: its new value and the relative change. The
   starting value and the value it reaches when optimised alone would wrap the
   column, so they go in the row's tooltip. */
function reportSolve(found, took) {
  const rows = found.goals.flatMap(({ id, before, after, alone }) => {
    if (after === before) return [];

    const shown = goalValue(id, after);
    const change = before > 0 ? pct(after / before - 1) : '';
    const was = `was ${goalValue(id, before)}`;
    const onItsOwn = alone > 0 ? `, ${fmt((100 * after) / alone, 0)}% of ${goalValue(id, alone)} alone` : '';

    return [`<li title="${was}${onItsOwn}"><span class="solve-goal">${GOAL_BY_ID.get(id).name}</span>`
      + `<span class="solve-now">${shown}</span>`
      + `<span class="solve-change ${after > before ? 'up' : 'down'}">${change}</span></li>`];
  });

  const tried = `${found.evaluated.toLocaleString('en-US')} layouts tried in ${elapsed(took)}.`;
  const changed = [];
  if (found.moved > 0) changed.push(`${plural(found.moved, 'building')} moved`);
  if (found.terraformed > 0) changed.push(`${plural(found.terraformed, 'tile')} terraformed`);
  const summary = changed.length === 0
    ? `No better layout found. ${tried}`
    : `${changed.join(', ')}, ${tried}`;

  solveResult.innerHTML = (rows.length > 0 ? `<ul class="solve-goals">${rows.join('')}</ul>` : '')
    + `<p class="solve-summary">${summary}</p>`;
  solveResult.hidden = false;
}

let searchers = [];
let searchTicket = 0;

/* Each restart draws on a random stream of its own, so running restarts 0..5
   in one worker and 6..11 in another, then taking the better result, is the
   same search as 0..11 undivided. tests/split.py verifies that. */
function howManyWorkers(restarts) {
  const cores = Math.max(1, Math.floor(navigator.hardwareConcurrency || 1));
  return Math.max(1, Math.min(cores, restarts));
}

function askWorker(worker, message) {
  return new Promise((resolve, reject) => {
    const hear = ({ data }) => {
      if (data.id !== message.id) return;
      worker.removeEventListener('message', hear);
      if (data.ok) resolve(data.text);
      else reject(new Error(data.text));
    };
    worker.addEventListener('message', hear);
    worker.postMessage(message);
  });
}

/* The rule the solver compares two arrangements by, duplicated here because
   each worker reports its own best and one must be selected. Mirrored in
   tests/split.py, which checks the selection against an undivided run. */
function scoresBetter(a, b) {
  if (a.ranking === 'weighted-sum') {
    const total = (found) => found.goals.reduce(
      (sum, g) => sum + (g.alone > 0 ? (g.weight * g.after) / g.alone : 0), 0,
    );
    return total(a) > total(b);
  }

  for (let k = 0; k < a.goals.length; k += 1) {
    const mine = a.goals[k].after;
    const theirs = b.goals[k].after;
    const scale = Math.max(Math.abs(mine), Math.abs(theirs), 1);
    if (Math.abs(mine - theirs) > 1e-9 * scale) return mine > theirs;
  }
  return false;
}

async function search(body, goal) {
  if (engine === null) throw new Error(engineTrouble);

  const effort = effortSpec();
  const { restarts } = currentEffort();

  // Without workers, every restart runs on this thread.
  if (typeof Worker !== 'function') {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    return engine.rearrange(body, goal, effort);
  }

  const wanted = howManyWorkers(restarts);
  while (searchers.length < wanted) searchers.push(new Worker('/engine-worker.js'));

  const id = ++searchTicket;

  // Split as evenly as possible: nine restarts over four workers is 3+2+2+2
  // rather than 3+3+3 and one idle worker.
  const slices = [];
  for (let w = 0; w < wanted; w += 1) {
    const first = Math.floor((w * restarts) / wanted);
    const count = Math.floor(((w + 1) * restarts) / wanted) - first;
    if (count > 0) slices.push(`${effort},first=${first},count=${count}`);
  }

  const answers = await Promise.all(
    slices.map((spec, w) => askWorker(searchers[w], { id, body, goal, effort: spec })),
  );

  // Reduced in slice order, so the winner does not depend on which worker
  // finished first.
  let best = JSON.parse(answers[0]);
  let evaluated = best.evaluated;
  for (const answer of answers.slice(1)) {
    const found = JSON.parse(answer);
    evaluated += found.evaluated;
    if (scoresBetter(found, best)) best = found;
  }

  best.evaluated = evaluated;
  return JSON.stringify(best);
}

async function solve() {
  if (anythingStranded()) {
    showStatus('Move the buildings standing on unbuildable terrain first.', true);
    return;
  }

  // A weight is stored against the base goal, whichever variant of it the
  // search is asked for.
  const goal = state.goals
    .map((id) => (state.balance ? `${goalReading(id).id}:${state.weights[id]}` : goalReading(id).id))
    .join(',');
  solveButton.disabled = true;
  solveButton.textContent = 'Searching…';
  solveResult.hidden = true;
  saveNow();

  try {
    // Wall time, so the first search of a session includes starting the
    // workers and loading the engine into each.
    const started = performance.now();
    const found = JSON.parse(await search(serialize(), goal));
    const took = performance.now() - started;

    applyLayout(found.layout);
    reportSolve(found, took);

    state.selected = null;
    render();
    recompute();
  } catch (err) {
    showStatus(reason(err), true);
  } finally {
    solveButton.disabled = false;
    solveButton.textContent = 'Find a better layout';
  }
}

solveButton.addEventListener('click', solve);

/* ---------------------------- undo history ---------------------------- */

const undoHistory = { layouts: [], at: -1 };

function renderUndoControls() {
  undoButton.disabled = undoHistory.at <= 0;
  redoButton.disabled = undoHistory.at >= undoHistory.layouts.length - 1;
  historyStep.textContent = undoHistory.layouts.length > 1 ? `${undoHistory.at + 1} / ${undoHistory.layouts.length}` : '';
}

function writeUndoHistory() {
  try {
    sessionStorage.setItem(UNDO_HISTORY, JSON.stringify({ v: 1, at: undoHistory.at, layouts: undoHistory.layouts }));
  } catch {
    // No storage, or it is full. Undo still works for this page.
  }
}

function pushUndoStep() {
  const text = layoutText();
  if (undoHistory.layouts[undoHistory.at] === text) return;
  undoHistory.layouts.length = undoHistory.at + 1;
  undoHistory.layouts.push(text);
  if (undoHistory.layouts.length > UNDO_HISTORY_MAX) undoHistory.layouts.shift();
  undoHistory.at = undoHistory.layouts.length - 1;

  writeUndoHistory();
  renderUndoControls();
}

async function travel(by) {
  saveNow();

  const to = undoHistory.at + by;
  if (to < 0 || to >= undoHistory.layouts.length) return;

  // If the engine rejects the layout, stay put rather than leave the counter
  // pointing at a layout the grid does not show.
  const was = undoHistory.at;
  undoHistory.at = to;
  try {
    await loadLayout(undoHistory.layouts[to]);
  } catch (err) {
    undoHistory.at = was;
    showStatus(reason(err), true);
    return;
  }

  writeUndoHistory();
  renderUndoControls();

  state.selected = null;
  render();
  recompute();
}

undoButton.addEventListener('click', () => travel(-1));
redoButton.addEventListener('click', () => travel(1));

function restoreUndoHistory() {
  const here = layoutText();
  try {
    const saved = JSON.parse(sessionStorage.getItem(UNDO_HISTORY));
    if (saved !== null && saved.v === 1 && Array.isArray(saved.layouts)
      && Number.isInteger(saved.at) && saved.layouts[saved.at] === here
      && saved.layouts.every((text) => typeof text === 'string')) {
      undoHistory.layouts = saved.layouts;
      undoHistory.at = saved.at;
      renderUndoControls();
      return;
    }
  } catch {
    // Absent, unreadable, or written by something else: start over.
  }

  undoHistory.layouts = [here];
  undoHistory.at = 0;
  writeUndoHistory();
  renderUndoControls();
}

/* ------------------------------ storage ------------------------------ */

/* Stores what was chosen: the layout, the modifiers and the control state.
   Nothing derived, since recomputing is cheaper than keeping a copy correct.
   Nothing is migrated either: see the Clear button in Settings. */

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    // No storage at all, or something else wrote unparseable data here.
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked store is not worth interrupting the page over.
  }
}

function village() {
  return { v: 1, layout: layoutText(), modifiers: { ...state.modifiers } };
}

function controls() {
  return {
    v: 1,
    game: state.game,
    season: state.season,
    panel: state.panel,
    mode: state.mode,
    tier: state.buildTier,
    tool: state.buildTool,
    orientation: state.buildOrientation,
    buildLevel: state.buildLevel,
    terrain: state.terrainTool,
    output: state.showOutput,
    goals: [...state.goals],
    soldierMode: state.soldierMode,
    workerMode: state.workerMode,
    unit: state.unit,
    marketGoals: state.marketGoals,
    terraform: { ...state.terraform },
    effort: state.effort,
    customEffort: { ...state.customEffort },
    balance: state.balance,
    weights: { ...state.weights },
    shareModifiers: shareModifiers.checked,
    modifiersOpen: modifiersPanel.open,
  };
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 200);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeJson(VILLAGE, village());
  writeJson(VIEW, controls());
  pushUndoStep();
}

function restoreFromStorage() {
  const made = readJson(VILLAGE);
  if (made !== null && made.v === 1) {
    // Only the engine parses a layout, and it is still loading; engineReady
    // applies this once it can.
    if (typeof made.layout === 'string') savedLayout = made.layout;
    applyModifiers(made.modifiers);
  }

  const view = readJson(VIEW);
  if (view === null || view.v !== 1) return null;
  if (GAME_BY_ID.has(view.game)) state.game = view.game;
  // Anything that is not a valid index into this round's seasons follows the
  // clock instead.
  state.season = Number.isInteger(view.season) && view.season >= 0 && view.season < seasonsOf(state.game).length
    ? view.season
    : null;
  if (view.panel === 'place' || view.panel === 'solve') state.panel = view.panel;
  if (view.mode === 'build' || view.mode === 'terrain') state.mode = view.mode;
  if (TIERS.includes(view.tier)) state.buildTier = view.tier;
  if (view.tool === null || PLACEABLE.some((b) => b.key === view.tool)) state.buildTool = view.tool;
  if (SCHEMA.orientations.includes(view.orientation)) state.buildOrientation = view.orientation;
  if (Number.isFinite(view.buildLevel)) state.buildLevel = clampBuildingLevel(view.buildLevel, null);
  if (TERRAIN_BY_KEY.has(view.terrain)) state.terrainTool = view.terrain;
  state.showOutput = view.output !== false;

  /* A stored order fixes only the ranking; every goal is listed either way,
     so any goal it omits is appended in the default order. */
  const ranked = Array.isArray(view.goals) ? view.goals : [];
  const kept = ranked.filter((id, k) => GOAL_ORDER.includes(id) && ranked.indexOf(id) === k);
  state.goals = kept.concat(GOAL_ORDER.filter((id) => !kept.includes(id)));

  if (SOLDIER_MODES.some((m) => m.key === view.soldierMode)) state.soldierMode = view.soldierMode;
  if (WORKER_MODES.some((m) => m.key === view.workerMode)) state.workerMode = view.workerMode;
  if (UNIT_READINGS.some((one) => one.key === view.unit)) state.unit = view.unit;
  state.marketGoals = view.marketGoals === true;

  state.terraform.allowed = view.terraform?.allowed === true;
  state.terraform.unlimited = view.terraform?.unlimited === true;
  const terraformTiles = view.terraform?.tiles;
  if (Number.isInteger(terraformTiles) && terraformTiles >= 0) state.terraform.tiles = terraformTiles;

  if (view.effort === 'custom' || Object.hasOwn(EFFORTS, view.effort)) state.effort = view.effort;
  for (const name of EFFORT_FIELDS) {
    const value = view.customEffort?.[name];
    if (Number.isInteger(value) && value >= 1) state.customEffort[name] = value;
  }

  state.balance = view.balance === true;
  for (const { id } of OBJECTIVES) {
    const weight = view.weights?.[id];
    if (Number.isFinite(weight) && weight >= 0) state.weights[id] = weight;
  }

  return view;
}

function applyModifiers(fields) {
  if (fields === null || typeof fields !== 'object') return false;

  let took = false;

  for (const { id, minimum } of GAME_MODIFIERS) {
    const value = modifierIn(fields, id);
    if (!Number.isFinite(value) || value < minimum) continue;
    state.modifiers[id] = value;
    took = true;
  }

  if (POLITICS_KEYS.has(fields[POLITICS_ID])) {
    state.modifiers[POLITICS_ID] = fields[POLITICS_ID];
    took = true;
  }

  return took;
}

/* ------------------------------- seasons -------------------------------

   Each season multiplies every cost multiplier by SCHEMA.seasonCostStep
   (0.99), counting the first: the engine charges the round's own multiplier
   times 0.99^(season + 1). This only chooses which season to send. */

const seasonField = document.getElementById('season-field');
const seasonSelect = document.getElementById('season-select');

// A function declaration, not a const: restoreFromStorage calls this before
// this line is reached, where a const would be in its temporal dead zone.
function seasonsOf(id) {
  return GAME_BY_ID.get(id)?.seasons ?? [];
}

// Index of the season containing the current time, or -1 if none does.
function currentSeason(id) {
  const now = Date.now();
  return seasonsOf(id).findIndex((one) => now >= Date.parse(one.start) && now < Date.parse(one.end));
}

// The season to price against: the selected one, else the current one, else
// null, which uses the multiplier the game's own were fetched with.
function pricingSeason() {
  const seasons = seasonsOf(state.game);
  if (Number.isInteger(state.season) && state.season >= 0 && state.season < seasons.length) return state.season;
  const now = currentSeason(state.game);
  return now < 0 ? null : now;
}

function seasonName(one) {
  return one.name.charAt(0) + one.name.slice(1).toLowerCase();
}

function renderSeasons() {
  const seasons = seasonsOf(state.game);
  seasonField.hidden = seasons.length === 0;
  if (seasons.length === 0) return;

  const now = currentSeason(state.game);

  seasonSelect.replaceChildren();

  addOption(seasonSelect, '', now < 0 ? 'Current' : `Now · ${seasonName(seasons[now])}`);

  const baseline = GAME_BY_ID.get(state.game)?.seasonNow ?? -1;
  for (let i = 0; i < seasons.length; i += 1) {
    // Cost multiplier over the round's own.
    const step = baseline < 0 ? 1 : SCHEMA.seasonCostStep ** (i + 1);
    const factor = step === 1 ? '' : ` · ×${step.toFixed(3).replace(/0+$/, '')}`;
    addOption(seasonSelect, String(i), `${i + 1}. ${seasonName(seasons[i])}${i === now ? ' (now)' : ''}${factor}`);
  }

  seasonSelect.value = state.season === null ? '' : String(state.season);
  seasonSelect.classList.toggle('modifier-on', state.season !== null && state.season !== now);
}

seasonSelect.addEventListener('change', () => {
  state.season = seasonSelect.value === '' ? null : Number(seasonSelect.value);
  renderSeasons();
  recompute();
});

// Re-render when the current season changes while none is selected. Seasons
// last hours, so one check per minute suffices.
let seasonShown = null;
setInterval(() => {
  if (state.season !== null) return;
  const now = currentSeason(state.game);
  if (now === seasonShown) return;
  seasonShown = now;
  renderSeasons();
  recompute();
}, 60000);

/* -------------------------------- the game -------------------------------- */

const gameSelect = document.getElementById('game-select');

function renderGames() {
  if (gameSelect.options.length === 0) {
    for (const game of GAMES) addOption(gameSelect, String(game.id), `${game.id} · ${game.map.replace(/_/g, ' ').toLowerCase()}`);
  }
  gameSelect.value = String(state.game);
}

// Sets every tile's terrain from the game's map, leaving buildings alone.
function setTerrainFromGame(id) {
  const game = GAME_BY_ID.get(id);
  if (game === undefined) return;

  const rows = terrainRows(game);
  for (let i = 0; i < TILE_COUNT; i += 1) {
    state.tiles[i].terrain = rows[Math.floor(i / WIDTH)][i % WIDTH];
  }
}

/* Changing game changes the terrain under everything already placed. Anything
   left on unbuildable terrain is marked stranded rather than removed: moving
   it is the user's decision. */
function useGame(id) {
  const game = GAME_BY_ID.get(id);
  if (game === undefined || id === state.game) return;

  state.game = id;
  readEffects(id);
  setTerrainFromGame(id);

  const stranded = strandedCells().size;
  state.selected = null;
  villagesAsked = null;
  // A season selected in the previous round does not carry over.
  state.season = null;
  renderPlayers([], true);
  renderGames();
  renderSeasons();
  render();
  recompute();

  const where = `Game ${id}: ${game.map.replace(/_/g, ' ').toLowerCase()}.`;
  const adrift = stranded === 0 ? '' : ` ${plural(stranded, 'tile')} now on ground nothing can stand on.`;
  showStatus(where + adrift, stranded > 0);
}

gameSelect.addEventListener('change', () => useGame(Number(gameSelect.value)));

/* ------------------------- villages people built -------------------------- */

/* A finished round's villages are public, so they are offered as starting
   points. Fetched from this site when the list is first opened rather than at
   startup, since most visits never ask for one. A round still being played has
   none to offer. */
const playerSelect = document.getElementById('player-select');
const villagesByGame = new Map();
let villagesAsked = null;

async function villagesFor(id) {
  if (villagesByGame.has(id)) return villagesByGame.get(id);

  const res = await fetch(`/players/${id}.json`);
  // A round still being played has no villages recorded, since they change
  // hourly (see tools/fetch-games.py). That is an outcome, not an error.
  if (res.status === 404) {
    villagesByGame.set(id, []);
    return [];
  }
  if (!res.ok) throw new Error(`no villages recorded for game ${id}`);

  /* `effects` is what the api reported for that village, trimmed as the
     console script trims it (see tools/fetch-games.py), so both paths parse it
     with the same function. A village recorded without one has no modifiers
     field, which usePlayer treats as "leave the current set alone". */
  const found = (await res.json())
    .filter((one) => one.buildings.length > 0)
    .map((one) => (one.effects === undefined ? one
      : { ...one, modifiers: modifiersFromEffects(one.effects) }));
  villagesByGame.set(id, found);
  return found;
}

function renderPlayers(found, waiting = false) {
  playerSelect.replaceChildren();

  const waitingLabel = 'Load a village…';
  const readyLabel = found.length === 0 ? 'No villages recorded' : `Load a village… (${found.length})`;
  addOption(playerSelect, '', waiting ? waitingLabel : readyLabel);

  for (const one of found) addOption(playerSelect, String(one.id), `${one.name} · hq ${one.level}`);
}

function fillPlayers() {
  if (villagesAsked === state.game) return;
  villagesAsked = state.game;

  villagesFor(state.game)
    .then(renderPlayers)
    .catch((err) => {
      villagesAsked = null;
      showStatus(reason(err), true);
    });
}

playerSelect.addEventListener('mousedown', fillPlayers);
playerSelect.addEventListener('focus', fillPlayers);

/* The api gives rotation in quarter turns and position as the bounding-box
   corner in every case. For a Line only the parity is meaningful: even is
   horizontal, odd is vertical, and the anchor does not move. Confirmed against
   the game map for a warehouse at (0, 2) rotation 3, which occupies (0, 2) and
   (0, 3).

   Square is invariant under rotation, and LShape has four distinct
   orientations matching the engine's four, so both use the count directly. */
function orientationOf(key, rotation) {
  const turns = (((rotation || 0) % 4) + 4) % 4;
  if (shapeOf(key) === 'line') return turns % 2 === 0 ? EAST : SOUTH;
  return SCHEMA.orientations[turns];
}

function usePlayer(one) {
  const terraformed = new Set(one.terraformed ?? []);

  for (let i = 0; i < TILE_COUNT; i += 1) {
    state.tiles[i].terrain = one.terrain[i];
    state.tiles[i].terraformed = terraformed.has(i);
    setBuilding(i, EMPTY, 0);
  }
  state.terrainBonusFactor = one.terrainBonusFactor ?? 1;

  setBuilding(index(one.hqX, one.hqY), CENTRE, 1);

  let refused = 0;
  for (const b of one.buildings) {
    const at = index(b.x, b.y);
    if (!Number.isInteger(at) || at < 0 || at >= TILE_COUNT || !BUILDING_BY_KEY.has(b.name)) {
      refused += 1;
      continue;
    }
    // An unrecognised seal is dropped, as is one on a building that cannot
    // take it (see setBuilding).
    const seal = SEAL_BY_KEY.has(b.seal) ? b.seal : NO_SEAL;
    setBuilding(at, b.name, clampBuildingLevel(b.level, b.name),
      orientationOf(b.name, b.rotation), seal);
  }

  setVillageLevel(one.level);

  // A village from the api carries that player's modifiers, and so does a
  // recorded one from a finished round. A village recorded before modifiers
  // were fetched has none, and leaves the current set alone.
  const bonuses = one.modifiers === undefined ? '' : ` ${setModifiers(one.modifiers)}`;

  state.selected = null;
  render();
  showStatus(refused === 0
    ? `${one.name}'s village, hq ${one.level}.${bonuses}`
    : `${one.name}'s village, hq ${one.level}. ${plural(refused, 'building')} would not fit.${bonuses}`);
  recompute();
}

playerSelect.addEventListener('change', () => {
  const id = Number(playerSelect.value);
  const found = villagesByGame.get(state.game) ?? [];
  const one = found.find((p) => p.id === id);
  if (one !== undefined) usePlayer(one);
  playerSelect.value = '';
});

/* ------------------------------ saved layouts ----------------------------- */

/* Layouts stored by name in this browser: the grid and the village level
   only. Modifiers describe the player rather than the village, so loading a
   layout leaves them unchanged. */
const SAVES_MAX = 50;

const savesOpenButton = document.getElementById('saves-open');
const savesModal = document.getElementById('saves-modal');
const saveForm = document.getElementById('save-form');
const saveName = document.getElementById('save-name');
const saveList = document.getElementById('save-list');
const savesNote = document.getElementById('saves-note');

// Read through common.js, which both pages check the same shape against.
const readSaves = readPlannerSaves;

function writeSaves(list) {
  try {
    localStorage.setItem(PLANNER_SAVES, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function showSavesNote(message) {
  savesNote.textContent = message;
}

// Newest first, since the one just saved is the one most likely wanted.
function renderSaves() {
  const saved = readSaves();
  saveList.replaceChildren();

  if (saved.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'save-empty';
    empty.textContent = 'Nothing saved yet.';
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
    load.addEventListener('click', () => loadSaved(one.name));

    // Two clicks to delete: there is no undo for a saved layout, and the
    // button is adjacent to Load.
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
      dropSaved(one.name);
    });

    row.append(name, when, load, drop);
    saveList.append(row);
  }
}

function loadSaved(name) {
  const one = readSaves().find((s) => s.name === name);
  if (one === undefined) {
    renderSaves();
    return;
  }

  loadLayout(one.layout).then(() => {
    state.selected = null;
    render();
    recompute();
    hideModal();
    showStatus(`Loaded “${name}”.`);
  }).catch((err) => {
    showSavesNote(`Could not load “${name}”: ${reason(err)}`);
  });
}

function dropSaved(name) {
  writeSaves(readSaves().filter((one) => one.name !== name));
  renderSaves();
  showSavesNote(`Deleted “${name}”.`);
}

saveForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const name = saveName.value.trim();
  if (name === '') {
    showSavesNote('Give it a name first.');
    saveName.focus();
    return;
  }

  const saved = readSaves();
  const already = saved.findIndex((one) => one.name === name);
  if (already === -1 && saved.length >= SAVES_MAX) {
    showSavesNote(`${SAVES_MAX} saved layouts is the limit. Delete one first.`);
    return;
  }

  const entry = { name, layout: layoutText(), at: Date.now() };
  if (already !== -1) saved.splice(already, 1);
  saved.unshift(entry);

  if (!writeSaves(saved)) {
    showSavesNote('This browser would not store it. Its storage may be full.');
    return;
  }

  saveName.value = '';
  renderSaves();
  showSavesNote(already === -1 ? `Saved “${name}”.` : `Replaced “${name}”.`);
});

savesOpenButton.addEventListener('click', () => {
  showSavesNote('');
  saveName.value = '';
  renderSaves();
  showModal(savesModal, saveName);
});

/* ---------------------------- export and import --------------------------- */


const shareModal = document.getElementById('share-modal');
const shareOpenButton = document.getElementById('share-open');
const shareText = document.getElementById('share-text');
const shareModifiers = document.getElementById('share-modifiers');
const shareNote = document.getElementById('share-note');
const modifiersPanel = document.getElementById('modifiers-panel');


let openModal = null;
let modalReturn = null;

function showModal(modal, focus) {
  if (openModal !== null) hideModal();
  modalReturn = document.activeElement;
  openModal = modal;
  modal.hidden = false;
  if (focus && typeof focus.focus === 'function') focus.focus();
}

function hideModal() {
  if (openModal === null) return;
  openModal.hidden = true;
  openModal = null;
  if (modalReturn && typeof modalReturn.focus === 'function') modalReturn.focus();
  modalReturn = null;
}

document.querySelectorAll('.modal [data-close]').forEach((el) => {
  el.addEventListener('click', hideModal);
});

function showShareNote(message) {
  shareNote.textContent = message;
}

shareOpenButton.addEventListener('click', () => {
  showShareNote('');
  showModal(shareModal, shareText);
});

/* ------------------------------ settings ------------------------------ */

const settingsModal = document.getElementById('settings-modal');
const engineNote = document.getElementById('engine-note');

function renderSettings() {
  engineNote.hidden = engine !== null;
  engineNote.textContent = engine === null ? (engineTrouble ?? 'Loading the engine…') : '';
  renderEffort();
}

// The recovery path if a stored village or setting ever becomes unreadable:
// nothing is migrated, so this discards it.
document.getElementById('clear-storage').addEventListener('click', () => {
  clearTimeout(saveTimer); // a queued save would write it all back
  saveTimer = null;

  try {
    localStorage.removeItem(VILLAGE);
    localStorage.removeItem(VIEW);
    localStorage.removeItem(PLANNER_SAVES);
    sessionStorage.removeItem(UNDO_HISTORY);
  } catch {
    // Nothing to clear if storage was never available.
  }

  location.reload();
});

const effortChoice = document.getElementById('effort-choice');
const effortNote = document.getElementById('effort-note');
const effortInput = Object.fromEntries(
  EFFORT_FIELDS.map((name) => [name, document.getElementById(`effort-${name}`)]),
);

function currentEffort() {
  return state.effort === 'custom' ? state.customEffort : EFFORTS[state.effort];
}

/* How many tiles the search may terraform. 0 leaves the map's own terrain
   unchanged, which is what the engine does by default. */
function terraformSpec() {
  if (!state.terraform.allowed) return 'terraform=0';
  return state.terraform.unlimited ? 'terraform=unlimited' : `terraform=${state.terraform.tiles}`;
}

function effortSpec() {
  const limits = currentEffort();
  return `${EFFORT_FIELDS.map((name) => `${name}=${limits[name]}`).join(',')},${terraformSpec()}`;
}

function renderEffort() {
  effortChoice.querySelectorAll('[data-effort]').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.effort === state.effort ? 'true' : 'false');
  });

  const custom = state.effort === 'custom';
  const limits = currentEffort();

  for (const name of EFFORT_FIELDS) {
    const shown = String(limits[name]);
    if (effortInput[name].value !== shown) effortInput[name].value = shown;
    effortInput[name].disabled = !custom;
  }

  effortNote.textContent = {
    fast: 'Half the time of Normal, and within 4% of its own best run.',
    normal: 'The default. Reaches the same result as far heavier settings.',
    thorough: 'For big villages: 2.7× the restarts, so a run is less likely to fall short.',
  }[state.effort] ?? '';
}

effortChoice.querySelectorAll('[data-effort]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.effort === btn.dataset.effort) return;
    if (btn.dataset.effort === 'custom') state.customEffort = { ...EFFORTS[state.effort] ?? state.customEffort };
    state.effort = btn.dataset.effort;
    renderEffort();
    saveSoon();
  });
});

for (const name of EFFORT_FIELDS) {
  const box = effortInput[name];
  box.addEventListener('input', () => {
    const typed = Number(box.value);
    if (box.value === '' || !Number.isFinite(typed) || typed < 1) return;
    state.customEffort[name] = Math.round(typed);
    renderEffort();
    saveSoon();
  });
  box.addEventListener('change', () => {
    const typed = Math.round(Number(box.value));
    state.customEffort[name] = Number.isFinite(typed) && typed >= 1
      ? Math.min(typed, Number(box.max))
      : state.customEffort[name];
    renderEffort();
    saveSoon();
  });
}

document.getElementById('settings-open').addEventListener('click', () => {
  renderSettings();
  showModal(settingsModal, document.getElementById('settings-close'));
});

function exportText() {
  const payload = { v: 1, layout: layoutText() };
  if (shareModifiers.checked) payload.modifiers = { ...state.modifiers };
  return toBase64(JSON.stringify(payload));
}

async function importText(text) {
  if (!String(text).trim()) throw new Error('Nothing to import. Paste a layout string first.');

  let payload = null;
  try {
    payload = JSON.parse(fromBase64(text));
  } catch {
    throw new Error('That does not look like an exported layout.');
  }

  if (payload === null || typeof payload !== 'object' || payload.v !== 1 || typeof payload.layout !== 'string') {
    throw new Error('That does not look like an exported layout.');
  }
  await loadLayout(payload.layout);

  if (!shareModifiers.checked) return 'Layout imported. Game modifiers left as they were.';
  if (applyModifiers(payload.modifiers)) return 'Layout and game modifiers imported.';
  return 'Layout imported. That string carries no game modifiers.';
}

document.getElementById('share-export').addEventListener('click', () => {
  shareText.value = exportText();
  shareText.select();
  showShareNote(`${shareText.value.length} characters, ready to copy.`);
  saveSoon();
});

document.getElementById('share-copy').addEventListener('click', async () => {
  if (!shareText.value) {
    showShareNote('Press Export first. There is nothing to copy yet.');
    return;
  }
  shareText.select();
  try {
    await navigator.clipboard.writeText(shareText.value);
    showShareNote('Copied to the clipboard.');
  } catch {
    showShareNote('Selected. Copy it with Ctrl+C.');
  }
});

document.getElementById('share-import').addEventListener('click', async () => {
  try {
    const outcome = await importText(shareText.value);
    state.selected = null;
    render();
    recompute();
    showShareNote(outcome);
  } catch (err) {
    showShareNote(reason(err));
    showStatus(reason(err), true);
  }
});


/* --------------------------- fetch from the game ---------------------------

   /api/game/<id>/hq/effects returns the modifiers over one player's village,
   and /hq/spectate/<pid>/{info,effects} the same for a teammate. Both need the
   player's bearer token, so instead of asking for it this generates a script
   the player runs in their own browser console, where localStorage.apiToken
   already is. They paste the result back here.

   Only village-wide sources are read. Details the api attributes to a
   building, the hq, or the base are skipped: the grid computes those, so
   reading them here would double-count them. */

const EFFECTS_API = 'https://api.factions-online.com/api/game';

// event_type values that denote a season.
const SEASON_TYPES = ['SPRING', 'SUMMER', 'FALL', 'AUTUMN', 'WINTER'];

// Engine efficiency key -> the api's subtype under `world`.
const WORLD_SUBTYPE = {
  attack: 'attack',
  defense: 'defense',
  worker: 'worker',
  map: 'map_efficiency',
  projects: 'worker_project_efficiency',
};

/* And the same for the powers. Support power has no column of its own: the api
   reports what it grants inside both knightPower and guardianPower, so an
   import fills those two and leaves support at its neutral rather than
   counting the same bonus twice. */
const WORLD_POWER_SUBTYPE = {
  knight: 'knightPower',
  guardian: 'guardianPower',
};

// Where each modifier column lives in an effects reply.
const EFFECT_COLUMNS = [
  ...RESOURCES.flatMap((r) => RATE_OR_CAPACITIES.map((m) => ({ id: `${r.key}.${m.key}`, section: m.key, subtype: r.key }))),
  ...EFFICIENCIES.map((e) => ({
    id: `${SCHEMA.efficiencyField}.${e.key}`, section: 'world', subtype: WORLD_SUBTYPE[e.key],
  })),
  ...POWERS.filter((p) => WORLD_POWER_SUBTYPE[p.key] !== undefined).map((p) => ({
    id: `${p.key}.${SCHEMA.powerField}`, section: 'world', subtype: WORLD_POWER_SUBTYPE[p.key],
  })),
  ...UNITS.map((u) => ({ id: `${u.key}.${SCHEMA.unitField}`, section: SCHEMA.unitField, subtype: u.key })),
];

/* The perk trees a player buys from. The api names such a detail after the
   tree rather than after the quantity it increases: a builder's worker
   efficiency is a detail from "builder" on world.worker, an attacker's attack
   efficiency one from "attack" on world.attack. A player may buy from any
   tree, so which of these appear says nothing about their specialisation.

   Each reports a percentage in `bonus`, which is what the specialisation
   source of its column holds. Read off the finished rounds 122 and 139. The
   merchant tree is excluded: it reports a multiplier over wood and iron
   production rather than a share, which this source cannot hold. */
const PERK_TREES = new Set(['attack', 'defense', 'builder']);

/* Structures on the world map. The api names them in capitals like a
   building, but none stands on the grid, so their contribution must be read
   off the reply rather than computed from the board. A shrine gives a share of
   what a village produces and stores; a trading post gives an amount nothing
   scales, as redistribution does. Read off the finished round 139, where 603
   shrine entries increased worker production by 24.5% to 43%. */
const WORLD_STRUCTURES = new Set(['SHRINE', 'TRADING_POST']);

/* Modifier sources use the api's own `from` value where the two agree; this
   maps the two that differ. terrain_flat is excluded: the api writes it as the
   terrain detail's `base`. */
const API_NAME_OF_SOURCE = { seasonal_events: 'events', event_projects: 'competitive_projects' };
const SOURCE_BY_API_NAME = new Map(MODIFIER_SOURCES.filter((row) => !row.addedBefore)
  .map((row) => [API_NAME_OF_SOURCE[row.key] ?? row.key, row]));

const TERRAIN_SOURCE = 'terrain';
const TERRAIN_FLAT_SOURCE = 'terrain_flat';
const SPECIALISATION_SOURCE = 'specialisation';
const SHRINE_SOURCE = 'shrine';
const REDISTRIBUTION_SOURCE = 'redistribution';

/* Where a bonus goes when the source carrying it is a factor source. The api
   writes such a bonus on whichever source it came from (projects, talents),
   but it is a share of the same sum the buildings feed, adding to every other
   share there. The engine holds one value per source, so these shares are all
   collected on this one. */
const SHARE_SOURCE = 'event_projects';

// Every building this round allows, under the api's name for it. A function
// declaration, so the pasted script can be built from it at any point.
function buildingNamesOf(id) {
  return (GAME_BY_ID.get(id)?.shapes ?? []).map((one) => one.building);
}

const POLITICS_FROM = 'political_system';
const POLITICS_OF_RESOURCE = { wood: 'resource', iron: 'resource', workers: 'worker', soldiers: 'soldier' };

// The sections and subtypes readColumn uses, derived from EFFECT_COLUMNS so
// the script and the reader cannot diverge. Trimming to these roughly halves
// the pasted text.
function wantedFields() {
  const want = {};
  for (const { section, subtype } of EFFECT_COLUMNS) (want[section] ??= []).push(subtype);
  return want;
}

/* The script the player runs, for one round and one of three selections:
   their own village, every village in their faction, or a chosen subset of the
   players the last whole-faction read found. `who` is 'you', 'faction', or a
   list of player ids.

   The api defines the faction, not this script: spectate returns 200 for one's
   own faction and 403 for any other, so filtering the leaderboard by the
   faction in hq/info yields exactly the spectatable set. The player is in that
   set too, identified by hq id rather than by name. */
const fetchScriptFor = (game, who) => `(async () => {
  const token = (localStorage.apiToken || '').replace(/^"|"$/g, '');
  if (!token) return console.error('No apiToken here. Log in to factions-online.com in this tab first.');

  const api = '${EFFECTS_API}/${game}';
  const only = ${JSON.stringify(who === 'faction' ? null : who)};
  const want = ${JSON.stringify(wantedFields())};
  const onTheGrid = ${JSON.stringify([...buildingNamesOf(game), 'HQ'])};
  const get = async (path) => {
    const reply = await fetch(api + path, { headers: { authorization: 'Bearer ' + token } });
    if (!reply.ok) throw new Error(path + ': ' + reply.status + ' ' + reply.statusText);
    return reply.json();
  };

  const trim = (effects) => {
    const kept = {};
    for (const [section, subtypes] of Object.entries(want)) {
      for (const subtype of subtypes) {
        const details = (((effects || {})[section] || {})[subtype] || {}).details || [];
        const mine = details.filter((d) => typeof d.from === 'string'
          && (d.from !== d.from.toUpperCase() || !onTheGrid.includes(d.from)));
        if (mine.length) ((kept[section] ??= {})[subtype] = { details: mine });
      }
    }
    return kept;
  };

  const seasonNames = ${JSON.stringify(SEASON_TYPES)};
  let seasons = [];
  let seasonNow = -1;
  try {
    const events = await get('/events/list');
    const found = (Array.isArray(events) ? events : [])
      .filter((e) => seasonNames.includes(e.event_type))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    seasonNow = found.findIndex((e) => e.started && !e.ended);
    seasons = found.map((e) => ({ name: e.event_type, start: e.start, end: e.end }));
  } catch (err) {
    console.warn('no seasons read: ' + err.message);
  }

  const me = await get('/hq/info');
  const faction = (me.hq || {}).faction;

  let mates;
  if (only === 'you') {
    mates = [{ playerId: null, name: 'You', faction }];
  } else {
    const board = await get('/leaderboard');
    mates = board.filter((e) => e.faction === faction && e.playerId != null
      && (only === null || only.includes(e.playerId)));
    if (!mates.length) return console.error('None of the chosen players are in ' + faction + ' this round.');
  }
  console.log('Reading ' + mates.length + ' ' + faction + ' village' + (mates.length === 1 ? '' : 's') + '...');

  const players = [];
  for (const entry of mates) {
    const yours = entry.playerId === null;
    let seen;
    let effects;
    try {
      seen = yours ? me : await get('/hq/spectate/' + entry.playerId + '/info');
      effects = await get(yours ? '/hq/effects' : '/hq/spectate/' + entry.playerId + '/effects');
    } catch (err) {
      console.warn(entry.name + ' skipped: ' + err.message);
      continue;
    }
    const grid = seen.grid || {};
    if (!grid.terrain) continue;
    const where = grid.hqPosition || {};

    const sealOn = new Map();
    for (const module of seen.modules || []) {
      if (module.installed_on != null) sealOn.set(module.installed_on, module.module_type);
    }
    players.push({
      id: entry.playerId ?? (me.hq || {}).id,
      name: entry.name || ('#' + entry.playerId),
      faction: entry.faction || '',
      you: (seen.hq || {}).id === (me.hq || {}).id,
      level: (seen.hq || {}).level || 1,
      hqX: where.x, hqY: where.y,
      terrain: grid.terrain.flat(),
      terraformed: (grid.terraformedTiles || []).map((at) => {
        const [tx, ty] = String(at).split(',').map(Number);
        return ty * 10 + tx;
      }),
      terrainBonusFactor: grid.terrainBonusFactor || 1,
      buildings: (seen.buildings || [])
        .filter((b) => b.gridX != null && b.gridY != null)
        .map((b) => ({
          name: b.name, level: b.level || 1, x: b.gridX, y: b.gridY, rotation: b.rotation || 0,
          seal: sealOn.get(b.id) || 'NONE',
        })),
      effects: trim(effects),
    });
  }

  const text = JSON.stringify({ v: 1, game: ${game}, faction, seasons, seasonNow, players });

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.7);'
    + 'display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif';

  const card = document.createElement('div');
  card.style.cssText = 'background:#1b1b1f;color:#eee;border-radius:8px;padding:14px;'
    + 'width:min(680px,90vw);display:flex;flex-direction:column;gap:10px';

  const said = document.createElement('div');
  said.textContent = players.length + ' ' + faction + ' villages, ' + text.length
    + ' characters. Copy this and paste it into the solver.';

  const area = document.createElement('textarea');
  area.readOnly = true;
  area.value = text;
  area.style.cssText = 'width:100%;height:180px;background:#111;color:#ddd;border:1px solid #444;'
    + 'border-radius:6px;padding:8px;font:12px monospace';

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
  const copyButton = document.createElement('button');
  copyButton.textContent = 'Copy';
  const closeButton = document.createElement('button');
  closeButton.textContent = 'Close';
  for (const button of [copyButton, closeButton]) {
    button.style.cssText = 'padding:6px 14px;border-radius:6px;border:1px solid #555;'
      + 'background:#2a2a30;color:#eee;cursor:pointer';
  }

  copyButton.addEventListener('click', async () => {
    area.focus();
    area.select();
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      document.execCommand('copy');
    }
    copyButton.textContent = 'Copied';
  });
  closeButton.addEventListener('click', () => box.remove());
  box.addEventListener('keydown', (event) => { if (event.key === 'Escape') box.remove(); });

  buttons.append(copyButton, closeButton);
  card.append(said, area, buttons);
  box.append(card);
  document.body.append(box);
  area.focus();
  area.select();

  console.log(players.length + ' villages read. Copy them from the box on this page.');
})();`;

const finite = (value) => (Number.isFinite(value) ? value : null);

/* Reads one quantity's details into the fields they set. A share is a
   percentage, a factor is the multiplier itself, and raw_value is added after
   both. Building-sourced details are skipped: the grid computes those. */
function readColumn(details, id, into) {
  for (const detail of details ?? []) {
    if (detail === null || typeof detail !== 'object') continue;

    /* What a shrine or trading post contributes, classified by the kind of
       quantity rather than by the structure: a share onto the shrine source, an
       amount onto the source added after every multiplier. */
    if (WORLD_STRUCTURES.has(detail.from)) {
      const share = finite(detail.bonus);
      const amount = finite(detail.raw_value);
      if (share) into[`${id}.${SHRINE_SOURCE}`] = (into[`${id}.${SHRINE_SOURCE}`] ?? 0) + share;
      if (amount) into[`${id}.${REDISTRIBUTION_SOURCE}`] = (into[`${id}.${REDISTRIBUTION_SOURCE}`] ?? 0) + amount;
      continue;
    }

    // A perk, named after the tree it was bought from.
    if (PERK_TREES.has(detail.from)) {
      const share = finite(detail.bonus);
      if (share !== null) into[`${id}.${SPECIALISATION_SOURCE}`] = (into[`${id}.${SPECIALISATION_SOURCE}`] ?? 0) + share;
      continue;
    }

    // terrain carries both a share (bonus) and a flat amount (base).
    if (detail.from === TERRAIN_SOURCE) {
      const share = finite(detail.bonus);
      const amount = finite(detail.base);
      if (share !== null) into[`${id}.${TERRAIN_SOURCE}`] = (into[`${id}.${TERRAIN_SOURCE}`] ?? 0) + share;
      if (amount !== null) into[`${id}.${TERRAIN_FLAT_SOURCE}`] = (into[`${id}.${TERRAIN_FLAT_SOURCE}`] ?? 0) + amount;
      continue;
    }

    const source = SOURCE_BY_API_NAME.get(detail.from);
    if (source === undefined) continue;

    const field = MODIFIER_BY_ID.get(`${id}.${source.key}`);
    if (field === undefined) continue; // a source this column does not carry

    if (field.addedAfter) {
      const amount = finite(detail.raw_value);
      if (amount !== null) into[field.id] = (into[field.id] ?? 0) + amount;
    } else if (field.percent) {
      const share = finite(detail.bonus);
      if (share !== null) into[field.id] = (into[field.id] ?? 0) + share;
    } else {
      /* A factor source, which the api may write both ways at once: the
         multiplier applies over everything, while the bonus is a share of the
         same sum the buildings feed and adds to the other shares there. They
         go to different sources, since each source holds one value. */
      const factor = finite(detail.multiplier) ?? 1;
      if (factor !== 1) into[field.id] = (into[field.id] ?? 1) * factor;

      const share = finite(detail.bonus) ?? 0;
      if (share !== 0) into[`${id}.${SHARE_SOURCE}`] = (into[`${id}.${SHARE_SOURCE}`] ?? 0) + share;
    }
  }
}

// quests and balance apply to every quantity, so any column naming one reports
// the same value. The engine applies balance to production only and quests to
// everything, matching the api.
function readGlobalFactor(reply, id, from) {
  for (const { section, subtype } of EFFECT_COLUMNS) {
    for (const detail of reply[section]?.[subtype]?.details ?? []) {
      if (detail?.from !== from) continue;
      const factor = finite(detail.multiplier);
      if (factor !== null) return { [id]: factor };
    }
  }
  return {};
}

// The politics choice is which production carries political_system.
function readPolitics(reply) {
  for (const [resource, choice] of Object.entries(POLITICS_OF_RESOURCE)) {
    for (const detail of reply.production?.[resource]?.details ?? []) {
      if (detail?.from === POLITICS_FROM && finite(detail.multiplier) !== null && detail.multiplier !== 1) {
        return { [POLITICS_ID]: choice };
      }
    }
  }
  return {};
}

/* Converts an effects reply into the fields applyModifiers takes, in the
   units the inputs use: a share as a percentage, a factor as itself, an amount
   as the amount.

   market_tax_reduction is not read. Only a merchant's perk is known to grant
   one and no route reports it: hq/config has no specialisation data, and
   buildings/market_tax returns a flat 40 for every specialisation. */
function modifiersFromEffects(reply) {
  const fields = {};
  if (reply === null || typeof reply !== 'object') return fields;

  for (const { id, section, subtype } of EFFECT_COLUMNS) {
    readColumn(reply[section]?.[subtype]?.details, id, fields);
  }

  Object.assign(fields, readGlobalFactor(reply, 'quests', 'quests'));
  Object.assign(fields, readGlobalFactor(reply, 'balance', 'balance'));
  Object.assign(fields, readPolitics(reply));

  // Rounded to the precision serialize() sends, so the inputs display the
  // value actually applied.
  for (const [id, value] of Object.entries(fields)) {
    if (typeof value === 'number') fields[id] = Number(value.toFixed(4));
  }

  return fields;
}

/* The players in a reply, in the shape data/players uses, plus each player's
   modifiers. usePlayer applies both, so a village loaded from here brings its
   own modifiers rather than inheriting the previous player's. */
function parseRoster(reply) {
  if (reply === null || typeof reply !== 'object' || !Array.isArray(reply.players)) return null;

  const found = [];
  for (const one of reply.players) {
    if (one === null || typeof one !== 'object') continue;
    if (!Array.isArray(one.terrain) || one.terrain.length !== TILE_COUNT) continue;
    if (!Number.isInteger(one.hqX) || !Number.isInteger(one.hqY)) continue;
    // On the leaderboard but has built nothing.
    if (!Array.isArray(one.buildings) || one.buildings.length === 0) continue;

    found.push({
      id: one.id,
      name: typeof one.name === 'string' && one.name !== '' ? one.name : `#${one.id}`,
      faction: one.faction ?? '',
      you: one.you === true,
      level: Number.isFinite(one.level) ? one.level : 1,
      hqX: one.hqX,
      hqY: one.hqY,
      terrain: one.terrain,
      terraformed: Array.isArray(one.terraformed) ? one.terraformed.filter(Number.isInteger) : [],
      terrainBonusFactor: Number.isFinite(one.terrainBonusFactor) ? one.terrainBonusFactor : 1,
      buildings: one.buildings,
      modifiers: modifiersFromEffects(one.effects),
    });
  }

  found.sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
  return found;
}

/* Replaces the compiled-in season list, which the api extends as a round runs
   and seasonNow advances.

   Accepted only when both lists agree on the seasons they share, because the
   engine prices against its own seasonNow and indexes from the front: a list
   missing its early seasons would shift every index. */
function updateSeasons(id, seasons) {
  const game = GAME_BY_ID.get(id);
  if (game === undefined || !Array.isArray(seasons) || seasons.length === 0) return false;
  if (seasons.length < game.seasons.length) return false;

  for (let i = 0; i < game.seasons.length; i += 1) {
    if (Date.parse(game.seasons[i].start) !== Date.parse(seasons[i].start)) return false;
  }

  game.seasons = seasons.map((one) => ({ name: one.name, start: one.start, end: one.end }));
  return true;
}

const pullModal = document.getElementById('pull-modal');
const pullGame = document.getElementById('pull-game');
const pullScript = document.getElementById('pull-script');
const pullReply = document.getElementById('pull-reply');
const pullNote = document.getElementById('pull-note');
const pullOpen = document.getElementById('pull-open');
const pullWhoSelect = document.getElementById('pull-who');
const pullMembers = document.getElementById('pull-members');
const pullMembersNote = document.getElementById('pull-members-note');
const pullMemberList = document.getElementById('pull-member-list');

// Only an ongoing round can be queried for its players; a finished round's
// villages are in data/players.
const ONGOING_GAMES = GAMES.filter((g) => g.ongoing);

// A round's faction membership, stored from the last whole-faction read so
// its members can be selected next time. Names and ids only.
const ROSTER = 'factions-solver/roster/v1';

function rosterOf(game) {
  const kept = readJson(ROSTER);
  const found = kept === null ? null : kept[String(game)];
  return Array.isArray(found) ? found : [];
}

// Merged rather than replaced: reading one's own village alone would
// otherwise discard the membership the last whole-faction read found.
function rememberRoster(game, players) {
  const kept = readJson(ROSTER) ?? {};
  const known = new Map(rosterOf(game).map((one) => [one.id, one]));
  for (const one of players) known.set(one.id, { id: one.id, name: one.name });
  kept[String(game)] = [...known.values()];
  writeJson(ROSTER, kept);
}

function pullGameNow() {
  return Number(pullGame.value) || ONGOING_GAMES[0]?.id || state.game;
}

// Whose villages to read: 'you', 'faction', or the ids selected below.
function pullWho() {
  if (pullWhoSelect.value !== 'chosen') return pullWhoSelect.value;
  return [...pullMemberList.querySelectorAll('input:checked')].map((box) => Number(box.value));
}

/* The faction members to select from, which only a whole-faction read can
   populate. Selections survive a re-render while the panel is open. */
function renderPullMembers() {
  const chosen = pullWhoSelect.value === 'chosen';
  pullMembers.hidden = !chosen;
  if (!chosen) return;

  const ticked = new Set([...pullMemberList.querySelectorAll('input:checked')].map((box) => box.value));
  const roster = rosterOf(pullGameNow());
  pullMemberList.replaceChildren();

  pullMembersNote.textContent = roster.length === 0
    ? 'Nobody known yet for this round: read the whole faction once, and its members can be picked from here after that.'
    : 'Tick who to read.';

  for (const one of roster) {
    const label = document.createElement('label');
    label.className = 'pull-member';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = String(one.id);
    box.checked = ticked.size === 0 ? false : ticked.has(String(one.id));
    box.addEventListener('change', renderPullScript);
    label.append(box, document.createTextNode(one.name));
    pullMemberList.append(label);
  }
}

function renderPullScript() {
  const who = pullWho();
  renderPullMembers();

  if (Array.isArray(who) && who.length === 0) {
    pullScript.value = rosterOf(pullGameNow()).length === 0
      ? 'Read the whole faction once first: this list is built from what that finds.'
      : 'Tick at least one member above.';
    return;
  }

  pullScript.value = fetchScriptFor(pullGameNow(), who);
}

for (const game of ONGOING_GAMES) addOption(pullGame, String(game.id), `${game.id} · ${game.map.replace(/_/g, ' ').toLowerCase()}`);

pullOpen.hidden = ONGOING_GAMES.length === 0;

pullGame.addEventListener('change', renderPullScript);
pullWhoSelect.addEventListener('change', renderPullScript);

pullOpen.addEventListener('click', () => {
  const here = ONGOING_GAMES.find((g) => g.id === state.game) ?? ONGOING_GAMES[0];
  if (here === undefined) return;
  pullGame.value = String(here.id);
  renderPullScript();
  pullNote.textContent = '';
  showModal(pullModal, pullReply);
});

document.getElementById('pull-copy').addEventListener('click', async () => {
  pullScript.select();
  try {
    await navigator.clipboard.writeText(pullScript.value);
    pullNote.textContent = "Script copied. Paste it into the game tab's console.";
  } catch {
    pullNote.textContent = 'Selected. Copy it with Ctrl+C.';
  }
});

// Fields no reply reports, which an import leaves as entered.
const MANUAL_ONLY = ['market_tax_reduction'];

// Applies a whole modifier set: anything the reply omits returns to its
// neutral, except MANUAL_ONLY. Returns a one-line summary.
function setModifiers(fields) {
  const settled = {
    ...Object.fromEntries(GAME_MODIFIERS.map((m) => [m.id, m.neutral])),
    [POLITICS_ID]: NO_POLITICS,
    ...Object.fromEntries(MANUAL_ONLY.map((id) => [id, state.modifiers[id]])),
    ...fields,
  };
  applyModifiers(settled);
  renderModifierPanel(state.modifiers);

  const set = GAME_MODIFIERS.filter((m) => state.modifiers[m.id] !== m.neutral).length;
  const politics = state.modifiers[POLITICS_ID];
  const chosen = politics === NO_POLITICS ? 'no politics' : `${politics} politics`;
  const tax = state.modifiers.market_tax_reduction === 0 ? ''
    : ` Market tax reduction kept at ${state.modifiers.market_tax_reduction}; the api does not report it.`;

  return set === 0 ? 'No modifiers.' : `${plural(set, 'modifier')}, ${chosen}.${tax}`;
}

document.getElementById('pull-apply').addEventListener('click', () => {
  let reply;
  try {
    reply = JSON.parse(pullReply.value.trim());
  } catch {
    pullNote.textContent = 'Failed to parse; try copying the output again.';
    return;
  }

  const game = Number(pullGame.value) || state.game;
  const roster = parseRoster(reply);

  // A bare effects reply: one player's modifiers, no village.
  if (roster === null) {
    const fields = modifiersFromEffects(reply);
    if (Object.keys(fields).length === 0) {
      pullNote.textContent = 'No villages or modifiers in that reply.';
      return;
    }
    const said = setModifiers(fields);
    recompute();
    saveSoon();
    pullNote.textContent = `Modifiers only: ${said}`;
    return;
  }

  if (roster.length === 0) {
    pullNote.textContent = 'No villages in that reply.';
    return;
  }

  // Villages are stored where a finished round's recorded ones go, so the
  // same "Load a village" list and loading code serve both.
  villagesByGame.set(game, roster);
  rememberRoster(game, roster);
  if (game !== state.game) useGame(game);
  villagesAsked = state.game;
  renderPlayers(roster);

  const seasons = updateSeasons(game, reply.seasons) ? ' Updated seasons list.' : '';
  renderSeasons();

  const you = roster.find((one) => one.you) ?? roster[0];
  usePlayer(you);

  const mine = you.you ? 'your village' : `${you.name}'s village`;
  pullNote.textContent = `${plural(roster.length, 'village')} read in, ${mine} on the board.`
    + ' Load a village at the top.' + seasons;
});

shareModifiers.addEventListener('change', saveSoon);
modifiersPanel.addEventListener('toggle', saveSoon);

if (restored !== null) {
  document.getElementById('show-output').checked = state.showOutput;
  balanceBox.checked = state.balance;
  soldierModeSelect.value = state.soldierMode;
  workerModeSelect.value = state.workerMode;
  renderUnitChoice();
  marketBox.checked = state.marketGoals;
  shareModifiers.checked = restored.shareModifiers === true;
  modifiersPanel.open = restored.modifiersOpen === true;
}

renderGames();
renderSeasons();
renderGoals();
renderTerraform();
setMode(state.mode);
showView(state.panel);
render();

// The stored layout, the undo history and the first costing all wait on the
// engine, which parses the layout the others are built from. See engineReady.
