import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

const painted = [], noop = () => {};
const ctx = new Proxy({ measureText(text) { return { width: text.length * parseFloat(this.font.match(/[\d.]+(?=px)/)[0]) * 0.5 }; }, fillText(text, x, y) { painted.push({ text, x, y, font: this.font }); } }, {
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
    './bend.js': { slideTargets: () => new Map(), slideRibbon: () => null, bendCurve: () => null, SLIDES_TO_NEXT: new Set(), SLIDE_IN: new Set(), SLIDE_OUT: new Set() },
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
  S.hoverNote = null;
  S.state.rowH = 10; painted.length = 0; drawNoteFx();
  assert.equal(parseFloat(painted[0].font.match(/[\d.]+(?=px)/)[0]), 7.5,
    'vertical zoom reduces label size with note height');
  S.state.rowH = 20; note.end = 1.12; painted.length = 0; drawNoteFx();
  assert.ok(parseFloat(painted[0].font.match(/[\d.]+(?=px)/)[0]) < 12,
    'short notes shrink labels to fit their width');
  note.end = 1.03; painted.length = 0; drawNoteFx();
  assert.equal(painted.length, 0, 'tiny note bodies remain visible without oversized labels');
  note.end = 2; S.state.rowH = 5; painted.length = 0; drawNoteFx();
  assert.equal(painted.length, 0, 'tiny rows hide unreadable text');
  S.state.rowH = 20;
  for (const id of ['spectrogramNoteNames', 'spectrogramPositions', 'spectrogramEffects']) controls[id].value = 'off';
  painted.length = 0; drawNoteFx();
  assert.equal(painted.length, 0, 'Off hides every label including slide glyphs');
} finally { globalThis.document = oldDocument; }
console.log('Note appearance visibility, font and slide placement passed');
