'use strict';

importScripts('engine.js');

let engine = null;
const ready = createEngine().then((module) => {
  engine = module;
});

self.onmessage = async ({ data }) => {
  const { id, body, goal, effort } = data;

  try {
    await ready;

    const pointers = [body, goal, effort ?? ''].map((text) => engine.stringToNewUTF8(text));
    const out = engine.ccall('apiRearrange', 'number', ['number', 'number', 'number'], pointers);
    for (const pointer of pointers) engine._free(pointer);

    const answer = engine.UTF8ToString(out);
    engine._apiFree(out);

    if (answer.startsWith('!')) self.postMessage({ id, ok: false, text: answer.slice(1) });
    else self.postMessage({ id, ok: true, text: answer });
  } catch (err) {
    self.postMessage({ id, ok: false, text: String((err && err.message) || err) });
  }
};
