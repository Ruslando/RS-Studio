import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EFFECT_FIELDS, copyEffects } from '../../web/note-effects.js';
import { effectSig, inRefBox, occurrenceBox, shiftOf } from '../../web/reference-core.js';

// Exercise the actual reference commit/preview functions without importing the
// editor's DOM/audio graph. Timing and geometry are fixed for these fixtures.
const source = readFileSync(new URL('../../web/references.js', import.meta.url), 'utf8');
const functions = ['relPattern', 'boxSig', 'mirrorBox', 'reconcileRefGroup', 'previewPositionReferences'].map(name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}).join('\n');
let uid = 0;
const clock = { beatAt: t => t, timeAt: t => t };
const api = new Function('deps', `const { EFFECT_FIELDS, copyEffects, effectSig, shiftOf,
  laneClock, boxRect, notesInBox, noteOrder, dropFingering, nid } = deps;
  ${functions}
  return { previewPositionReferences, reconcileRefGroup };`)({
  EFFECT_FIELDS, copyEffects, effectSig, shiftOf, laneClock: () => clock,
  boxRect: occurrenceBox, notesInBox: (box, notes) => notes.filter(n => inRefBox(n, box, .1)),
  noteOrder: (a, b) => a.start - b.start || a.pitch - b.pitch,
  dropFingering: n => { delete n.pos; delete n.arrangement; }, nid: () => `real-${++uid}`,
});

for (const shifted of [false, true]) {
  const lane = { notes: [{ id: 'first', start: 0, end: .8, pitch: 52 },
    { id: 'second', start: 4, end: 4.8, pitch: shifted ? 56 : 52 }],
  refBoxes: { a: { rt0: 0, rt1: 1, pLo: 52, pHi: 52, anchors: [0, 4],
    ...(shifted ? { shifts: [0, 4] } : {}) } } };
  const before = JSON.stringify(lane), preview = structuredClone(lane), actual = structuredClone(lane);
  // Editing a later reference must propagate backwards before fingering runs.
  const pos = shifted ? { string: 3, fret: 6 } : { string: 3, fret: 2 };
  preview.notes[1].pos = { ...pos };
  actual.notes[1].pos = { ...pos };
  api.previewPositionReferences(lane, preview);
  api.reconcileRefGroup(actual, 'a', actual.refBoxes.a, lane.notes, lane.refBoxes.a, null);
  assert.deepEqual(preview, actual, 'preview propagates exactly the reference edits commit will make');
  assert.equal(JSON.stringify(lane), before, 'reference preview leaves the live lane untouched');
  assert.equal(uid, 0, 'preview never advances the real note id counter');
  if (!shifted) assert.deepEqual(preview.notes[0].pos, pos);
  else assert.equal(preview.notes[0].pos, undefined, 'transposed copies do not inherit an invalid string/fret');
}

// Mirroring into a divergent short occurrence may create notes in a preview.
// They receive private ids, even though normal reference commit uses nid().
{
  const lane = { notes: [{ id: 'a', start: 0, end: .4, pitch: 52 },
    { id: 'b', start: .5, end: .9, pitch: 55 }, { id: 'c', start: 4, end: 4.4, pitch: 52 }],
  refBoxes: { a: { rt0: 0, rt1: 1, pLo: 52, pHi: 55, anchors: [0, 4] } } };
  const preview = structuredClone(lane);
  preview.notes[0].pos = { string: 3, fret: 2 };
  api.previewPositionReferences(lane, preview);
  assert.ok(preview.notes.some(n => n.id.startsWith('position-preview-')));
  assert.equal(uid, 0);
}

console.log('reference position preview: commit propagation, transposition and isolated ids passed');

{
  // Only a whole box counts as its reference: a part of it pastes as a copy.
  const start = source.indexOf('export function wholeBoxOf(');
  const body = source.slice(start + 7, source.indexOf('\n}', start) + 2);
  const lane = { notes: [{ start: 0, end: .8, pitch: 52 }, { start: .5, end: .9, pitch: 55 }, { start: 4, end: 4.8, pitch: 52 }] };
  const group = { rt0: 0, rt1: 1, pLo: 52, pHi: 55, anchors: [0, 4] };
  const boxOfNote = n => (n.start < 1 ? { lane, ref: 'a', group, i: 0 } : null);
  const wholeBoxOf = new Function('deps', `const { boxOfNote, notesInBox, boxRect, laneClock } = deps; ${body} return wholeBoxOf;`)({
    boxOfNote, laneClock: () => clock, boxRect: occurrenceBox, notesInBox: (box, notes) => notes.filter(n => inRefBox(n, box, .1)) });
  assert.equal(wholeBoxOf(lane.notes.slice(0, 2))?.ref, 'a', 'every note of the box is that box');
  assert.equal(wholeBoxOf(lane.notes.slice(0, 1)), null, 'part of a box is not');
  assert.equal(wholeBoxOf(lane.notes), null, 'notes beyond the box are not');
}
