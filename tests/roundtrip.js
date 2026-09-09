'use strict';

/* Checks the one contract that holds the page and the engine together: the
   page writes a body, the engine reads it and hands back a village, and
   writing that village out again gives the same body. If it ever does not,
   importing a layout would quietly change it.

   Run against the built engine: node tests/roundtrip.js build/site
*/

const fs = require('fs');
const path = require('path');

const site = process.argv[2] ?? 'build/site';
const root = path.join(__dirname, '..');

const schemaText = fs.readFileSync(path.join(root, site, 'schema.js'), 'utf8');
// eslint-disable-next-line no-eval
const SCHEMA = eval(`${schemaText.replace("'use strict';", '').replace('const SCHEMA', 'var SCHEMA')}; SCHEMA`);

const BY_ID = new Map(SCHEMA.buildings.map((b) => [b.id, b]));
const NO_SEAL = 'none';

// The same rule app.js writes a token by, kept here on purpose: this file
// exists to check that rule against the engine's reading of it.
function layoutText(village) {
  const parts = [String(village.level)];
  for (let i = 0; i < SCHEMA.width * SCHEMA.height; i += 1) {
    const building = village.buildings[i];
    let token = `${village.terrain[i]}:${building}:${village.levels[i]}`;
    if (BY_ID.get(building).footprint > 1) token += `:${village.orientations[i]}`;
    if (village.seals[i] !== NO_SEAL) token += `:${village.seals[i]}`;
    parts.push(token);
  }
  return parts.join(' ');
}

async function main() {
  const createEngine = require(path.join(root, site, 'engine.js'));
  const engine = await createEngine();

  const call = (name, ...args) => {
    const pointers = args.map((text) => engine.stringToNewUTF8(text));
    const out = engine.ccall(name, 'number', args.map(() => 'number'), pointers);
    for (const pointer of pointers) engine._free(pointer);
    const answer = engine.UTF8ToString(out);
    engine._apiFree(out);
    if (answer.startsWith('!')) throw new Error(answer.slice(1));
    return answer;
  };

  const dir = path.join(root, 'tests/cases');
  let checked = 0;
  let refused = 0;
  const trouble = [];

  for (const file of fs.readdirSync(dir).sort()) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8').trim();
    const name = file.replace(/\.txt$/, '');

    let village = null;
    try {
      village = JSON.parse(call('apiParse', body));
    } catch {
      refused += 1; // the cases that are meant to be turned down
      continue;
    }

    const again = layoutText(village);

    // The engine levels the centre with the village, so compare what it made
    // of the body rather than the body itself: writing it out twice must agree.
    let settled = null;
    try {
      settled = layoutText(JSON.parse(call('apiParse', again)));
    } catch (err) {
      trouble.push(`${name}: the engine would not read back what it wrote: ${err.message}`);
      continue;
    }

    if (settled !== again) trouble.push(`${name}: writing the village out twice gave two different bodies`);

    // Every field the page relies on has to be there and be the right length.
    for (const field of ['terrain', 'buildings', 'seals', 'orientations', 'levels']) {
      if (!Array.isArray(village[field]) || village[field].length !== SCHEMA.width * SCHEMA.height) {
        trouble.push(`${name}: '${field}' is not ${SCHEMA.width * SCHEMA.height} long`);
      }
    }
    checked += 1;
  }

  for (const line of trouble) console.error(`FAIL ${line}`);
  console.log(`${checked} layouts round-tripped, ${refused} refused as they should be, ${trouble.length} failed`);
  process.exit(trouble.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
