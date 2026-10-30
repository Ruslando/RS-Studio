// The name of each chord in a layer: the engine's (chords.js), or one the user
// gave it. A given name rides on the chord's notes (chordName) together with the
// tones it was given to (chordNameFor), so a chord whose tones change goes back
// to the engine's name instead of keeping one that no longer fits.
import { PC_NAMES, analyzeChord } from "./chords.js";
import { chordColumns } from "./voicing-core.js";

const pitchKey = (pitches) => [...new Set(pitches)].sort((a, b) => a - b).join(",");

// What a column plays: its written-out arrangement if it has one (as
// arrangedNotes plays it), else its notes without the dead ones.
function playedPitches(notes) {
  const arr = notes.find((n) => n.arrangement)?.arrangement;
  return (arr?.notes?.length ? arr.notes : notes.filter((n) => !n.fx?.dead)).map((n) => n.pitch);
}

// { t0, notes, key, auto, alternatives, name, own } for every column of two or
// more sounding pitches. `name` is what is shown and exported; `own` says the user chose it.
function chordsOf(notes) {
  return chordColumns(notes).flatMap(({ t0, notes: members }) => {
    const pitches = playedPitches(members);
    if (new Set(pitches).size < 2) return [];
    const key = pitchKey(pitches), found = analyzeChord(pitches);
    const auto = found?.symbol || "";
    const given = members.find((n) => n.chordName && n.chordNameFor === key)?.chordName;
    return [{ t0, notes: members, key, auto, alternatives: found?.alternatives || [],
      name: given || auto, own: !!given }];
  });
}

// Every frame asks, so the answer is kept until a note it depends on changes.
const cache = new WeakMap();
export function laneChords(lane) {
  if (!lane?.notes?.length) return [];
  const signature = JSON.stringify(lane.notes.map((n) => [n.id, n.start, n.pitch, !!n.fx?.dead,
    n.chordName, n.chordNameFor, n.arrangement?.notes?.map((a) => a.pitch)]));
  const hit = cache.get(lane);
  // The same notes, not only alike ones: undo puts back copies with the same ids, and
  // a chord holding the old objects would rename notes no longer in the lane.
  if (hit?.signature === signature && hit.notes.length === lane.notes.length
      && hit.notes.every((n, i) => n === lane.notes[i])) return hit.chords;
  const chords = chordsOf(lane.notes);
  cache.set(lane, { signature, chords, notes: lane.notes.slice() });
  return chords;
}

// What to call a chord the engine has no name for: two tones are spelled out ("A + C#").
// Shown only — the export keeps no name for them, as before.
export function chordLabel(chord) {
  if (chord?.auto) return chord.auto;
  const pcs = [...new Set(playedPitches(chord?.notes || []).sort((a, b) => a - b).map((p) => PC_NAMES[p % 12]))];
  return pcs.length === 2 ? pcs.join(" + ") : "";
}

// The chord `note` belongs to, if it is part of one.
export const chordOfNote = (lane, note) => laneChords(lane).find((c) => c.notes.includes(note)) || null;

// Give a chord a name, or "" (or the engine's own) to return it to the engine's.
export function setChordName(chord, text) {
  const name = text.trim();
  for (const n of chord.notes) {
    if (name && name !== chord.auto) { n.chordName = name; n.chordNameFor = chord.key; }
    else { delete n.chordName; delete n.chordNameFor; }
  }
}

// The export's notes are the arranged ones, new objects: each column of them gets
// the name of the layer's chord that starts at the same time.
export function nameExportChords(lane, exportNotes) {
  const names = new Map(laneChords(lane).map((c) => [c.t0, c.name]));
  for (const { t0, notes } of chordColumns(exportNotes)) {
    const name = names.get(t0);
    if (name) for (const n of notes) n.chordName = name;
  }
}
