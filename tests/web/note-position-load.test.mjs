import assert from 'node:assert/strict';
import { arrangedNotes, keepVoicing, loadNotePositions, voiceNotesFingered } from '../../web/voicing-core.js';
import { resetSharedPositions } from '../../web/position-selection.js';

const tuning = [64, 59, 55, 50, 45, 40];
const played = notes => arrangedNotes(notes).map(n => [n.pitch, n.start, n.end, n.pos.string, n.pos.fret]);

// A legacy overlay's voices used the entire column's extent, including voices
// that already existed as shorter or slightly later source notes.
for (const start of [0, .01]) {
  const saved = [
    { id: 'short', start, end: .5, pitch: 52, pos: { string: 3, fret: 2 },
      motifId: 'motif_v2_1', shapeId: 'shape_1', shapeKind: 'handshape' },
    { id: 'long', start: 0, end: 1, pitch: 55, pos: { string: 2, fret: 0 },
      shapeId: 'shape_1', shapeKind: 'handshape',
      arrangement: { notes: [{ pitch: 52, string: 4, fret: 7 }, { pitch: 60, string: 2, fret: 5 }] } },
    { id: 'loaded_note_1', start: 2, end: 3, pitch: 45, pos: { string: 4, fret: 0 } },
  ];
  const original = structuredClone(saved), expected = played(saved);
  const loaded = loadNotePositions(saved);
  assert.deepEqual(played(loaded), expected, 'migration retains currently played tones, times, lengths and positions');
  assert.deepEqual(saved, original, 'migration does not change its source payload');
  assert.equal(loaded.find(n => n.pitch === 52).id, 'short', 'matching notes retain their ids');
  assert.equal(loaded.find(n => n.pitch === 52).motifId, 'motif_v2_1');
  assert.ok(loaded.filter(n => n.start === 0).every(n => n.shapeId === 'shape_1'));
  assert.equal(new Set(loaded.map(n => n.id)).size, loaded.length, 'added notes have distinct ids');
  assert.ok(loaded.every(n => !n.arrangement && !n.written));
  const reopened = loadNotePositions(JSON.parse(JSON.stringify(loaded)));
  assert.deepEqual(reopened, loaded, 'save and reload do not repeat the migration');
  assert.deepEqual(played(reopened), expected);
}

// An older project's override that no longer sounds the note's pitch had lapsed: the
// note was played at its kept answer (auto), and it still is.
{
  const stale = { id: 'stale', start: 0, end: 1, pitch: 52, pos: { string: 2, fret: 0, scope: 'local' }, auto: { string: 3, fret: 2, n: 1 } };
  assert.deepEqual(loadNotePositions([stale], tuning)[0].pos, { string: 3, fret: 2, follow: 'guided' }, 'the kept answer takes over');
  const good = { ...stale, pos: { string: 4, fret: 7 } };
  assert.deepEqual(loadNotePositions([good], tuning)[0].pos, { string: 4, fret: 7, follow: 'guided' }, 'a valid override stays');
}

// A new unplaced note is calculated once, saved, and retains that position on open.
const fresh = loadNotePositions([{ id: 'new', start: 0, end: 1, pitch: 52 }]);
keepVoicing(fresh, voiceNotesFingered(fresh, tuning), tuning);
assert.ok(fresh[0].pos);
const reopened = loadNotePositions(JSON.parse(JSON.stringify(fresh)));
assert.deepEqual(reopened[0].pos, { ...fresh[0].pos, follow: 'guided' });
assert.deepEqual(voiceNotesFingered(reopened, tuning).voiced.get(reopened[0]), fresh[0].pos);
assert.deepEqual(loadNotePositions(null), []);

// Recalculate on several columns clears only their positions. An obsolete
// snapshot cannot change the selected pitches, ids, note count or other columns.
const notes = [0, 2].map((start, i) => ({ id: `selected_${i}`, start, end: start + 1, pitch: 52,
  pos: { string: 4, fret: 7 }, written: [{ id: 'old', start, end: start + 1, pitch: 60 }] }));
const other = { id: 'other', start: 4, end: 5, pitch: 57, pos: { string: 2, fret: 2 } };
const lane = { notes: [...notes, other], handHolds: [{ t: 4, fret: 2 }] };
const before = structuredClone(lane);
const reset = resetSharedPositions(lane, new Set(notes));
assert.equal(reset.changed, true);
assert.deepEqual(lane, before, 'reset preparation leaves live state untouched');
assert.deepEqual(reset.notes.map(n => [n.id, n.pitch]), lane.notes.map(n => [n.id, n.pitch]));
assert.ok([...reset.selection].every(n => n.pitch === 52 && !n.pos && !n.written));
assert.strictEqual(reset.notes[2], other, 'unselected notes retain their positions and identities');
keepVoicing(reset.notes, voiceNotesFingered(reset.notes, tuning), tuning);
assert.ok(reset.notes.every(n => n.pos));
assert.deepEqual(loadNotePositions(JSON.parse(JSON.stringify(reset.notes))).map(n => [n.id, n.pitch, n.pos.string, n.pos.fret]),
  reset.notes.map(n => [n.id, n.pitch, n.pos.string, n.pos.fret]));
console.log('note positions: legacy timing, current positions, first solve, reload and batch recalculate passed');
