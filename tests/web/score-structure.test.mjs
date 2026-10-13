// Run: node tests/web/score-structure.test.mjs
// Inserting or removing a bar rewrites every note and marker behind the seam.
import assert from "node:assert/strict";
import { coverScoreDuration, insertTime, normalizeScoreBars, removeTime, shiftForInsert, shiftForRemoval } from "../../web/score-structure-core.js";

const span = (n) => [n.start, n.end];
const note = (start, end, id) => ({ id, start, end });

// ---- insert: two seconds of silence opened at 4 s -------------------------
{
  const lane = { notes: [note(1, 2, "before"), note(3, 5, "across"), note(4, 5, "at"), note(6, 7, "after")] };
  const marks = [{ t: 2 }, { t: 4 }, { t: 9 }];
  shiftForInsert([lane], [marks, null], 4, 2);
  assert.deepEqual(lane.notes.map(span), [[1, 2], [3, 7], [6, 7], [8, 9]],
    "before stays, a note held across the seam stays held, the rest moves whole");
  assert.deepEqual(marks.map((m) => m.t), [2, 6, 11], "a marker on the seam moves with what follows it");
  assert.equal(insertTime(3.9999, 4, 2), 3.9999);
}

// ---- remove: the window 4..6 cut out --------------------------------------
{
  const lane = { notes: [
    note(1, 2, "before"), note(7, 8, "after"), note(3, 8, "spans"), note(3, 5, "into"),
    note(5, 7, "out of"), note(4.5, 5.5, "inside"), note(2, 4, "touches the start"), note(6, 6.5, "touches the end"),
  ] };
  const marks = [{ t: 3 }, { t: 5 }, { t: 6 }, { t: 9 }];
  shiftForRemoval([lane], [marks], 4, 6);
  const left = Object.fromEntries(lane.notes.map((n) => [n.id, span(n)]));
  assert.deepEqual(left, {
    "before": [1, 2], "after": [5, 6], "spans": [3, 6], "into": [3, 4], "out of": [4, 5],
    "touches the start": [2, 4], "touches the end": [4, 4.5],
  }, "a note wholly inside the cut is the only one deleted");
  assert.deepEqual(marks.map((m) => m.t), [3, 4, 4, 7], "a marker inside the cut lands on the seam instead of vanishing");
  assert.equal(removeTime(4, 4, 6), 4);
}

// Insert then remove the same window puts everything back.
{
  const lane = { notes: [note(1, 2), note(3, 5), note(6, 7)] }, marks = [{ t: 2 }, { t: 6 }];
  const before = JSON.stringify([lane, marks]);
  shiftForInsert([lane], [marks], 4, 2);
  shiftForRemoval([lane], [marks], 4, 6);
  assert.equal(JSON.stringify([lane, marks]), before);
}

// ---- the bar list ---------------------------------------------------------
{
  const bars = normalizeScoreBars([{ seconds: 0, index: 7 }, { seconds: 2, timeSignatureNumerator: 3, keySignature: 99, section: { text: "Verse" } }], 5);
  assert.deepEqual(bars.map((b) => [b.index, b.seconds, b.durationSeconds]), [[0, 0, 2], [1, 2, 3]],
    "a bar lasts until the next one; the last one until the song ends");
  assert.equal(bars[0].sourceIndex, 7);
  assert.deepEqual([bars[1].timeSignatureNumerator, bars[0].timeSignatureNumerator, bars[1].keySignature], [3, 4, 7]);
  assert.deepEqual(bars[1].section, { marker: "", text: "Verse" });

  // Too short for the song: the last bar is repeated until the song is covered.
  const covered = coverScoreDuration(bars, 12);
  assert.deepEqual(covered.map((b) => b.seconds), [0, 2, 5, 8, 11]);
  assert.ok(covered.slice(2).every((b) => b.section === null && b.durationSeconds === 3), "copies carry the length, not the section");
  assert.equal(new Set(covered.map((b) => b.id)).size, covered.length, "every bar has its own id");
  assert.equal(coverScoreDuration(bars, 5).length, 2, "already long enough: nothing is added");
  assert.deepEqual(bars[1].section, { marker: "", text: "Verse" }, "the source list is not touched");
}
console.log("score-structure: ok");
