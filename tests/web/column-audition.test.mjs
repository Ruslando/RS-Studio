import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { adjacentColumn } from '../../web/column-navigation.js';

const a = { start: 0, end: 2, pitch: 60 }, b = { start: 1, end: 2, pitch: 64 },
  c = { start: 1, end: 2, pitch: 67 };
const columns = [{ t0: 0, notes: [a] }, { t0: 1, notes: [b, c] }];
const lane = { notes: [a, b, c] }, S = { state: { rowH: 20 }, selection: new Set() };
let time = 0;
const heard = [], unlocks = [];
const { stepColumnFocus, stepVoiceFocus } = await mockImport(new URL('../../web/voicing.js', import.meta.url), {
  './store.js': { S, setSelection: notes => { S.selection = notes; } },
  './dom.js': { scroll: { clientWidth: 100, clientHeight: 100, scrollWidth: 500, scrollHeight: 500 } },
  './repaint.js': { draw() {} },
  './edit.js': { columnOf: note => ({ lane, col: columns.find(col => col.notes.includes(note)) }) },
  './geometry.js': { xOf: t => t * 100, yOf: pitch => pitch },
  './lanes.js': { editLanes: () => [lane] }, './layer-role.js': { selectedTablatureLane: () => lane },
  './voicing-core.js': { chordColumns: () => columns },
  './column-navigation.js': { adjacentColumn },
  './util.js': { clamp: (v, min, max) => Math.min(max, Math.max(min, v)) },
  './tracing.js': { setPlaybackCursor: t => { time = t; } },
  './playback.js': { playbackTime: () => time,
    ensureTone: () => new Promise(resolve => unlocks.push(resolve)),
    previewNotes: (notes, voice) => heard.push({ notes, voice }) },
});
stepColumnFocus(1);
assert.deepEqual([...S.selection], [b, c]);
assert.equal(heard.length, 0, 'wait for audio initialization');
unlocks.shift()(); await Promise.resolve();
assert.deepEqual(heard.pop(), { notes: [b, c], voice: lane }, 'audition the entire chord with its lane voice');
stepColumnFocus(-1); unlocks.shift()(); await Promise.resolve();
assert.deepEqual(heard.pop().notes, [a], 'single-note columns are auditioned too');
stepColumnFocus(-1);
assert.equal(unlocks.length, 0, 'no sound when navigation has no destination');
stepColumnFocus(1); stepColumnFocus(-1);
unlocks.shift()(); unlocks.shift()(); await Promise.resolve();
assert.equal(heard.length, 1, 'rapid navigation skips stale pending auditions');
assert.deepEqual(heard.pop().notes, [a]);
time = 1.1; S.selection = new Set([a]);
stepVoiceFocus(1); unlocks.shift()(); await Promise.resolve();
assert.equal(time, 1.1, 'vertical voice navigation preserves the playhead');
assert.deepEqual(heard.pop().notes, [b, c], 'vertical navigation auditions the chosen voice');
console.log('Arrow navigation auditions notes and chords after audio initialization');
