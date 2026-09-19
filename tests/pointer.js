/* Drives the simulator page in a real Chrome over the debugging protocol.

   jsdom implements neither elementFromPoint nor pointer capture, so the drag
   and the press that turns out to be a click cannot be reached from
   tests/simulator.js at all. Both have already been broken once by a change
   that every other check passed, which is why this exists.

   Needs a Chrome already listening on the debugging port with the page open,
   and `ws`. tests/run.sh starts both, or skips this if it cannot. */
const WebSocket = require('ws');

const port = Number(process.argv[2] ?? 9222);

async function http(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.json();
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

let id = 0;
function send(ws, method, params = {}) {
  const at = ++id;
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id !== at) return;
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id: at, method, params }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pages = await http('/json/list');
  const page = pages.find((p) => p.type === 'page' && p.url.includes('simulator'));
  if (!page) throw new Error(`no simulator page open: ${pages.map((p) => p.url).join(', ')}`);

  const ws = await connect(page.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');

  const evaluate = async (expression) => {
    const out = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception.description);
    return out.result.value;
  };

  const centreOf = (i) => evaluate(`(() => {
    const r = document.querySelectorAll('.tile')[${i}].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);

  const mouse = (type, at, extra = {}) => send(ws, 'Input.dispatchMouseEvent', {
    type, x: at.x, y: at.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra,
  });

  await evaluate("localStorage.clear()");
  await send(ws, 'Page.enable');
  await send(ws, 'Page.reload');
  await wait(2500);
  // The page can be taller than the window, and a restored scroll position
  // would put the board outside where the events below are aimed.
  await evaluate('window.scrollTo(0, 0)');

  // The tile the centre stands on, and two bare tiles that can hold a building.
  const board = await evaluate(`(() => {
    const tiles = [...document.querySelectorAll('.tile')];
    const centre = tiles.findIndex((t) => !t.querySelector('img.art').hidden);
    const free = tiles.map((t, i) => i)
      .filter((i) => i !== centre && !tiles[i].classList.contains('no-build'));
    return { centre, first: free[0], second: free[1] };
  })()`);

  const said = [];
  const steps = () => evaluate("[...document.querySelectorAll('.step')].map((s) => [...s.children].map((c) => c.textContent).join(' '))");
  const standingOn = () => evaluate("[...document.querySelectorAll('.tile')].findIndex((t) => !t.querySelector('img.art').hidden)");

  const drag = async (a, b) => {
    await evaluate('window.scrollTo(0, 0)');
    const from = await centreOf(a);
    const to = await centreOf(b);
    await mouse('mousePressed', from);
    for (let n = 1; n <= 6; n += 1) {
      await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * n) / 6, y: from.y + ((to.y - from.y) * n) / 6 });
      await wait(30);
    }
    await mouse('mouseReleased', to);
    await wait(400);
  };

  // 1. A plain click on the tile the centre stands on must open the inspector.
  const on = await centreOf(board.centre);
  await mouse('mousePressed', on);
  await mouse('mouseReleased', on);
  await wait(300);

  const inspector = await evaluate(`(() => {
    const body = document.getElementById('insp-body');
    return { open: !body.hidden, says: document.getElementById('insp-basics').textContent.trim() };
  })()`);
  said.push(inspector.open
    ? `click on a building: inspector opened, reading ${JSON.stringify(inspector.says)}`
    : 'FAIL click on a building: the inspector stayed shut');

  /* 2. At the first tick the centre stands where the village started, so
     moving it chooses that position rather than recording a step. */
  await drag(board.centre, board.first);
  const placed = { at: await standingOn(), steps: await steps() };
  said.push(placed.at === board.first && placed.steps.length === 0
    ? `centre at the first tick: moved to ${placed.at}, and no step was recorded`
    : `FAIL centre at the first tick: at ${placed.at} (wanted ${board.first}), ${placed.steps.length} steps ${JSON.stringify(placed.steps)}`);

  // 3. Once the clock has moved on, moving it is a step like any other.
  await evaluate("document.getElementById('wait').click()");
  await wait(400);
  await drag(board.first, board.second);
  const moved = await steps();
  said.push(moved.length === 2 && moved[1].includes('Move')
    ? `move after a wait: ${JSON.stringify(moved[1])}`
    : `FAIL move after a wait: ${JSON.stringify(moved)}`);

  // 4. Moved back on the same tick, it did nothing and leaves no step.
  await drag(board.second, board.first);
  const back = { steps: await steps(), at: await standingOn() };
  said.push(back.steps.length === 1 && back.at === board.first
    ? 'moved back on the same tick: the step is gone and the centre is where it was'
    : `FAIL moved back: ${back.steps.length} steps ${JSON.stringify(back.steps)}, centre at ${back.at}`);

  for (const one of said) console.log(one);
  ws.close();
  process.exit(said.some((s) => s.startsWith('FAIL')) ? 1 : 0);
}

main().catch((err) => { console.error(String(err.message || err)); process.exit(2); });
