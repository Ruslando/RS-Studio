// Run: node tests/web/voicing-override.test.mjs
// What an override reaches, and what a technique forbids an override to offer.
import assert from "node:assert/strict";
import { BASS_HAND_PROFILE, chordColumns, handChoices, overrideFlow, overrideInfluence, placementFault, placementLimits, scoreShapesAsDecided, shapeFault, voiceNotes, voiceNotesFingered } from "../../web/voicing-core.js";

const tuning = [64, 59, 55, 50, 45, 40];              // app order: string 0 = high E
const note = (start, pitch, extra = {}) => ({ start, end: start + 0.4, pitch, ...extra });
const pin = (string, fret, reach = {}) => ({ string, fret, scope: "local", ...reach });
const at = (voiced, n) => `${voiced.get(n).string}:${voiced.get(n).fret}`;

// ---- reach -------------------------------------------------------------
// A4 five times. The third is pinned to the A string, fret 12. `adapt: false`
// throughout, so this block measures the reach alone.
{
  const lane = [0, 1, 2, 3, 4].map((t) => note(t, 57));
  assert.deepEqual(overrideInfluence([lane[2]]), { previous: false, next: false, adaptPrevious: false, adaptNext: false },
    "new overrides leave both propagation and adaptation off");
  // Imported pins without switches use the same disabled defaults.
  assert.equal(overrideFlow([{ pitch: 57, pos: pin(4, 12) }]).next, false);
  assert.equal(overrideInfluence([{ pitch: 57, pos: pin(4, 12) }]).next, false);
  const auto = at(voiceNotes(lane, tuning), lane[0]);
  assert.notEqual(auto, "4:12", "the test needs a pin that differs from the automatic answer");
  const set = (influencePrevious, influenceNext) => pin(4, 12, { influencePrevious, influenceNext, adapt: false });
  const played = () => { const voiced = voiceNotes(lane, tuning); return lane.map((n) => at(voiced, n)); };

  lane[2].pos = set(false, true);
  assert.deepEqual(played(), [auto, auto, "4:12", "4:12", "4:12"], "after follows, before stays");
  lane[2].pos = set(true, false);
  assert.deepEqual(played(), ["4:12", "4:12", "4:12", auto, auto], "before only");
  lane[2].pos = set(false, false);
  assert.deepEqual(played(), [auto, auto, "4:12", auto, auto], "neither: one column");

  // A later pin takes over from where it stands.
  lane[2].pos = set(false, true);
  lane[3].pos = pin(2, 2, { influencePrevious: false, influenceNext: true, adapt: false });
  assert.deepEqual(played(), [auto, auto, "4:12", "2:2", "2:2"]);

  // A pin written before the flags existed reaches nothing before it. (After it the
  // old continuity pull still applies, as it did when the project was saved.)
  delete lane[3].pos; lane[2].pos = pin(4, 12);
  assert.deepEqual(played().slice(0, 3), [auto, auto, "4:12"]);
}

// ---- adapt ---------------------------------------------------------------
// A line played around the 5th fret; its A3 is put on the low E string at the 17th.
{
  const line = () => [52, 55, 57, 59, 57, 55, 52, 55].map((p, i) => note(i * 0.5, p));
  const solve = (adaptNext, adaptPrevious = false) => {
    const lane = line();
    lane[2].pos = pin(5, 17, { influencePrevious: false, influenceNext: false, adaptPrevious, adaptNext });
    const { voiced, seats } = voiceNotesFingered(lane, tuning, Infinity, { bars: [0, 2, 4] });
    return { frets: lane.map((n) => voiced.get(n).fret), seats: lane.map((n) => seats.get(n)) };
  };
  const base = (() => { const lane = line(), v = voiceNotes(lane, tuning, Infinity, { bars: [0, 2, 4] }); return lane.map((n) => v.get(n).fret); })();

  // Ignored by the others: every other note is where it was without the override,
  // and the override alone reports a hand at its own fret.
  const alone = solve(false);
  assert.deepEqual(alone.frets.filter((_, i) => i !== 2), base.filter((_, i) => i !== 2));
  assert.equal(alone.seats[2], 17);
  assert.ok(alone.seats[1] < 10 && alone.seats[3] < 10);

  // Adapted to: what was played before stays, the hand goes to the override, and
  // the next note is played from there instead of jumping back.
  const followed = solve(true);
  assert.deepEqual(followed.frets.slice(0, 2), base.slice(0, 2));
  assert.equal(followed.seats[2], 17);
  assert.ok(followed.frets[3] >= 14, `the note after should be up at the hand, got fret ${followed.frets[3]}`);

  // Before only: the notes leading in are already up there, the one after is not.
  const led = solve(false, true);
  assert.ok(led.frets[0] >= 12 && led.frets[1] >= 12, `the notes before should be up at the hand, got ${led.frets}`);
  assert.equal(led.frets[3], base[3]);
  // Both: the whole bar.
  const both = solve(true, true);
  assert.ok(both.frets.slice(0, 4).every((f) => f >= 12), `got ${both.frets}`);
  assert.ok(both.frets.slice(4).every(f => f >= 12), "forward adaptation persists across the next bar");
}

// The same chord again follows; a different chord does not.
{
  const chord = (t) => [note(t, 52), note(t, 55), note(t, 59)];           // E3 G3 B3
  const a = chord(0), other = [note(1, 53), note(1, 57)], b = chord(2);
  const reach = { influencePrevious: false, influenceNext: true };
  a[0].pos = pin(4, 7, reach); a[1].pos = pin(3, 5, reach); a[2].pos = pin(2, 4, reach);
  const voiced = voiceNotes([...a, ...other, ...b], tuning);
  assert.deepEqual(b.map((n) => at(voiced, n)), ["4:7", "3:5", "2:4"]);
}

// A handed-on pin never puts a technique where it cannot be played: E4 pinned open,
// and the next E4 carries a slide.
{
  const reach = { influencePrevious: false, influenceNext: true };
  const lane = [note(0, 64, { pos: pin(0, 0, reach) }), note(1, 64), note(2, 64, { slide: "outDown" })];
  const voiced = voiceNotes(lane, tuning);
  assert.equal(at(voiced, lane[1]), "0:0");
  assert.notEqual(voiced.get(lane[2]).fret, 0, "a slide is not handed an open string");
}

// ---- what may be offered -------------------------------------------------
{
  // E4 with a slide out: every string but the open one.
  const lane = [note(0, 64, { slide: "outUp" })];
  const limits = placementLimits(chordColumns(lane), 0, tuning, () => null);
  assert.ok(placementFault(limits.get(lane[0]), 64, 0, tuning));
  assert.equal(placementFault(limits.get(lane[0]), 64, 1, tuning), null);
  assert.ok(shapeFault(lane, tuning, new Map([[lane[0], { string: 0, fret: 0 }]]), limits));
}
{
  // A3 legato-slides to B3. On the G string B3 is fret 4; on the B string it would
  // be open, which a legato target cannot be; the high E cannot sound either.
  const lane = [note(0, 57, { slide: "legato" }), note(1, 59)];
  const columns = chordColumns(lane);
  const voiced = voiceNotes(lane, tuning);
  assert.equal(voiced.get(lane[0]).string, voiced.get(lane[1]).string, "a slide runs along one string");
  const source = placementLimits(columns, 0, tuning, (n) => voiced.get(n)).get(lane[0]);
  assert.equal(placementFault(source, 57, 2, tuning), null);
  assert.equal(placementFault(source, 57, 3, tuning), null);
  // The target has exactly one place: the string the slide arrives on.
  const target = placementLimits(columns, 1, tuning, (n) => voiced.get(n)).get(lane[1]);
  const open = [0, 1, 2, 3, 4, 5].filter((s) => 59 - tuning[s] >= 0 && !placementFault(target, 59, s, tuning));
  assert.deepEqual(open, [voiced.get(lane[0]).string]);
}
{
  // G3 slides to A3. G3 on its own open string is refused twice over; on the D
  // string both notes are fretted, so that one is fine.
  const lane = [note(0, 55, { slide: "shift" }), note(1, 57)];
  const limit = placementLimits(chordColumns(lane), 0, tuning, () => null).get(lane[0]);
  assert.ok(placementFault(limit, 55, 2, tuning));
  assert.equal(placementFault(limit, 55, 3, tuning), null);
  // ...unless the target is pinned somewhere else.
  lane[1].pos = pin(4, 12);
  const pinned = placementLimits(chordColumns(lane), 0, tuning, () => null).get(lane[0]);
  assert.ok(placementFault(pinned, 55, 3, tuning));
  assert.equal(placementFault(pinned, 55, 4, tuning), null);
}

// ---- the hand, read off the notes ------------------------------------------
// A bass run coming down from the 13th fret to the 2nd inside one bar. One hand
// cannot be "at 2" for all of it: it is at 13, then 8, then 2.
{
  const bass = [43, 38, 33, 28];
  const off = { influencePrevious: false, influenceNext: false, adaptPrevious: false, adaptNext: false };
  const run = [[0, 13], [1, 13], [2, 10], [2, 9], [3, 9], [3, 8], [3, 2]].map(([string, fret], i) =>
    note(i * 0.2, bass[string] + fret, { pos: pin(string, fret, off) }));
  const { seats, fingers } = voiceNotesFingered(run, bass, Infinity, { bars: [0, 4], instrument: "bass" });
  assert.deepEqual(run.map((n) => seats.get(n)), [13, 13, 8, 8, 8, 8, 2]);
  assert.deepEqual(run.map((n) => fingers.get(n)), [1, 1, 3, 2, 2, 1, 1]);
  // A bass reaches five frets with a stretch (a guitar six): 5 to 9 keeps the hand
  // and the pinky takes the 9; 5 to 10 does not.
  const reachy = [5, 5, 9, 5].map((fret, i) => note(i * 0.5, bass[2] + fret, { pos: pin(2, fret, off) }));
  const got = voiceNotesFingered(reachy, bass, Infinity, { bars: [0, 4], instrument: "bass" });
  assert.deepEqual(reachy.map((n) => got.seats.get(n)), [5, 5, 5, 5]);
  assert.equal(got.fingers.get(reachy[2]), 4);
  const far = [5, 10].map((fret, i) => note(i * 0.5, bass[2] + fret, { pos: pin(2, fret, off) }));
  const gotFar = voiceNotesFingered(far, bass, Infinity, { bars: [0, 4], instrument: "bass" });
  assert.notEqual(gotFar.seats.get(far[1]), 5, "six frets is past a bass hand");
  assert.deepEqual(handChoices(new Map([[far[1], { string: 2, fret: 10 }]]), BASS_HAND_PROFILE), [6, 7, 8, 9, 10]);
  assert.deepEqual(handChoices(new Map([[far[1], { string: 2, fret: 10 }]])), [5, 6, 7, 8, 9, 10]);
  // Three outside is not: 5 5 12 5 moves there and back.
  reachy[2].pitch = bass[2] + 12; reachy[2].pos = pin(2, 12, off);
  const moved = voiceNotesFingered(reachy, bass, Infinity, { bars: [0, 4], instrument: "bass" });
  assert.deepEqual(reachy.map((n) => moved.seats.get(n)), [5, 5, 12, 5]);
}

// ---- stacked notes -------------------------------------------------------
// Two A4 over each other are one note downstream: the longest of them.
{
  const short = note(0, 57), long = { start: 0.1, end: 2, pitch: 57 }, apart = note(3, 57);
  const lane = [short, long, apart];
  const columns = chordColumns(lane);
  assert.deepEqual(columns.map((c) => c.notes), [[long], [apart]]);
  const voiced = voiceNotes(lane, tuning);
  assert.ok(voiced.get(long) && voiced.get(apart) && !voiced.has(short));
}
console.log("ok");

// A column wider than any hand — fret 1 on the low E and fret 15 on the high E,
// pinned, at once — still gets a hand: the index on its lowest note. It used to
// leave the hand walk with no state at all, and the lane's whole fingering
// (fretboard, tab) failed.
{
  const off = { influencePrevious: false, influenceNext: false, adaptPrevious: false, adaptNext: false };
  const wide = [note(0, 40 + 1, { pos: pin(5, 1, off) }), note(0, 64 + 15, { pos: pin(0, 15, off) }), note(1, 45 + 3)];
  const { voiced, seats } = voiceNotesFingered(wide, tuning, Infinity, { bars: [0, 4] });
  assert.equal(at(voiced, wide[0]), "5:1");
  assert.equal(at(voiced, wide[1]), "0:15");
  assert.equal(seats.get(wide[0]), undefined, 'an impossible pin keeps its notes but has no physical hand anchor');
}

// A scratch between two notes at fret 7: the muted strings say fret 1 and fret 15
// (an imported tab writes some number), the open G rings. Muted notes are no reach,
// so the hand stays at 7 rather than jumping to 1 and back.
{
  const off = { influencePrevious: false, influenceNext: false, adaptPrevious: false, adaptNext: false };
  const dead = { dead: true };
  const lane = [
    note(0, 50 + 7, { pos: pin(3, 7, off) }),
    note(0.5, 45 + 1, { pos: pin(4, 1, off), fx: dead }), note(0.5, 55, { pos: pin(2, 0, off) }),
    note(0.5, 50 + 15, { pos: pin(3, 15, off), fx: dead }),
    note(1, 50 + 7, { pos: pin(3, 7, off) }),
  ];
  const { seats } = voiceNotesFingered(lane, tuning, Infinity, { bars: [0, 4] });
  assert.deepEqual(lane.map((n) => seats.get(n)), [7, 7, 7, 7, 7]);
}

// The showcase's small shift must follow the same hand as a direct hand hold,
// for both a single-note pin and a chord pin. Earlier bars stay untouched.
for (const chordPin of [false, true]) {
  const lane = [note(0, 52), note(1, 55), note(2, 57),
    ...[52, 55, 59].map(p => note(3, p)),
    note(4, 52), note(5, 55), note(6, 57),
    ...[52, 55, 59].map(p => note(7, p))];
  const time = chordPin ? 3 : 4;
  const selected = lane.filter(n => n.start === time);
  const positions = new Map([[52, [3, 2]], [55, [2, 0]], [59, [1, 0]]]);
  for (const n of selected) {
    const [string, fret] = positions.get(n.pitch);
    n.pos = pin(string, fret, { influencePrevious: false, influenceNext: false,
      adaptPrevious: false, adaptNext: false });
  }
  const options = { bars: [0, 4, 8], instrument: "electric" };
  const before = voiceNotesFingered(lane, tuning, Infinity, options);
  const anchor = before.seats.get(selected[0]);
  assert.equal(anchor, 2);
  // A hand anchor moves no note; adapting to the override is what moves the notes after it.
  const direct = voiceNotesFingered(lane, tuning, Infinity,
    { ...options, holds: [{ t: time, fret: anchor }] });
  for (const n of lane) assert.deepEqual(direct.voiced.get(n), before.voiced.get(n),
    `a hand anchor moves no note (chord=${chordPin}, t=${n.start})`);
  for (const n of selected) n.pos.adaptNext = true;
  const adapted = voiceNotesFingered(lane, tuning, Infinity, options);
  for (const n of lane) if (n.start < time) assert.deepEqual(adapted.voiced.get(n), before.voiced.get(n),
    "forward adaptation leaves the approach unchanged");
}

// From hand position 2, the exact E3/G3/B3 chord may use D2/G0/B0.
// Single G3 still avoids its open string; chord techniques still require frets.
{
  // Position 2 is set by a first note the rest adapt to (a hand anchor moves no note).
  const lane = [note(0, 52, { pos: pin(3, 2, { influencePrevious: false, influenceNext: false,
    adaptPrevious: false, adaptNext: true }) }), note(1, 55), note(2, 57),
    ...[52, 55, 59].map(p => note(3, p))];
  const options = { bars: [0, 4] };
  const { voiced, seats } = voiceNotesFingered(lane, tuning, Infinity, options);
  assert.notEqual(voiced.get(lane[1]).fret, 0, "single notes keep the open-string restriction");
  assert.deepEqual(lane.slice(3).map(n => at(voiced, n)), ["3:2", "2:0", "1:0"]);
  assert.equal(seats.get(lane[3]), 2, "the chord needs no shift away from hand position 2");
  const columns = chordColumns(lane);
  const shape = new Map(lane.slice(3).map(n => [n, voiced.get(n)]));
  const higher = new Map(lane.slice(3).map((n, k) => [n, [{ string: 4, fret: 7 }, { string: 3, fret: 5 }, { string: 2, fret: 4 }][k]]));
  const [open, up] = scoreShapesAsDecided([shape, higher], columns, 3, tuning, options);
  assert.ok(open.cost < up.cost, "from hand position 2 the open grip is cheaper; its open strings cost nothing");
  lane[4].slide = "outUp";
  const constrained = voiceNotes(lane, tuning, Infinity, options);
  assert.notEqual(constrained.get(lane[4]).fret, 0, "a chord slide still requires a fret");
}
