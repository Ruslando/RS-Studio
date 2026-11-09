// Every issue the editor finds in a layer: error, warning, or informational note.
// One list: the stage marks them (draw.js) and the artifact pane lists them under
// Errors, Warnings and Notes (rocksmith-check.js), next to the export's own check and the
// markers' problems. A new kind of problem goes here, nowhere else.
//
// An issue: { id, kind, tone: "error" | "warning" | "note", title, help, time, notes }.

import { chordWarnings, SHAPE_WARNINGS } from "./chord-warnings.js";
import { outOfFretboardRange } from "./voicing-core.js";
import { bendCurve } from "./bend.js";
import { OVERLAP_EPS } from "./constants.js";
import { paintMemo } from "./paint-memo.js";

export const ISSUE_TEXT = {
  outOfRange: ["Note is outside the fret range", "No string can play this pitch within the selected fret range. Change the pitch, tuning, or fret range."],
  stack: ["Notes with the same pitch overlap", "Notes with the same pitch overlap on the same string or have no separate string positions. Remove the overlap or place them on different strings."],
  bendStack: ["Rocksmith: Bend points have the same time", "Rocksmith keeps only the first bend point at this time. Move or remove the other points."],
};

// Playing techniques an imported note has in its Guitar Pro data (n.gp, guitar-pro-core.js)
// that the editor has no field for, so the Rocksmith chart does not show them. Kept for
// the Guitar Pro export. One whose editor effect was changed since is the editor's now.
export const GP_ONLY_TEXT = {
  pickSlide: ["Rocksmith: Pick slide not supported", "The imported pick slide has no pick-slide effect in the editor. Select Pick slide up or Pick slide down in the Slide menu."],
  harmonic: ["Rocksmith: Harmonic type not supported", "Rocksmith supports natural and pinch harmonics. Select Natural or Pinch in the Harmonic menu."],
  leftTap: ["Rocksmith: Left-hand tap not supported", "Rocksmith has no separate notation for a left-hand tap. Select Tapping under Slap / pop to represent it as tapping."],
  ornament: ["Rocksmith: Ornament not supported", "Select a figure in the Ornament menu to convert this imported turn or mordent to notes for Rocksmith."],
  barVibrato: ["Rocksmith: Whammy vibrato not supported", "Rocksmith has no whammy-bar vibrato notation. Enable Vibrato to show finger vibrato instead."],
  golpe: ["Rocksmith: Golpe not supported", "Rocksmith cannot show a tap on the guitar body. The Guitar Pro export keeps this technique."],
  rasgueado: ["Rocksmith: Rasgueado not supported", "Rocksmith shows the chord notes without this strum technique. The Guitar Pro export keeps the technique."],
  deadSlapped: ["Rocksmith: Dead slap not supported", "The imported dead slap is not fully represented by the editor effects. Select Slapping under Slap / pop and enable Dead / muted note."],
};

// Editor effects the Rocksmith chart leaves out, having nothing to show them with
// (rocksmith/chart.py). A whammy, a trill and a grace note it imitates instead.
export const DROPPED_TEXT = {
  ghost: ["Rocksmith: Ghost note not supported", "Rocksmith cannot show the quiet dynamics of this note."],
  staccato: ["Rocksmith: Staccato not supported", "Rocksmith has no staccato notation. Shorten the note to represent the short sound."],
  letRing: ["Rocksmith: Let ring not supported", "Rocksmith has no let-ring notation. Extend the note to represent how long it sounds."],
  strum: ["Rocksmith: Strum direction not supported", "Rocksmith has no strum-direction notation. It shows the chord without the picking direction."],
};

export const droppedEffects = (n) => [
  ...["staccato", "letRing"].filter((key) => n.fx?.[key])];

export const ADAPTED_TEXT = {
  pickSlide: ["Rocksmith: Pick slide not supported", "Rocksmith has no pick-slide notation. The export represents the pick slide with a tapped, muted slide."],
  ghost: ["Rocksmith: Ghost note not supported", "Rocksmith has no ghost-note dynamics. The export shows this note but excludes it from scoring."],
  trill: ["Rocksmith: Trill not supported", "Rocksmith has no trill notation. The export writes alternating notes with hammer-ons and pull-offs."],
  grace: ["Rocksmith: Grace note not supported", "Rocksmith has no grace-note notation. The export writes a short note before the main note and connects the notes with a hammer-on."],
  whammy: ["Rocksmith: Whammy not supported", "Rocksmith has no whammy-bar notation. As in official charts, the export writes a dive as a note without sustain and a dip as vibrato."],
  ornament: ["Rocksmith: Ornament not supported", "Rocksmith has no turn or mordent notation. The export writes the figure as notes with hammer-ons and pull-offs."],
  artificial: ["Rocksmith: Artificial harmonic not supported", "Rocksmith has no separate notation for this artificial harmonic. The export uses pinch harmonic notation."],
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

const issue = (kind, tone, text, notes, time = notes[0].start) => {
  const [title, help] = text;
  const group = Object.values(ISSUE_TEXT).includes(text) ? "note"
    : Object.values(GP_ONLY_TEXT).includes(text) ? "import"
    : Object.values(DROPPED_TEXT).includes(text) ? "effect" : "adapt";
  return { id: `editor.${group}.${kind}`, kind, tone, title, help, time, notes };
};

export const laneIssues = paintMemo(function laneIssues(lane, tuning, maxFret, revision = 0) {
  if (!lane?.notes?.length) return [];
  const out = [];
  const outside = (n) => outOfFretboardRange(n.pitch, tuning, maxFret);
  const byBeat = new Map();
  // A chord with a note no fret reaches is that note's problem, said once, below.
  for (const { notes, kind } of chordWarnings(lane, tuning, maxFret, revision)) if (!notes.some(outside))
    out.push({ ...issue("shape", kind === "stretch" ? "note" : "warning", SHAPE_WARNINGS[kind], notes), id: `editor.shape.${kind}` });
  for (const n of lane.notes) {
    if (outside(n)) out.push(issue("outOfRange", "warning", ISSUE_TEXT.outOfRange, [n]));
    for (const b of stackedBends(n)) out.push(issue("bendStack", "warning", ISSUE_TEXT.bendStack, [n], b.time));
    const adapted = [n.slide?.startsWith("pick") && "pickSlide", n.fx?.ghost && "ghost", n.trill && "trill",
      n.grace && "grace", n.whammy && "whammy", n.ornament && "ornament", n.harmonic === "artificial" && "artificial"];
    for (const kind of adapted.filter(Boolean)) out.push(issue(kind, ["ghost", "artificial"].includes(kind) ? "warning" : "note", ADAPTED_TEXT[kind], [n]));
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
