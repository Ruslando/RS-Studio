// Every issue the editor finds in a layer: error, warning, or informational note.
// One list: the stage marks them (draw.js) and the artifact pane lists them under
// Errors, Warnings and Notes (rocksmith-check.js), next to the export's own check and the
// markers' problems. A new kind of problem goes here, nowhere else.
//
// An issue: { kind, tone: "error" | "warning" | "note", title, help, time, notes }.

import { chordWarnings, SHAPE_WARNINGS } from "./chord-warnings.js";
import { outOfFretboardRange } from "./voicing-core.js";
import { bendCurve } from "./bend.js";
import { OVERLAP_EPS } from "./constants.js";
import { paintMemo } from "./paint-memo.js";

export const ISSUE_TEXT = {
  outOfRange: ["Note out of range", "No string and fret of this tuning plays this pitch. Change the note or the tuning."],
  stack: ["Notes stacked on one pitch", "Notes of the same pitch overlap, so they play as one. Delete or shorten one of them."],
  bendStack: ["Bend points at the same moment", "Rocksmith keeps only the first of them. Move one point a little apart."],
};

// Playing techniques an imported note has in its Guitar Pro data (n.gp, guitar-pro-core.js)
// that the editor has no field for, so the Rocksmith chart does not show them. Kept for
// the Guitar Pro export. One whose editor effect was changed since is the editor's now.
export const GP_ONLY_TEXT = {
  pickSlide: ["Pick slide not in Rocksmith", "This older import has no pick-slide projection. Reimport the layer or choose a pick slide to export it as a muted slide."],
  harmonic: ["Harmonic type not in Rocksmith", "Guitar Pro has a tapped, semi or feedback harmonic here. Rocksmith only has natural and pinch harmonics, so the chart shows a plain note. Choose one in the Harmonic menu."],
  leftTap: ["Left-hand tap not in Rocksmith", "Guitar Pro has a tap with the fretting hand here. Rocksmith has one tap for both hands, and the chart shows a plain note. Choose Tapping under Slap / pop to show it as tapping."],
  ornament: ["Ornament not in Rocksmith", "Guitar Pro has a turn or mordent here, a quick figure around the note. Rocksmith shows only the note. Write the figure out as notes to show it."],
  barVibrato: ["Whammy vibrato not in Rocksmith", "Guitar Pro has a vibrato with the whammy bar here. Rocksmith shows no vibrato. Set Vibrato to show one."],
  golpe: ["Golpe not in Rocksmith", "Guitar Pro has a golpe here, a tap on the guitar's body. Rocksmith has nothing for it."],
  rasgueado: ["Rasgueado not in Rocksmith", "Guitar Pro has a rasgueado here, a strum with the fingers one after another. Rocksmith shows the notes without it."],
  deadSlapped: ["Dead slapped not in Rocksmith", "This older import has no dead-slap projection. Reimport the layer or set Slapping and Dead / muted note."],
};

// Editor effects the Rocksmith chart leaves out, having nothing to show them with
// (rocksmith/chart.py). A whammy, a trill and a grace note it imitates instead.
export const DROPPED_TEXT = {
  ghost: ["Ghost note not in Rocksmith", "Rocksmith has no quiet notes, so the chart shows a normal one."],
  staccato: ["Staccato not in Rocksmith", "Rocksmith shows the note as long as it is drawn. Shorten the note to make it short."],
  letRing: ["Let ring not in Rocksmith", "Rocksmith shows the note as long as it is drawn. Lengthen the note to let it ring."],
  strum: ["Strum not in Rocksmith", "Rocksmith has no strum direction, so the chart shows the chord without one."],
};

export const droppedEffects = (n) => [
  ...["staccato", "letRing"].filter((key) => n.fx?.[key])];

export const ADAPTED_TEXT = {
  pickSlide: ["Pick slide as a muted slide", "Rocksmith shows a tapped, muted unpitched slide high on the neck."],
  ghost: ["Ghost note is not scored", "Rocksmith shows this note with Ignore enabled; quiet dynamics are not represented."],
  trill: ["Trill as hammer-ons and pull-offs", "Rocksmith plays alternating notes a sixteenth apart. If the figure cannot fit, the export reports a warning."],
  grace: ["Grace note as a short lead-in", "Rocksmith plays a short note hammered into the main note. If there is no room, the export reports a warning."],
  whammy: ["Whammy as slides", "Rocksmith approximates the pitch curve with slides along the string. If it cannot fit, the export reports a warning."],
  ornament: ["Ornament as hammer-ons and pull-offs", "Rocksmith writes the figure as thirty-second notes, holding the last note. If it cannot fit, the export reports a warning."],
  artificial: ["Artificial harmonic as pinch harmonic", "Rocksmith uses its pinch-harmonic notation for this harmonic."],
};

const BEAT_TECHNIQUES = new Set(["barVibrato", "golpe", "rasgueado", "deadSlapped", "strum"]);

export function gpOnlyTechniques(n) {
  const gp = n.gp;
  if (!gp) return [];
  // Every tied part has its own (gp.tieSegments).
  const parts = [gp, ...(gp.tieSegments || [])];
  const onNote = (key) => parts.some((p) => p[key] || p.noteExtras?.[key]), onBeat = (key) => parts.some((p) => p.beatExtras?.[key]);
  const kept = (key) => (n[key] ?? null) === (gp.editorEffects?.[key] ?? null);
  const out = [];
  if (!n.slide?.startsWith("pick") && kept("slide") && parts.some((p) => p.slideOutType === 5 || p.slideOutType === 6)) out.push("pickSlide");
  if (kept("harmonic") && parts.some((p) => [4, 5, 6].includes(p.harmonicType))) out.push("harmonic");
  if (kept("slap") && n.slap !== "tap" && onNote("isLeftHandTapped")) out.push("leftTap");
  if (!n.ornament && onNote("ornament")) out.push("ornament");
  if (onBeat("vibrato") && !n.fx?.vibrato) out.push("barVibrato");
  for (const key of ["golpe", "rasgueado", "deadSlapped"]) if (onBeat(key) && !(key === "deadSlapped" && n.slap === "slap" && n.fx?.dead)) out.push(key);
  return out;
}

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
      // Placed on different strings (a 12-string's unisons), the same pitch is two notes (voicing-core.js unstacked).
      const apart = (m) => Number.isInteger(arr[i].pos?.string) && Number.isInteger(m.pos?.string) && m.pos.string !== arr[i].pos.string;
      for (j = i + 1; j < arr.length && arr[j].start < maxEnd - OVERLAP_EPS && !apart(arr[j]); j++) maxEnd = Math.max(maxEnd, arr[j].end);
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

export const laneIssues = paintMemo(function laneIssues(lane, tuning, maxFret, revision = 0) {
  if (!lane?.notes?.length) return [];
  const out = [];
  const outside = (n) => outOfFretboardRange(n.pitch, tuning, maxFret);
  const byBeat = new Map();
  // A chord with a note no fret reaches is that note's problem, said once, below.
  for (const { notes, kind } of chordWarnings(lane, tuning, maxFret, revision)) if (!notes.some(outside))
    out.push(issue("shape", "warning", SHAPE_WARNINGS[kind], notes));
  for (const n of lane.notes) {
    if (outside(n)) out.push(issue("outOfRange", "warning", ISSUE_TEXT.outOfRange, [n]));
    for (const b of stackedBends(n)) out.push(issue("bendStack", "warning", ISSUE_TEXT.bendStack, [n], b.time));
    const adapted = [n.slide?.startsWith("pick") && "pickSlide", n.fx?.ghost && "ghost", n.trill && "trill",
      n.grace && "grace", n.whammy && "whammy", n.ornament && "ornament", n.harmonic === "artificial" && "artificial"];
    for (const kind of adapted.filter(Boolean)) out.push(issue(kind, ["ghost", "whammy", "artificial"].includes(kind) ? "warning" : "note", ADAPTED_TEXT[kind], [n]));
    for (const kind of [...gpOnlyTechniques(n), ...droppedEffects(n)]) {
      // A beat's technique (a rasgueado on a chord) is one warning for the chord.
      const key = BEAT_TECHNIQUES.has(kind) ? `${kind}@${n.start}` : null, same = key && byBeat.get(key);
      if (same) same.notes.push(n);
      else { const found = issue(kind, "warning", GP_ONLY_TEXT[kind] || DROPPED_TEXT[kind], [n]); out.push(found); if (key) byBeat.set(key, found); }
    }
  }
  for (const notes of stackClusters(lane.notes)) out.push(issue("stack", "warning", ISSUE_TEXT.stack, notes));
  return out.sort((a, b) => a.time - b.time);
});
