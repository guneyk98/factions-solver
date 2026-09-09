'use strict';

const fs = require('fs');
const path = require('path');

const site = process.argv[2] ?? 'build/site';
const effort = process.argv[3] ?? 'restarts=16,iterations=60000,improvementPasses=24,budget=120000';
const root = path.join(__dirname, '..');
const sitePath = path.isAbsolute(site) ? site : path.join(root, site);

const schemaPath = fs.existsSync(path.join(sitePath, 'schema.js'))
    ? path.join(sitePath, 'schema.js')
    : path.join(root, 'build/site/schema.js');
const schemaText = fs.readFileSync(schemaPath, 'utf8');
const SCHEMA = Function(`${schemaText.replace(/^"use strict";/, '')}; return SCHEMA;`)();
const player = JSON.parse(fs.readFileSync(path.join(root, 'data/players/168.json'), 'utf8'))
    .find((one) => one.name === 'silvertail');

if (player === undefined) throw new Error('game 168 Silvertail village is missing');

const buildings = new Map(SCHEMA.buildings.map((one) => [one.id, one]));
const shapes = new Map(SCHEMA.games.find((one) => one.id === 168).shapes.map((one) => [one.building, one.shape]));
const orientation = (building, rotation) => {
    const turns = ((rotation ?? 0) % 4 + 4) % 4;
    return shapes.get(building.id) === 'line' ? (turns % 2 === 0 ? 'e' : 's') : SCHEMA.orientations[turns];
};

const tiles = Array.from({ length: SCHEMA.width * SCHEMA.height }, (_, i) => `${player.terrain[i]}:NONE:0`);
tiles[player.hqY * SCHEMA.width + player.hqX] = `${player.terrain[player.hqY * SCHEMA.width + player.hqX]}:VILLAGE_CENTRE:${player.level}`;

for (const one of player.buildings) {
    const building = buildings.get(one.name);
    if (building === undefined) throw new Error(`unknown building ${one.name}`);

    let token = `${player.terrain[one.y * SCHEMA.width + one.x]}:${one.name}:${one.level}`;
    if (shapes.get(one.name) !== 'single') token += `:${orientation(building, one.rotation)}`;
    if (one.seal !== 'NONE') token += `:${one.seal}`;
    tiles[one.y * SCHEMA.width + one.x] = token;
}

const body = `${player.level} ${tiles.join(' ')} game=168`;
const goal = 'soldiers.production.attack,workers.production,soldiers.storage,workers.storage,iron.storage,wood.production,iron.production';

async function main() {
    const createEngine = require(path.join(sitePath, 'engine.js'));
    const engine = await createEngine();
    const pointers = [body, goal, effort].map((text) => engine.stringToNewUTF8(text));
    const out = engine.ccall('apiRearrange', 'number', ['number', 'number', 'number'], pointers);
    for (const pointer of pointers) engine._free(pointer);
    const answer = engine.UTF8ToString(out);
    engine._apiFree(out);
    if (answer.startsWith('!')) throw new Error(answer.slice(1));
    const result = JSON.parse(answer);
    console.log(`evaluated=${result.evaluated} moved=${result.moved}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});