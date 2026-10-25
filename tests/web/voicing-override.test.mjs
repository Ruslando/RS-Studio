// Run: node tests/web/voicing-override.test.mjs
// What an override reaches, and what a technique forbids an override to offer.
import assert from "node:assert/strict";
import { BASS_HAND_PROFILE, chordColumns, handChoices, overrideFlow, overrideInfluence, placementFault, placementLimits, scoreShapesAsDecided, shapeFault, voiceNotes, voiceNotesFingered } from "../../web/voicing-core.js";

const tuning = [64, 59, 55, 50, 45, 40];              // app order: string 0 = high E
const note = (start, pitch, extra = {}) => ({ start, end: start + 0.4, pitch, ...extra });
const pin = (string, fret, reach = {}) => ({ string, fret, scope: "local", ...reach });
const at = (voiced, n) => `${voiced.get(n).string}:${voiced.get(n).fret}`;

// ---- how an override carries on -------------------------------------------
// A4 five times. The third is pinned to the A string, fret 12.
{
  const lane = [0, 1, 2, 3, 4].map((t) => note(t, 57));
  assert.deepEqual(overrideInfluence([lane[2]]), { follow: "here" }, "a new override is only here");
  assert.equal(overrideFlow([{ pitch: 57, pos: pin(4, 12) }]).follow, "here", "an imported pin too");
  assert.equal(overrideFlow([{ pitch: 57, pos: pin(4, 12, { adaptNext: true, influenceNext: true }) }]).follow, "here",
    "the old switches are not read");
  const auto = at(voiceNotes(lane, tuning), lane[0]);
  assert.notEqual(auto, "4:12", "the test needs a pin that differs from the automatic answer");
  const played = () => { const voiced = voiceNotes(lane, tuning); return lane.map((n) => at(voiced, n)); };

  lane[2].pos = pin(4, 12, { follow: "locked" });
  assert.deepEqual(played(), [auto, auto, "4:12", "4:12", "4:12"], "locked: the same notes after, nothing before");
  lane[2].pos = pin(4, 12);
  assert.deepEqual(played(), [auto, auto, "4:12", auto, auto], "only here: one column");
  // A later override of the same notes takes over from where it stands.
  lane[2].pos = pin(4, 12, { follow: "locked" });
  lane[3].pos = pin(2, 2);
  assert.deepEqual(played(), [auto, auto, "4:12", "2:2", auto], "a later override ends the lock");
}

// Guided: the same notes after prefer the override where the hand allows it, and no
// other note's memory changes.
{
  const options = { bars: [0, 4, 8, 12, 16] };
  const play = (notes) => { const v = voiceNotes(notes, tuning, Infinity, options); return notes.map((n) => at(v, n)); };
  // Alone, a repeated C#4 follows the override: one shift there, then it stays.
  const repeated = () => [0, 1, 2, 3, 4, 5].map((t) => note(t, 61));
  const base1 = play(repeated());
  const alone = repeated();
  alone[2].pos = pin(3, 11, { follow: "guided" });
  assert.deepEqual(play(alone), [...base1.slice(0, 2), "3:11", "3:11", "3:11", "3:11"], "guided: the same notes after follow");
  // Inside a motif played around the 7th fret, the hand would have to leave and
  // come back for each one: a preference the hand declines, and the motif's other
  // notes keep what they learned.
  const motif = [57, 59, 61, 59];
  const lane = () => [...motif, ...motif, ...motif, ...motif].map((pitch, i) => note(i, pitch));
  const base = play(lane());
  const far = lane();
  far[6].pos = pin(4, 16, { follow: "guided" });
  const stays = play(far);
  assert.equal(stays[6], "4:16");
  assert.deepEqual(stays.filter((_, i) => i !== 6), base.filter((_, i) => i !== 6),
    "out of the hand's way it is a preference the hand may decline; nothing before it changes");
}

// The same chord again follows a locked override; a different chord does not.
{
  const chord = (t) => [note(t, 52), note(t, 55), note(t, 59)];           // E3 G3 B3
  const a = chord(0), other = [note(1, 53), note(1, 57)], b = chord(2);
  const reach = { follow: "locked" };
  a[0].pos = pin(4, 7, reach); a[1].pos = pin(3, 5, reach); a[2].pos = pin(2, 4, reach);
  const voiced = voiceNotes([...a, ...other, ...b], tuning);
  assert.deepEqual(b.map((n) => at(voiced, n)), ["4:7", "3:5", "2:4"]);
}

// A handed-on pin never puts a technique where it cannot be played: E4 pinned open,
// and the next E4 carries a slide.
{
  const reach = { follow: "locked" };
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
  const off = { follow: "here" };
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
  const off = { follow: "here" };
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
  const off = { follow: "here" };
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
    n.pos = pin(string, fret);
  }
  const options = { bars: [0, 4, 8], instrument: "electric" };
  const before = voiceNotesFingered(lane, tuning, Infinity, options);
  const anchor = before.seats.get(selected[0]);
  assert.equal(anchor, 2);
  // A hand anchor moves no note, and nothing reaches back before an override.
  const direct = voiceNotesFingered(lane, tuning, Infinity,
    { ...options, holds: [{ t: time, fret: anchor }] });
  for (const n of lane) assert.deepEqual(direct.voiced.get(n), before.voiced.get(n),
    `a hand anchor moves no note (chord=${chordPin}, t=${n.start})`);
  for (const n of selected) n.pos.follow = "guided";
  const adapted = voiceNotesFingered(lane, tuning, Infinity, options);
  for (const n of lane) if (n.start < time) assert.deepEqual(adapted.voiced.get(n), before.voiced.get(n),
    "a guided override leaves the approach unchanged");
}

// From hand position 2, the exact E3/G3/B3 chord may use D2/G0/B0.
// Single G3 still avoids its open string; chord techniques still require frets.
{
  // Position 2 is set by a guided first note (a hand anchor moves no note).
  const lane = [note(0, 52, { pos: pin(3, 2, { follow: "guided" }) }), note(1, 55), note(2, 57),
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

// ---- an override "only here" leaves its neighbours as they were -----------------
// Bb5 voiced at the 8th, Fsus4/C after it at the 10th. Bb5 is then pinned at the 3rd
// "only here": recalculating Fsus4/C must give the 10th again, not a fresh solve's 15th.
{
  const bb5 = [58, 65, 70].map((p) => note(0, p)), fsus = [60, 65, 70].map((p) => note(1, p));
  const lane = [...bb5, ...fsus];
  const kept = new Map([[58, [3, 8]], [65, [2, 10]], [70, [1, 11]]]);
  bb5.forEach((n) => { const [string, fret] = kept.get(n.pitch); n.auto = { string, fret, hand: 8, n: 3 }; });
  const before = voiceNotes(lane, tuning);
  [[2, 3], [1, 6], [0, 6]].forEach(([string, fret], k) => { bb5[k].pos = pin(string, fret); });
  const after = voiceNotes(lane, tuning);
  assert.deepEqual(fsus.map((n) => at(after, n)), fsus.map((n) => at(before, n)), "the pin changed its neighbour");
}

// ---- a guided override pulls its bar's register to where it is played -----------
// Bb5 pinned at the 3rd, then a chord sharing none of its notes (C5: C4 G4 C5). Read
// by pitch alone the bar wanted the 10th; read where the Bb5 is played, it stays by it.
{
  const bb5 = [58, 65, 70].map((p) => note(0, p)), c5 = [60, 67, 72].map((p) => note(1, p));
  [[2, 3], [1, 6], [0, 6]].forEach(([string, fret], k) => { bb5[k].pos = pin(string, fret, { follow: "guided" }); });
  const voiced = voiceNotes([...bb5, ...c5], tuning);
  assert.deepEqual(c5.map((n) => at(voiced, n)), ["2:5", "1:8", "0:8"], "C5 next to the pinned Bb5");
}
