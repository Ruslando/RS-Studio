import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

const painted = [], noop = () => {};
const ctx = new Proxy({ fillText(text, x, y) { painted.push({ text, x, y, font: this.font }); } }, {
  get: (target, name) => name in target ? target[name] : noop,
});
const controls = { spectrogramNoteNames: { value: 'always' }, spectrogramPositions: { value: 'hover' },
  spectrogramEffects: { value: 'hover' }, fretNumbering: { value: 'capo' } };
const note = { start: 1, end: 2, pitch: 64, slide: 'inBelow' };
const lane = { visible: true, notes: [note] };
const S = { state: { lanes: [lane], rowH: 20 }, voicingRevision: 0, selection: new Set() };
const oldDocument = globalThis.document;
try {
  globalThis.document = { getElementById: id => controls[id] };
  const painter = await mockImport(new URL('../../web/note-label-paint.js', import.meta.url), {
    './stage-paint.js': { PAINT: { text: '#fff' }, halo: () => '#000' },
  }, { './constants.js': true, './spectrogram-labels.js': true });
  const { drawNoteFx } = await mockImport(new URL('../../web/note-render.js', import.meta.url), {
    './store.js': { S }, './dom.js': { scroll: { scrollLeft: 0, clientWidth: 500 }, sctx: ctx },
    './tablature.js': { laneFingeringKey: () => 'one', laneFingering: async () => ({ notes: [note], voiced: new Map([[note, { string: 1, fret: 5 }]]) }) },
    './repaint.js': { draw: noop }, './articulations.js': { hammerDirections: () => new Map() },
    './bend.js': { slideTargets: () => new Map(), slideRibbon: () => null, bendCurve: () => null },
    './geometry.js': { xOf: time => time * 100, yOf: () => 0 }, './grid.js': { gridAt: () => ({ bpm: 120 }) },
    './grace.js': { graceBefore: () => null }, './note-effects.js': { noteMarks: () => ['PM'], FX_GLYPHS: {}, HARMONIC_TAG: {} },
    './note-label-paint.js': painter,
  }, { './spectrogram-labels.js': true });
  drawNoteFx(); await Promise.resolve(); painted.length = 0;
  drawNoteFx();
  assert.deepEqual(painted.map(item => item.text), ['E4'], 'hover-only components stay hidden until hovered');
  assert.match(painted[0].font, /12px/);
  S.hoverNote = note; painted.length = 0; drawNoteFx();
  assert.deepEqual(painted.map(item => item.text), ['E4 S2:F5 PM', '↗']);
  assert.ok(painted[1].x < 100, 'slide-in sits left of the note');
  note.slide = 'outUp'; painted.length = 0; drawNoteFx();
  assert.ok(painted.at(-1).x > 200, 'slide-out sits right of the note');
  controls.fretNumbering.value = 'nut'; lane.capo = 2; painted.length = 0; drawNoteFx();
  assert.equal(painted[0].text, 'E4 S2:F7 PM', 'one shared capo preference changes spectrogram fret labels');
  for (const id of ['spectrogramNoteNames', 'spectrogramPositions', 'spectrogramEffects']) controls[id].value = 'off';
  painted.length = 0; drawNoteFx();
  assert.equal(painted.length, 0, 'Off hides every label including slide glyphs');
} finally { globalThis.document = oldDocument; }
console.log('Note appearance visibility, font and slide placement passed');
