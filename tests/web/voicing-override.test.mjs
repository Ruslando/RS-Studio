// Run: node tests/web/voicing-override.test.mjs
// What an override reaches, and what a technique forbids an override to offer.
import assert from "node:assert/strict";
import { chordColumns, overrideInfluence, placementFault, placementLimits, shapeFault, voiceNotes } from "../../web/voicing-core.js";

const tuning = [64, 59, 55, 50, 45, 40];              // app order: string 0 = high E
const note = (start, pitch, extra = {}) => ({ start, end: start + 0.4, pitch, ...extra });
const pin = (string, fret, reach = {}) => ({ string, fret, scope: "local", ...reach });
const at = (voiced, n) => `${voiced.get(n).string}:${voiced.get(n).fret}`;

// ---- reach -------------------------------------------------------------
// A4 five times. The third is pinned to the A string, fret 12.
{
  const lane = [0, 1, 2, 3, 4].map((t) => note(t, 57));
  assert.deepEqual(overrideInfluence([lane[2]]), { previous: false, next: true }, "a new override reaches forward only");
  const auto = at(voiceNotes(lane, tuning), lane[0]);
  assert.notEqual(auto, "4:12", "the test needs a pin that differs from the automatic answer");

  lane[2].pos = pin(4, 12, { influencePrevious: false, influenceNext: true });
  let voiced = voiceNotes(lane, tuning);
  assert.deepEqual(lane.map((n) => at(voiced, n)), [auto, auto, "4:12", "4:12", "4:12"], "after follows, before stays");

  lane[2].pos = pin(4, 12, { influencePrevious: true, influenceNext: false });
  voiced = voiceNotes(lane, tuning);
  assert.deepEqual(lane.map((n) => at(voiced, n)), ["4:12", "4:12", "4:12", auto, auto], "before only");

  lane[2].pos = pin(4, 12, { influencePrevious: false, influenceNext: false });
  voiced = voiceNotes(lane, tuning);
  assert.deepEqual(lane.map((n) => at(voiced, n)), [auto, auto, "4:12", auto, auto], "neither: one column");

  // A later pin takes over from where it stands.
  lane[2].pos = pin(4, 12, { influencePrevious: false, influenceNext: true });
  lane[3].pos = pin(2, 2, { influencePrevious: false, influenceNext: true });
  voiced = voiceNotes(lane, tuning);
  assert.deepEqual(lane.map((n) => at(voiced, n)), [auto, auto, "4:12", "2:2", "2:2"]);

  // A pin written before the flags existed stays one column's.
  delete lane[3].pos; lane[2].pos = pin(4, 12);
  voiced = voiceNotes(lane, tuning);
  assert.deepEqual(lane.map((n) => at(voiced, n)), [auto, auto, "4:12", auto, auto]);
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
console.log("ok");
