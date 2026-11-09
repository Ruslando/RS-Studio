import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the board's actual keyboard handler without its canvas/audio setup.
const source = readFileSync(new URL('../../web/fretboard.js', import.meta.url), 'utf8');
const functions = ['typeFinger', 'resetGripFingers'].map(name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}).join('\n');
const create = new Function('deps', `const { visible, boardEditable, noteDrag, boardHover, board,
  draftNoteFinger, settleFingerDraft, gripsFor, currentLane, focusGrip, laneSpec } = deps;
  ${functions}
  return { typeFinger, resetGripFingers };`);

function fixture(overrides = {}) {
  const note = {}, other = { finger: 4 }, mark = { note, fret: 5, string: 2 };
  const board = { marks: [mark, { note: other, fret: 7, string: 1 }] };
  const writes = [], commits = [], positions = new Map();
  const deps = { visible: true, boardEditable: () => true, noteDrag: null,
    boardHover: { mark }, board, currentLane: () => ({}), laneSpec: () => ({}),
    gripsFor: () => ({ voiced: positions }), focusGrip: () => board,
    draftNoteFinger(original, note, finger, voiced) {
      assert.equal(voiced, positions, 'use current positions for slide finger propagation');
      if (!original.has(note)) original.set(note, note.finger ?? null);
      writes.push({ note, finger });
      if (finger == null) delete note.finger; else note.finger = finger;
    },
    settleFingerDraft(original, keep) { commits.push({ original: new Map(original), keep }); },
    ...overrides,
  };
  return { ...create(deps), note, other, mark, board, writes, commits };
}
const event = (key, extras = {}) => ({ key, target: {}, prevented: false, stopped: false,
  preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extras });

for (const key of ['0', '1', '2', '3', '4', 'Delete', 'Backspace']) {
  const f = fixture(), e = event(key);
  f.note.finger = 3;
  assert.equal(f.typeFinger(e), true, 'hover and type works without entering a mode');
  assert.deepEqual(f.writes, [{ note: f.note, finger: /^\d$/.test(key) ? Number(key) : null }]);
  assert.equal(f.other.finger, 4, 'other chord notes keep their fingering');
  assert.equal(f.commits.length, 1, 'the key settles immediately into one undo step');
  assert.equal(f.commits[0].keep, true);
  assert.equal(f.commits[0].original.get(f.note), 3);
  assert.ok(e.prevented && e.stopped, 'handled keys do not reach editor shortcuts');
}
for (const overrides of [{ visible: false }, { boardEditable: () => false }, { noteDrag: {} },
  { boardHover: null }, { boardHover: { mark: { note: {}, fret: 5, string: 2 } } }]) {
  const f = fixture(overrides), e = event('1');
  assert.equal(f.typeFinger(e), false);
  assert.equal(f.writes.length, 0);
  assert.equal(e.prevented, false);
}
for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true },
  { target: { closest: () => ({}) } }]) {
  const f = fixture();
  assert.equal(f.typeFinger(event('1', extra)), false, 'typing fields and modified shortcuts retain their keys');
  assert.equal(f.writes.length, 0);
}
for (const key of ['5', 'ArrowLeft', 'Escape', 'Enter']) {
  const f = fixture();
  assert.equal(f.typeFinger(event(key)), false);
}
for (const property of [{ fret: 0 }, { dead: true }]) {
  const f = fixture();
  Object.assign(f.mark, property);
  assert.equal(f.typeFinger(event('1')), false, 'open and dead notes have no finger target');
}
{
  const f = fixture();
  f.typeFinger(event('1'));
  f.typeFinger(event('2'));
  assert.equal(f.commits.length, 2, 'successive assignments are independently undoable');
  assert.equal(f.commits[1].original.get(f.note), 1);
  f.resetGripFingers();
  assert.equal(f.note.finger, undefined);
  assert.equal(f.other.finger, undefined);
  assert.equal(f.commits.length, 3, 'resetting the whole chord is one edit');
}
console.log('Hovered fretboard notes accept direct finger keys and reset in one edit');
