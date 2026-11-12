import assert from 'node:assert/strict';
import { alphaTab, asFile, roundTrip } from '../../tools/gp-audit/harness.mjs';
import { convertGpScore } from '../../web/guitar-pro-core.js';

// Mixed source spelling exercises beat reuse, tuplets, grace timing and effects
// on later tied parts together, rather than as isolated feature-matrix probes.
const tex = `:4 5.3{sib sl} 7.3 r.2 | :2 5.2{v} :4 5.2{t sod} r |
  :8 3.1{tu 3} 5.1{tu 3} 3.1{tu 3} :4 2.2{gr} 5.2{h} 7.2 r |
  :4 5.4{tb (0 -4 0)} 5.4 5.4{t tb (0 -2 0)} (5.4 7.3){bu}`;
const importer = new alphaTab.importer.AlphaTexImporter();
importer.initFromString(tex, new alphaTab.Settings());
const source = importer.readScore();
// Equivalent ratios may have different authored spelling. Reused beats must
// retain 6:4 instead of replacing it with the simpler 3:2 representation.
for (const beat of source.tracks[0].staves[0].bars[2].voices[0].beats) {
  if (beat.tupletNumerator === 3 && beat.tupletDenominator === 2) {
    beat.tupletNumerator = 6; beat.tupletDenominator = 4;
  }
}
const file = asFile(source);
assert.ok(file.tracks[0].staves[0].bars[2].voices[0].beats.some(beat =>
  beat.tupletNumerator === 6 && beat.tupletDenominator === 4));
const rhythm = score => score.tracks[0].staves[0].bars.map(bar => bar.voices.map(voice =>
  voice.beats.map(beat => ({
    start: beat.absolutePlaybackStart, ticks: beat.playbackDuration,
    duration: beat.duration, dots: beat.dots,
    tuplet: [beat.tupletNumerator, beat.tupletDenominator], grace: beat.graceType,
    brush: beat.brushType, whammy: (beat.whammyBarPoints || []).map(point => [point.offset, point.value]),
    notes: beat.notes.map(note => ({
      string: note.string, fret: note.fret, tied: note.isTieDestination,
      hammer: note.isHammerPullOrigin, slideIn: note.slideInType,
      slideOut: note.slideOutType, vibrato: note.vibrato,
    })),
  }))));
const expected = rhythm(file);
for (const mode of ['source', 'rebuilt', 'seen']) {
  const { score } = await roundTrip(file, 0, mode);
  assert.deepEqual(rhythm(score), expected, `${mode} retains authored rhythm, grace notes and tied-part effects`);
}

// Filling part of a rest rebuilds its voice without rewriting the other bars.
const original = convertGpScore(file, [0]).editLanes[0].notes;
const added = { id: 'inserted', start: 1.25, end: 1.5, pitch: 64,
  pos: { string: 0, fret: 0, scope: 'local' } };
const noteKey = note => [note.start, note.end, note.pitch, note.pos.string, note.pos.fret]
  .map(value => Math.round(value * 1e6) / 1e6).join(':');
for (const mode of ['source', 'rebuilt']) {
  const { score } = await roundTrip(file, 0, mode, lane => lane.notes.push(structuredClone(added)));
  assert.deepEqual(rhythm(score).slice(1), expected.slice(1), `${mode} preserves unaffected bars while inserting a note`);
  const imported = convertGpScore(score, [0]).editLanes[0].notes;
  assert.deepEqual(imported.map(noteKey).sort(), [...original, added].map(noteKey).sort(),
    `${mode} retains every original note and the inserted note at their sounding times`);
}
console.log('Guitar Pro voice rebuilding preserves mixed rhythm, source effects and insertion timing');
