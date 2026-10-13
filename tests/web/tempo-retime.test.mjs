// Run: node tests/web/tempo-retime.test.mjs
// Changing a tempo marker's BPM keeps everything under it on its bar and beat,
// up to the next tempo marker; nothing outside that stretch moves.
import assert from "node:assert/strict";
import { retimeSpan } from "../../web/bars.js";

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

// 120 BPM from 0 s, next tempo marker at 20 s. Bar 5 beat 1 = 8 s.
const fresh = () => ({
  lanes: [{
    notes: [{ start: 8, end: 8.25 }, { start: 19, end: 19.5 }, { start: 25, end: 25.5 }],
    handHolds: [{ t: 8, fret: 5 }],
    toneMarkers: [{ t: 0 }, { t: 8 }],
    phraseBoundaries: [{ t: 4 }],
    refBoxes: { 1: { anchors: [8, 24], rt0: 0, rt1: 2 } },
  }],
  sections: [{ t: 8 }, { t: 30 }],
});

{
  const { lanes: [l], sections } = fresh();
  const spilled = retimeSpan([l], sections, 60, 0.125, 0, 20, 120, 125);
  const k = 120 / 125;
  close(l.notes[0].start, 8 * k, "bar 5 beat 1 stays bar 5 beat 1");
  close(l.notes[0].end - l.notes[0].start, 0.25 * k, "an eighth stays an eighth");
  close(l.notes[2].start, 25, "past the next tempo marker nothing moves");
  close(l.handHolds[0].t, l.notes[0].start, "the hand hold stays on its note");
  assert.equal(l.handHolds[0].t, l.notes[0].start, "exactly, so the fretboard still finds it");
  close(l.toneMarkers[1].t, 8 * k, "tone marker");
  close(l.phraseBoundaries[0].t, 4 * k, "phrase marker");
  close(sections[0].t, 8 * k, "section marker");
  close(sections[1].t, 30, "section after the next tempo marker");
  close(l.refBoxes[1].anchors[0], 8 * k, "reference box in the stretch");
  close(l.refBoxes[1].anchors[1], 24, "reference box after it");
  close(l.refBoxes[1].rt1, 2 * k, "box length follows its first anchor");
  assert.equal(spilled, 0);
}

{
  // Slowing down pushes the note at 19 s past the marker at 20 s.
  const { lanes: [l], sections } = fresh();
  assert.equal(retimeSpan([l], sections, 60, 0.125, 0, 20, 120, 100), 1);
  close(l.notes[1].start, 19 * 1.2, "kept on the grid it lands on");
}

{
  // A later marker: only its own stretch moves, measured from the marker.
  const { lanes: [l], sections } = fresh();
  retimeSpan([l], sections, 60, 0.125, 20, Infinity, 120, 60);
  close(l.notes[0].start, 8, "before the marker nothing moves");
  close(l.notes[2].start, 20 + 5 * 2, "five seconds after the marker becomes ten");
}
console.log("tempo-retime: ok");
