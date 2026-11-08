import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { adjacentColumn, legatoColumns } from '../../web/column-navigation.js';

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
  './column-navigation.js': { adjacentColumn, legatoColumns },
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

const source = { start: 3, end: 4, pitch: 65, slide: 'legato' };
const landing = { start: 4, end: 5, pitch: 67 };
const after = { start: 5, end: 6, pitch: 69 };
lane.notes.push(source, landing, after);
columns.push(...[source, landing, after].map(note => ({ t0: note.start, notes: [note] })));
stepColumnFocus(1); unlocks.shift()(); await Promise.resolve();
assert.equal(time, 3, 'enter the slide at its source');
assert.deepEqual([...S.selection], [source, landing], 'select the whole legato gesture');
assert.deepEqual(heard.pop().notes, [source, landing], 'audition the slide with its landing');
stepColumnFocus(1); unlocks.shift()(); await Promise.resolve();
assert.equal(time, 5, 'the next press leaves the entire slide');
assert.deepEqual([...S.selection], [after]);
heard.pop();
stepColumnFocus(-1); unlocks.shift()(); await Promise.resolve();
assert.equal(time, 3, 'backwards enters at the slide source too');
assert.deepEqual([...S.selection], [source, landing]);
heard.pop();
time = 4.5;
stepColumnFocus(-1); unlocks.shift()(); await Promise.resolve();
assert.equal(time, 1, 'backwards from a sounding landing leaves the whole gesture');
console.log('Arrow navigation auditions notes and chords after audio initialization');
