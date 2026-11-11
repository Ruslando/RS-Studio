import assert from 'node:assert/strict';
import { applyNoteCounterpart, applyPresenceCounterpart, noteChangeRows } from '../../web/repeat-change-details.js';
const note = (id, start, extra = {}) => ({ id, start, end: start + 1, pitch: 45, pos: { string: 4, fret: 5 }, finger: 1, ...extra });
const first = note('first', 2, { pitch: 40, pos: { string: 5, fret: 0 }, finger: 0, fx: { palmMute: true, vibrato: true },
  whammy: 'dip', whammyPoints: [[0, 0], [.5, -1], [1, 0]], bend: 'half', bendPoints: [[0, 0], [1, 1]] });
const original = structuredClone(first);
{
  const target = note('here', 10, { soundingPitch: 57 });
  const before = structuredClone(target);
  assert.equal(applyNoteCounterpart('pitch', first, target), true);
  assert.deepEqual(target, { ...before, pitch: 40, soundingPitch: 52 }, 'copying pitch preserves other rows and updates sounding-pitch metadata');
  assert.equal(applyNoteCounterpart('pitch', first, target), false, 'matching values are a no-op');
}
{
  const target = note('here', 10, { pos: { string: 4, fret: 5, steer: true }, fx: { ghost: true } });
  applyNoteCounterpart('position', first, target);
  assert.deepEqual(target.pos, { string: 5, fret: 0, steer: true });
  assert.equal(target.pitch, 45, 'copying placement does not also copy pitch');
  assert.equal(target.finger, 1, 'copying placement does not also copy the finger');
  applyNoteCounterpart('finger', first, target);
  assert.equal(target.finger, 0, 'thumb survives');
  applyNoteCounterpart('finger', target, first);
  assert.equal(first.finger, 0, 'the same operation accepts either direction');
  applyNoteCounterpart('finger', first, target, { fingers: new Map([[first.id, 3]]) });
  assert.equal(target.finger, 3, 'generated fingering can be applied');
  applyNoteCounterpart('fx.palmMute', first, target);
  assert.deepEqual(target.fx, { ghost: true, palmMute: true });
  applyNoteCounterpart('fx.palmMute', { fx: {} }, target);
  assert.deepEqual(target.fx, { ghost: true }, 'copying an off flag removes only that flag');
}
{
  const target = note('here', 20, { end: 20.25 });
  const beatAt = t => t < 10 ? t : 10 + (t - 10) * 2;
  const timeAt = b => b < 10 ? b : 10 + (b - 10) / 2;
  applyNoteCounterpart('length', first, target, { beatAt, timeAt });
  assert.equal(target.start, 20); assert.equal(target.end, 20.5, 'duration is copied in beats across tempos');
  applyNoteCounterpart('onset', first, target, { beatAt, timeAt, sourceOrigin: 0, targetOrigin: 10 });
  assert.equal(target.start, 11); assert.equal(target.end, 11.5, 'onset is copied within the destination passage while keeping duration');
}
{
  const target = note('here', 10, { whammy: 'dive', whammyPoints: [[0, 0], [1, -2]], fx: { ghost: true } });
  const before = structuredClone(target);
  applyNoteCounterpart('whammyPoints', first, target);
  assert.deepEqual(target, { ...before, whammy: 'dip', whammyPoints: first.whammyPoints });
  assert.notEqual(target.whammyPoints, first.whammyPoints);
  target.whammyPoints[1][1] = -3;
  assert.equal(first.whammyPoints[1][1], -1, 'curve points do not alias their counterpart');
  const earlier = structuredClone(first);
  applyNoteCounterpart('whammyPoints', target, earlier);
  assert.equal(earlier.whammyPoints[1][1], -3, 'curves copy back to the first occurrence as well');
  applyNoteCounterpart('bendPoints', first, target);
  assert.deepEqual(target.bendPoints, first.bendPoints); assert.equal(target.bend, 'half');
  applyNoteCounterpart('whammyPoints', {}, target);
  assert.equal(target.whammy, undefined); assert.equal(target.whammyPoints, undefined, 'a disabled curve clears its enabling effect');
}
{
  for (const [key, value] of Object.entries({ slide: 'legato', slideIn: 'inBelow', slideStart: .3, slideEnd: .2, slideFrets: 3,
    harmonic: 'pinch', grace: 'half', trill: 'whole', tremPick: 'sixteenth', slap: 'tap', stroke: { direction: 'up' }, ornament: 'turn' })) {
    const source = note('a', 0, { [key]: value });
    if (key === 'slideStart') source.slide = 'legato';
    if (key === 'slideEnd') source.slideIn = 'inBelow';
    const target = note('b', 10);
    applyNoteCounterpart(key, source, target);
    assert.deepEqual(target[key], value, `${key} is individually applicable`);
    assert.equal(target.pitch, 45); assert.equal(target.start, 10);
  }
  const target = note('b', 10);
  applyNoteCounterpart('vibratoStart', { fx: { vibrato: true }, vibratoStart: .4 }, target);
  assert.equal(target.fx.vibrato, true); assert.equal(target.vibratoStart, .4);
  const unchanged = structuredClone(target);
  assert.equal(applyNoteCounterpart('unsupported', first, target), false);
  assert.deepEqual(target, unchanged);
}
{
  const lane = { notes: [first] }, ids = [];
  const { changed, note: added } = applyPresenceCounterpart(lane, { ...first, motifId: 'motif_v2_1', shapeId: 'shape_1' }, null,
    { sourceOrigin: 0, targetOrigin: 10, mintId: () => 'fresh', targetIds: ids });
  assert.equal(changed, true); assert.equal(added.id, 'fresh'); assert.equal(added.start, 12); assert.equal(added.end, 13);
  assert.equal(added.pitch, first.pitch); assert.equal(added.motifId, undefined); assert.equal(added.shapeId, undefined);
  assert.deepEqual(ids, ['fresh'], 'the added note joins the destination occurrence');
  assert.notEqual(added.whammyPoints, first.whammyPoints);
  assert.deepEqual(noteChangeRows(first, added), [], 'recreated note matches its counterpart');
  const result = applyPresenceCounterpart(lane, null, added);
  assert.equal(result.note, null); assert.deepEqual(lane.notes, [first], 'copying absence deletes only its counterpart');
}
assert.deepEqual(first, original, 'the source note stays intact');
console.log('Individual counterpart edits: timing, pitch, position, fingers, effects, curves and presence passed');

{
  const source = note('slide-source', 0, { slide: 'inBelow', slideEnd: .3, slideFrets: 3 });
  const target = note('slide-target', 10, { slide: 'outUp', slideStart: .7, slideIn: 'inAbove' });
  const before = structuredClone(target);
  assert.equal(applyNoteCounterpart('slideCurve', source, target), true);
  assert.equal(target.slide, 'inBelow'); assert.equal(target.slideEnd, .3);
  assert.equal(target.slideStart, undefined); assert.equal(target.slideIn, undefined);
  assert.equal(target.start, before.start); assert.equal(target.end, before.end); assert.equal(target.pitch, before.pitch);
}
