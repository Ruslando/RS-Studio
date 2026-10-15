// Run: node tests/web/fretboard-bend.test.mjs
// A bent note's finger moves along the fret with the curve: treble strings toward
// the bass side, bass strings toward the treble, open strings not at all.
import assert from "node:assert/strict";
import { BEND_SPACING_PER_SEMI as K, bendLift, fretCentre, handAt } from "../../web/fretboard-core.js";
import { VIBRATO, slideTargets } from "../../web/bend.js";

const note = { start: 0, end: 1, bend: "release" };            // 0 → 2 → 0 semitones
const column = (string, fret, n = note) => [{ start: n.start, end: n.end, shape: "a",
  fingers: [{ note: n, string, fret, start: n.start, finger: 1 }] }];
const lift = (string, fret, t, n) => handAt(column(string, fret, n), t, 0).marks[0].lift;

assert.equal(lift(2, 7, 0), 0, "a bend starts on the fret");
assert.equal(lift(2, 7, 0.5), 2 * K, "the G string goes up toward the bass side");
assert.equal(lift(4, 7, 0.5), -2 * K, "the A string goes down toward the treble");
assert.equal(lift(2, 7, 0.75), 1 * K, "half way back on the release");
assert.equal(lift(2, 0, 0.5), 0, "an open string has no finger to bend it");
assert.equal(lift(2, 7, 0, { start: 0, end: 1, bend: "prebend" }), 2 * K, "a prebend is bent before it sounds");
// A prebend after a rest is pushed up in the second half of the free time before it.
const pre = { start: 2, end: 3, bend: "prebend" };
const before = { start: 0, end: 1, bend: undefined };
const song = [{ ...column(2, 5, before)[0], shape: "x" }, { ...column(2, 7, pre)[0], shape: "y" }];
const at = (t) => handAt(song, t, 1).marks[0];
assert.equal(at(1.25).lift, 0, "first the hand shifts to the fret");
assert.equal(at(1.25).pressed, undefined);
assert.equal(at(1.75).lift, K, "half way up the push");
assert.equal(at(1.75).string, 2, "on its string by then");
assert.ok(at(1.99).lift > 1.9 * K && at(1.99).lift < 2 * K, "nearly there just before the pick");
assert.equal(at(2).lift, 2 * K, "bent when it sounds");
// Back to back there is no free time: the bend lands at the onset.
const tight = [{ ...column(2, 5, { start: 0, end: 2 })[0], shape: "x" }, song[1]];
assert.equal(handAt(tight, 1.9, 1).marks[0].lift, 0);
// A vibrato wobbles the finger the same way: up from the fret and back, never below.
const vib = { start: 0, end: 2, fx: { vibrato: true } };
const wobble = Array.from({ length: 200 }, (_, k) => lift(2, 7, k / 100, vib));
assert.ok(Math.min(...wobble) >= 0 && Math.max(...wobble) > 0.35 * K, "pushes up, comes back");
assert.ok(Math.abs(lift(2, 7, 5 / VIBRATO.hz, vib)) < 1e-9, "back on the fret once a cycle");
assert.equal(lift(2, 0, 0.5, vib), 0, "an open string has no finger to wobble");
// A slide carries the finger along the string, a fret at a time.
const into = { start: 0, end: 1, slide: "inBelow" };
const x = (t, cols) => handAt(cols, t, 0).marks[0].x;
assert.equal(x(0, column(2, 7, into)), fretCentre(3), "starts four frets below");
assert.equal(x(0.5, column(2, 7, into)), fretCentre(7), "and has arrived");
const from = { start: 0, end: 1, slide: "shift", pos: { string: 2 } }, onto = { start: 1, end: 2, pos: { string: 2 } };
const pair = [{ ...column(2, 7, from)[0], shape: "x" }, { ...column(2, 9, onto)[0], shape: "y" }];
assert.equal(x(0, pair), fretCentre(7), "starts on its own fret");
assert.equal(x(0.5, pair), fretCentre(8), "slides over the whole note, as Rocksmith plays it");
assert.equal(x(1, pair), fretCentre(9), "on the next fret by its end");
assert.ok(x(0.875, pair) > fretCentre(7) && x(0.875, pair) < fretCentre(9), "gliding between, not stepping");
// A chord's slide lands each voice on its own string.
const a = [45, 52, 57].map((p, i) => ({ start: 0, end: 1, pitch: p, slide: "shift", pos: { string: 5 - i } }));
const b = [47, 54, 59].map((p, i) => ({ start: 1, end: 2, pitch: p, pos: { string: 5 - i } }));
const targets = slideTargets([...b, ...a]);
assert.deepEqual(a.map((n) => targets.get(n).pitch), [47, 54, 59]);
assert.equal(bendLift({ note: { start: 0, end: 1 }, string: 2, fret: 7 }, 0.5, 6), 0, "no bend, no lift");
console.log("fretboard-bend ok");
// The slide onto the next note keeps the finger down the whole way: no travel
// window (pressed: false) opens before the target, and a legato target is not struck.
const leg = { ...from, slide: "legato" };
const slid = [{ ...column(2, 7, leg)[0], shape: "x" }, { ...column(2, 9, onto)[0], shape: "y" }];
for (const t of [0.6, 0.8, 0.95, 1]) assert.equal(handAt(slid, t, 1).pressed, true, `held at ${t}`);
assert.equal(handAt(slid, 1, 1).marks[0].x, fretCentre(9));
assert.equal(handAt(slid, 1.2, 1).marks[0].slurred, true, "a legato target is not picked");
assert.equal(handAt(pair, 1.2, 1).marks[0].slurred, false, "a shift target is");
console.log("fretboard-bend slides ok");

// The voicer keeps the sliding finger on the note it lands on, and moves the seat.
import { voiceNotesFingered } from "../../web/voicing-core.js";
{
  const src = { start: 0, end: 0.5, pitch: 62, slide: "legato", pos: { string: 2, fret: 7, scope: "local" } };
  const dst = { start: 0.5, end: 1, pitch: 64, pos: { string: 2, fret: 9, scope: "local" } };
  const lead = { start: -1, end: -0.5, pitch: 60, pos: { string: 2, fret: 5, scope: "local" } };
  const { fingers, seats } = voiceNotesFingered([lead, src, dst], [64, 59, 55, 50, 45, 40]);
  assert.equal(fingers.get(dst), fingers.get(src), "same finger before and after the slide");
  assert.equal(seats.get(dst) - seats.get(src), 2, "the hand slid two frets with it");
  console.log("voicer slide fingers ok");
}

// A slide-out goes five frets in the note's last eighth, and not below fret 1; a
// slide-in takes the first eighth. Never more than half the note.
import { slideAt } from "../../web/bend.js";
assert.equal(slideAt({ slide: "outDown", pos: { fret: 9 } }, 1, 1), -5);
assert.equal(slideAt({ slide: "outDown", pos: { fret: 9 } }, 0.7, 1), 0, "held until the last eighth");
assert.equal(slideAt({ slide: "outDown", pos: { fret: 9 } }, 0.9, 1), -3, "on the way, a whole fret at a time");
assert.equal(slideAt({ slide: "outDown", pos: { fret: 9 } }, 0.6, 1, { eighth: 0.5 }), -1, "a slower tempo starts sliding earlier");
assert.equal(slideAt({ slide: "inBelow" }, 0.1, 0.2, { eighth: 0.5 }), 0, "at most half the note");
assert.equal(slideAt({ slide: "outDown", pos: { fret: 3 } }, 1, 1), -2, "lands on fret 1");
assert.equal(slideAt({ slide: "outUp" }, 1, 1), 5);
console.log("slide-outs ok");


// The lower finger remains planted while the upper finger taps in sync with audio.
import { eventOffsetAt, playbackEvents } from "../../web/playback-effects.js";
for (const [kind, interval] of [["half", 1], ["whole", 2]]) {
  const n = { start: 2, end: 3, pitch: 62, trill: kind };
  const cols = column(2, 7, n);
  const event = playbackEvents([n])[0];
  for (const sec of [0, 0.13, 0.26, 0.39]) {
    const mark = handAt(cols, n.start + sec, 0).marks[0];
    assert.equal(mark.fret, 7, "lower finger stays at its fret");
    assert.equal(mark.trill.fret, 7 + interval);
    assert.equal(mark.trill.x, fretCentre(7 + interval));
    assert.equal(mark.trill.down ? interval : 0, eventOffsetAt(event, sec), "fret and audio use the same phase");
    assert.equal(mark.trill.finger, 2, "a second finger taps above the held index");
  }
  cols[0].eighth = 0.5;
  assert.equal(handAt(cols, 2.13, 0).marks[0].trill.down, false, "slower tempo slows the finger");
  assert.equal(handAt(cols, 2.26, 0).marks[0].trill.down, true);
}
assert.equal(handAt(column(2, 22, { start: 0, end: 1, trill: "whole" }), 0.13, 0).marks[0].trill,
  undefined, "never draw a finger beyond the neck");
console.log("fretboard trill ok");
