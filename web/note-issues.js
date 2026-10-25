// Every problem the editor finds in a layer's notes, each an error or a warning.
// One list: the stage marks them (draw.js) and the artifact pane lists them under
// Errors and Warnings (rocksmith-check.js), next to the export's own check and the
// markers' problems. A new kind of problem goes here, nowhere else.
//
// An issue: { kind, tone: "error" | "warning", title, help, time, notes }.

import { chordWarnings, SHAPE_WARNINGS } from "./chord-warnings.js";
import { outOfFretboardRange } from "./voicing-core.js";
import { bendCurve } from "./bend.js";
import { OVERLAP_EPS } from "./constants.js";

export const ISSUE_TEXT = {
  outOfRange: ["Note out of range", "No string and fret of this tuning plays this pitch. Change the note or the tuning."],
  stack: ["Notes stacked on one pitch", "Notes of the same pitch overlap, so they play as one. Delete or shorten one of them."],
  bendStack: ["Bend points at the same moment", "Rocksmith keeps only the first of them. Move one point a little apart."],
};

// Same-pitch notes that overlap in time, as clusters of two or more, earliest first.
export function stackClusters(notes) {
  const byPitch = new Map();
  for (const n of notes) (byPitch.get(n.pitch) || byPitch.set(n.pitch, []).get(n.pitch)).push(n);
  const out = [];
  for (const arr of byPitch.values()) {
    if (arr.length < 2) continue;
    arr.sort((p, q) => p.start - q.start);
    for (let i = 0, j; i < arr.length; i = j) {
      let maxEnd = arr[i].end;
      // More than a hair of overlap, so notes that only touch are not a stack.
      for (j = i + 1; j < arr.length && arr[j].start < maxEnd - OVERLAP_EPS; j++) maxEnd = Math.max(maxEnd, arr[j].end);
      if (j - i > 1) out.push(arr.slice(i, j));
    }
  }
  return out;
}

// Bend points of one note that land on the same millisecond: [{ index, count, time }].
export function stackedBends(note) {
  const pts = bendCurve(note);
  if (!pts || pts.length < 2) return [];
  const dur = note.end - note.start, ms = (f) => Math.round(f * dur * 1000), out = [];
  for (let i = 0, j; i < pts.length; i = j) {
    for (j = i + 1; j < pts.length && ms(pts[j][0]) === ms(pts[i][0]); j++);
    if (j - i > 1) out.push({ index: i, count: j - i, time: note.start + pts[i][0] * dur });
  }
  return out;
}

const issue = (kind, tone, [title, help], notes, time = notes[0].start) => ({ kind, tone, title, help, time, notes });

export function laneIssues(lane, tuning, maxFret, revision = 0) {
  if (!lane?.notes?.length) return [];
  const out = [];
  const outside = (n) => outOfFretboardRange(n.pitch, tuning, maxFret);
  // A chord with a note no fret reaches is that note's problem, said once, below.
  for (const { notes, kind } of chordWarnings(lane, tuning, maxFret, revision)) if (!notes.some(outside))
    out.push(issue("shape", kind === "impossible" ? "error" : "warning", SHAPE_WARNINGS[kind], notes));
  for (const n of lane.notes) {
    if (outside(n)) out.push(issue("outOfRange", "error", ISSUE_TEXT.outOfRange, [n]));
    for (const b of stackedBends(n)) out.push(issue("bendStack", "warning", ISSUE_TEXT.bendStack, [n], b.time));
  }
  for (const notes of stackClusters(lane.notes)) out.push(issue("stack", "error", ISSUE_TEXT.stack, notes));
  return out.sort((a, b) => a.time - b.time);
}
