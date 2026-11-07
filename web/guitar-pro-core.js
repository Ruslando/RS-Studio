// Pure Guitar Pro -> editor conversion helpers. The alphaTab runtime is passed
// in by callers so this module stays DOM-free and can be regression-tested in
// Node with the same vendored bundle used by the browser.

import { effectSignatureFields } from "./note-effects.js";
import { defaultPinFlags } from "./voicing-core.js";
import { whammyKind } from "./whammy.js";

const GP_SCHEMA_VERSION = 2;
const QUARTER_TICKS = 960;

function projectionHash(value) {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}:${text.length}`;
}

// Whether an imported layer still says what its source says. A layer that does
// exports its source track untouched; otherwise its edits are written into it.
// Not a security hash: it catches normal edits, additions and deletions.
export function gpProjectionSignature(lane) {
  return projectionHash({
    name: lane.name,
    gmProgram: lane.gmProgram,
    // The strings are customTuning. The key naming them changes on load (mapLane
    // finds "custom" E A D G B E is E Standard), and that is no edit.
    customTuning: lane.customTuning,
    capo: lane.capo || 0,
    notes: lane.notes.map((note) => ({
      sourceNoteId: note.gp?.noteId ?? null,
      start: note.start, end: note.end, pitch: note.pitch,
      soundingPitch: note.soundingPitch ?? null,
      string: note.pos?.string ?? null, fret: note.pos?.fret ?? null,
      ...effectSignatureFields(note),
      ...(note.finger != null ? { finger: note.finger } : {}),
    })),
  });
}

// An imported layer's source: its one staff of the file, with the file's bars and
// everything the editor does not show (lyrics, notation, automations), as alphaTab
// JSON, gzipped and base64'd so it is saved inside the layer. `full` is the file's
// score as parsed JSON (JsonConverter.scoreToJson), made once per import.
// ponytail: alphaTab's JSON is version-specific; a vendored alphaTab update must read the old one.
// The file's texts as song comments (comments.js), over the highest note the beat
// plays, or the note nearest in time on a rest. One already there is not added again.
export function textComments(lanes, existing = []) {
  const have = new Set(existing.map((c) => `${c.t}|${c.text}`));
  const out = [];
  for (const lane of lanes) for (const item of lane.scoreText || []) {
    if (!item.text || !lane.notes.length || have.has(`${item.t}|${item.text}`)) continue;
    const onBeat = lane.notes.filter((n) => Math.abs(n.start - item.t) < 1e-6);
    const pitch = onBeat.length ? Math.max(...onBeat.map((n) => n.pitch))
      : lane.notes.reduce((a, b) => Math.abs(b.start - item.t) < Math.abs(a.start - item.t) ? b : a).pitch;
    have.add(`${item.t}|${item.text}`);
    out.push({ id: `comment_gp_${Date.now().toString(36)}_${out.length}`, t: item.t, pitch, text: item.text });
  }
  return out;
}

export async function packLaneSource(full, trackIndex, staffIndex) {
  const track = full.tracks[trackIndex];
  const json = JSON.stringify({ ...full, tracks: [{ ...track, staves: [track.staves[staffIndex]] }] });
  const zipped = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(zipped);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// The score packLaneSource saved: one track with one staff.
export async function unpackLaneSource(alphaTab, data) {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const json = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return alphaTab.model.JsonConverter.jsonToScore(json, new alphaTab.Settings());
}

// Cache identity for the app-authored score preview. Unlike the import
// integrity marker above, this intentionally covers created lanes and the
// explicit tablature role so toggling a reference layer invalidates the score
// without treating the toggle as an edit to the untouched GP source.
export function scoreProjectionSignature(lanes) {
  return projectionHash((lanes || []).map((lane) => ({
    id: lane.id,
    tablatureEnabled: lane.tablatureEnabled !== false,
    source: !!lane.gpSource,
    name: lane.name,
    instrument: lane.instrument,
    gmProgram: lane.gmProgram ?? null,
    tuning: lane.tuning,
    customTuning: lane.customTuning,
    capo: lane.capo || 0,
    transpositionPitch: lane.transpositionPitch || 0,
    displayTranspositionPitch: lane.displayTranspositionPitch || 0,
    notes: (lane.notes || []).map((note) => ({
      id: note.id, start: note.start, end: note.end, pitch: note.pitch,
      string: note.pos?.string ?? null, fret: note.pos?.fret ?? null,
      shapeId: note.shapeId ?? null,
      arrangement: note.arrangement ?? null,
      ...effectSignatureFields(note),
    })),
  })));
}

const gmFamily = (program) => {
  const p = Number(program);
  if (p >= 24 && p <= 31) return "guitar";
  if (p >= 32 && p <= 39) return "bass";
  if (p >= 0 && p <= 7) return "keyboard";
  if (p >= 52 && p <= 54) return "voice";
  if (p >= 72 && p <= 79) return "wind";
  return "other";
};

function classifyGpTrack(track) {
  const staves = track?.staves || [];
  const percussion = staves.some((s) => s.isPercussion);
  const family = percussion ? "percussion" : gmFamily(track?.playbackInfo?.program);
  const supported = !percussion && (family === "guitar" || family === "bass")
    && staves.some((s) => (s.stringTuning?.tunings || []).length >= 4);
  const reason = supported ? "" : percussion
    ? "Percussion tracks are not supported yet"
    : family === "voice" ? "Vocal tracks are not supported yet"
    : family === "keyboard" ? "Keyboard tracks are not supported yet"
    : family === "wind" ? "Wind and recorder tracks are not supported yet"
    : "Only guitar and bass tracks are supported currently";
  return { family, supported, reason };
}

function usedVoiceIndexes(track) {
  const used = new Set();
  for (const staff of track.staves || [])
    for (const bar of staff.bars || [])
      for (const voice of bar.voices || [])
        if ((voice.beats || []).some((b) => (b.notes || []).length)) used.add(voice.index);
  return [...used].sort((a, b) => a - b);
}

function trackNoteCount(track) {
  let count = 0;
  for (const staff of track.staves || [])
    for (const bar of staff.bars || [])
      for (const voice of bar.voices || [])
        for (const beat of voice.beats || []) count += (beat.notes || []).length;
  return count;
}

export function inspectGpScore(score, alphaTabVersion = "") {
  return {
    schemaVersion: GP_SCHEMA_VERSION,
    alphaTabVersion,
    title: score.title || "",
    artist: score.artist || "",
    album: score.album || "",
    bars: (score.masterBars || []).length,
    tracks: (score.tracks || []).map((track) => {
      const classification = classifyGpTrack(track);
      return {
        index: track.index,
        name: track.name || `Track ${track.index + 1}`,
        program: track.playbackInfo?.program ?? 0,
        noteCount: trackNoteCount(track),
        voiceIndexes: usedVoiceIndexes(track),
        staves: (track.staves || []).map((staff) => ({
          index: staff.index,
          tuning: [...(staff.stringTuning?.tunings || [])],
          tuningName: staff.stringTuning?.name || "",
          capo: staff.capo || 0,
          percussion: !!staff.isPercussion,
        })),
        ...classification,
      };
    }),
  };
}

function masterBarDuration(masterBar) {
  if (typeof masterBar.calculateDuration === "function") return masterBar.calculateDuration();
  return Math.round((masterBar.timeSignatureNumerator || 4)
    * (4 / (masterBar.timeSignatureDenominator || 4)) * QUARTER_TICKS);
}

function tempoTimeline(score) {
  const out = [];
  let fallbackTick = 0;
  for (const bar of score.masterBars || []) {
    const start = Number.isFinite(bar.start) ? bar.start : fallbackTick;
    const duration = masterBarDuration(bar);
    const automations = [...(bar.tempoAutomations || [])].sort((a, b) => a.ratioPosition - b.ratioPosition);
    for (const automation of automations) {
      out.push({
        tick: start + duration * (automation.ratioPosition || 0),
        bpm: Math.max(1, Number(automation.value) || Number(score.tempo) || 120),
      });
    }
    fallbackTick = start + duration;
  }
  if (!out.length || out[0].tick > 0) out.unshift({ tick: 0, bpm: Math.max(1, Number(score.tempo) || 120) });
  out.sort((a, b) => a.tick - b.tick);
  const deduped = [];
  for (const point of out) {
    const previous = deduped[deduped.length - 1];
    if (previous && Math.abs(previous.tick - point.tick) < 1e-6) previous.bpm = point.bpm;
    else deduped.push(point);
  }
  let seconds = 0;
  for (let i = 0; i < deduped.length; i++) {
    if (i) {
      const previous = deduped[i - 1];
      seconds += (deduped[i].tick - previous.tick) / QUARTER_TICKS * 60 / previous.bpm;
    }
    deduped[i].seconds = seconds;
  }
  return deduped;
}

function tickToSeconds(tick, timeline) {
  let point = timeline[0];
  for (let i = 1; i < timeline.length && timeline[i].tick <= tick + 1e-9; i++) point = timeline[i];
  return point.seconds + (tick - point.tick) / QUARTER_TICKS * 60 / point.bpm;
}

function noteName(midi) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const value = Math.round(midi);
  return names[((value % 12) + 12) % 12] + (Math.floor(value / 12) - 1);
}

// A GP track states one General-MIDI program and the family classifier tells a
// bass part from a guitar one; the instrument then names the sound (toneOf).
function instrumentFor(program, family) {
  if (family === "bass") return { instrument: "bass" };
  if (program === 24 || program === 25) return { instrument: "acoustic" };
  return { instrument: "electric" };
}

// Where in its note a slide starts when Guitar Pro plays it: the file only says that
// a note slides. Measured from alphaTab's own playback over real files
// (tools/gp-audit): a slide out of the note moves in the last quarter, a slide onto
// the next note in the second half. The export reverses it (guitar-pro-edit.js).
export const GP_SLIDE_AT = { out: 0.75, next: 0.5 };
export const gpSlideAt = (kind) => ["outUp", "outDown", "pickUp", "pickDown"].includes(kind) ? GP_SLIDE_AT.out : GP_SLIDE_AT.next;

const SLIDE_INTO = { 1: "inBelow", 2: "inAbove" };
const SLIDE_ON = { 1: "shift", 2: "legato", 3: "outUp", 4: "outDown", 5: "pickDown", 6: "pickUp" };

function bendPreset(note) {
  if (!note.hasBend || !note.bendPoints?.length) return null;
  const peak = Math.max(...note.bendPoints.map((p) => Number(p.value) || 0));
  if (note.bendType === 8) return "prebendRelease";
  if (note.bendType === 4) return "release";   // the editor's "Bend & release"

  if (note.bendType === 6 || note.bendType === 7) return "prebend";
  if (peak >= 6) return "onehalf";
  return peak <= 2 ? "half" : "full";
}

function compactPoint(point) {
  return { offset: Number(point.offset ?? point.position ?? 0), value: Number(point.value) || 0 };
}

function compactAutomation(automation) {
  return {
    type: automation.type,
    value: automation.value,
    ratioPosition: automation.ratioPosition,
    isLinear: !!automation.isLinear,
    text: automation.text || "",
    isVisible: automation.isVisible !== false,
  };
}

function exactGpBeat(beat, track, staff, bar, voice) {
  const out = {
    track: track.index,
    staff: staff.index,
    bar: bar.index,
    voice: voice.index,
    beatId: beat.id,
    startTick: beat.absolutePlaybackStart,
    duration: beat.duration,
    playbackStart: beat.playbackStart,
    playbackDuration: beat.playbackDuration,
    dynamics: beat.dynamics,
  };
  const put = (key, value, defaultValue) => {
    if (value !== undefined && value !== null && !Object.is(value, defaultValue)) out[key] = value;
  };
  if (beat.displayStart !== beat.playbackStart) out.displayStart = beat.displayStart;
  if (beat.displayDuration !== beat.playbackDuration) out.displayDuration = beat.displayDuration;
  put("dots", beat.dots, 0);
  put("tupletNumerator", beat.tupletNumerator, -1);
  put("tupletDenominator", beat.tupletDenominator, -1);
  for (const [key, value, defaultValue] of [
    ["graceType", beat.graceType, 0], ["crescendo", beat.crescendo, 0], ["fade", beat.fade, 0],
    ["vibrato", beat.vibrato, 0], ["tremoloPicking", beat.tremoloPicking, 0],
    ["pickStroke", beat.pickStroke, 0], ["brushType", beat.brushType, 0],
    ["brushDuration", beat.brushDuration, 0], ["whammyBarType", beat.whammyBarType, 0],
    ["whammyStyle", beat.whammyStyle, 0], ["golpe", beat.golpe, 0],
    ["wahPedal", beat.wahPedal, 0], ["rasgueado", beat.rasgueado, 0],
    ["ottava", beat.ottava, 2], ["barreFret", beat.barreFret, -1],
    ["barreShape", beat.barreShape, 0],
  ]) put(key, value, defaultValue);
  const points = (beat.whammyBarPoints || []).map(compactPoint);
  if (points.length) out.whammyBarPoints = points;
  for (const key of ["isContinuedWhammy", "slap", "pop", "tap", "deadSlapped", "isEmpty",
    "isRest", "isLetRing", "isPalmMute", "isLegatoOrigin", "isEffectSlurOrigin"])
    if (beat[key]) out[key] = true;
  if (beat.chordId && beat.chordId !== "0") out.chordId = beat.chordId;
  const noteIds = (beat.notes || []).map((note) => note.id);
  if (noteIds.length) out.noteIds = noteIds;
  const automations = (beat.automations || []).map(compactAutomation);
  if (automations.length) out.automations = automations;
  const lyrics = (beat.lyrics || []).map((line) => line?.text ?? String(line ?? ""));
  if (lyrics.length) out.lyrics = lyrics;
  if (beat.fermata) out.fermata = { type: beat.fermata.type, length: beat.fermata.length };
  if (beat.text) out.text = beat.text;
  return out;
}

// What else the file says on a beat or note, beyond the editor's fields and the beat's
// timing: every field that differs from a new one (alphaTab's own defaults), so the
// export can write it back on a beat or note it builds anew (guitar-pro-edit.js
// restoreFileExtras). Read from the object, not listed: a field a later alphaTab adds
// is kept too.
const BEAT_OWN = new Set(["id", "index", "voice", "notes", "noteStringLookup", "noteValueLookup", "previousBeat", "nextBeat",
  "duration", "dots", "tupletNumerator", "tupletDenominator", "tupletGroup", "displayStart", "playbackStart", "displayDuration",
  "playbackDuration", "absolutePlaybackStart", "absoluteDisplayStart", "graceType", "graceGroup", "graceIndex", "isEmpty",
  "maxNote", "minNote", "maxStringNote", "minStringNote", "onNotes", "tap", "slap", "pop",
  "brushDuration", "whammyBarType", "whammyStyle", "isContinuedWhammy", "whammyBarPoints", "maxWhammyPoint", "minWhammyPoint",
  "tremoloPicking", "text", "chordId", "automations", "effectSlurOrigin", "effectSlurDestination", "isEffectSlurOrigin",
  "isLetRing", "isPalmMute", "fermata", "isLegatoDestination"]);
const NOTE_OWN = new Set(["id", "index", "beat", "string", "fret", "octave", "tone", "realValue", "realValueWithoutHarmonic",
  "displayValue", "displayValueWithoutBend", "isDead", "isGhost", "isLetRing", "isPalmMute", "isStaccato", "vibrato", "accentuated",
  "isHammerPullOrigin", "isHammerPullDestination", "hammerPullOrigin", "hammerPullDestination", "slideInType", "slideOutType",
  "slideTarget", "slideOrigin", "harmonicType", "harmonicValue", "hasBend", "bendType", "bendStyle", "bendPoints", "maxBendPoint",
  "bendOrigin", "isContinuedBend", "trillValue", "trillSpeed", "isTieDestination", "tieOrigin", "tieDestination", "isTieOrigin",
  "effectSlur", "hasEffectSlur", "isEffectSlurOrigin", "isEffectSlurDestination", "effectSlurOrigin", "effectSlurDestination",
  "slurOrigin", "slurDestination", "isSlurDestination", "isSlurOrigin", "letRingDestination", "palmMuteDestination",
  "chord", "lyrics"]);
// ponytail: port and channels stay the export's: two layers from two files could clash on them.
const TRACK_OWN = new Set(["index", "score", "staves", "playbackInfo", "color", "name", "percussionArticulations", "systemsLayout", "lyrics"]);
const CHORD_OWN = new Set(["name", "staff"]);
const PLAYBACK_OWN = new Set(["program", "port", "primaryChannel", "secondaryChannel"]);
const STAFF_OWN = new Set(["index", "track", "bars", "chords", "stringTuning", "capo", "transpositionPitch", "displayTranspositionPitch", "isPercussion"]);
export function fileExtras(object, own) {
  const fresh = new object.constructor(), out = {};
  for (const key of Object.keys(object)) {
    if (own.has(key)) continue;
    const value = object[key];
    if (Array.isArray(value) ? value.length && value.every((v) => v == null || typeof v !== "object") && JSON.stringify(value) !== JSON.stringify(fresh[key])
      : (value == null || typeof value !== "object") && !Object.is(value, fresh[key])) out[key] = Array.isArray(value) ? [...value] : value;
  }
  return Object.keys(out).length ? out : null;
}

function exactGpNote(note, beat, track, staff, bar, voice, startTick, endTick, tieSegments, effects) {
  const out = {
    track: track.index,
    staff: staff.index,
    bar: bar.index,
    voice: voice.index,
    beatId: beat.id,
    noteId: note.id,
    startTick,
    endTick,
    durationTicks: endTick - startTick,
    string: note.string,
    fret: note.fret,
    realValue: note.realValue,
    realValueWithoutHarmonic: note.realValueWithoutHarmonic,
    dynamics: note.dynamics,
    accidentalMode: note.accidentalMode,
    // The editor intentionally exposes a smaller, portable effect vocabulary
    // than Guitar Pro.  Keep the exact source fields above and also remember
    // the editor-facing projection.  Export can then distinguish "untouched"
    // from "the user cleared this effect" without rewriting custom source
    // curves merely because the editor showed their nearest preset.
    editorEffects: effects,
  };
  const put = (key, value, defaultValue) => {
    if (value !== undefined && value !== null && !Object.is(value, defaultValue)) out[key] = value;
  };
  if (tieSegments.length > 1) out.tieSegments = tieSegments;
  // A grace note plays before its beat; the export writes it back as one (guitar-pro-edit.js).
  if (beat.graceType) { out.graceType = beat.graceType; out.graceDuration = beat.duration; }
  // A strum written as a brush goes back out as one (guitar-pro-edit.js applyEditorEffects).
  if (beat.brushType) { out.brushType = beat.brushType; out.brushDuration = beat.brushDuration; }
  const beatExtras = fileExtras(beat, BEAT_OWN), noteExtras = fileExtras(note, NOTE_OWN);
  if (beatExtras) out.beatExtras = beatExtras;
  if (noteExtras) out.noteExtras = noteExtras;
  // The chord's diagram, beside its name (the frets, where it starts, its barre).
  if (beat.chord) { const diagram = fileExtras(beat.chord, CHORD_OWN); if (diagram) out.chordDiagram = { ...diagram, name: beat.chord.name }; }
  // A tuplet other than the triplet the export writes by default (a 6:4, a 5:4).
  if (beat.tupletNumerator > 0) out.tuplet = [beat.tupletNumerator, beat.tupletDenominator];
  for (const [key, value, defaultValue] of [
    ["accentuated", note.accentuated, 0], ["bendType", note.bendType, 0],
    ["bendStyle", note.bendStyle, 0], ["harmonicType", note.harmonicType, 0],
    ["harmonicValue", note.harmonicValue, 0], ["slideInType", note.slideInType, 0],
    ["slideOutType", note.slideOutType, 0], ["vibrato", note.vibrato, 0],
    ["trillValue", note.trillValue, -1], ["trillSpeed", note.trillSpeed, 32],
    ["durationPercent", note.durationPercent, 1], ["leftHandFinger", note.leftHandFinger, -2],
    ["rightHandFinger", note.rightHandFinger, -2], ["ornament", note.ornament, 0],
    ["percussionArticulation", note.percussionArticulation, -1],
  ]) put(key, value, defaultValue);
  const bends = (note.bendPoints || []).map(compactPoint);
  if (bends.length) out.bendPoints = bends;
  for (const key of ["showStringNumber", "isDead", "isGhost", "isLetRing", "isPalmMute",
    "isStaccato", "isHammerPullOrigin", "isHammerPullDestination", "isLeftHandTapped",
    "isContinuedBend", "isEffectSlurOrigin"])
    if (note[key]) out[key] = true;
  if (note.isVisible === false) out.isVisible = false;
  if (note.effectSlurDestination) out.effectSlurDestinationId = note.effectSlurDestination.id;
  if (note.effectSlurOrigin) out.effectSlurOriginId = note.effectSlurOrigin.id;
  if (note.slideTarget) out.slideTargetId = note.slideTarget.id;
  return out;
}

// A tied note is one note in the editor, so what Guitar Pro writes on its tied
// parts belongs to it too: `chain` is every part, { note, beat, from, to } with
// from/to the part's place in the whole note (0..1). A slide-out sits on the last
// part, vibrato or a whammy may start on a later one.
function editorEffects(note, beat, chain = [{ note, beat, from: 0, to: 1 }]) {
  const out = {};
  const fx = {};
  // WHICH END OF THE HAMMER THIS IS, not just that there is one. Both roles used to
  // collapse to `true`, which loses the only thing that says which pairs are pairs:
  // in a run 5h7h9 the middle note is both, but a destination followed by the NEXT
  // group's origin are two adjacent flagged notes that are not a pair at all. The
  // voicer needs the difference, because a hammer-on runs along one string and a
  // gap between two groups does not (see effectRule in voicing-core.js).
  //
  // Still truthy, so every existing reader is unaffected: noteMarks, the fx toggle
  // in edit.js, the `!!fx.hammer` write-back in guitar-pro-edit.js and tab.py's
  // `if fx.get(key)` all see what they saw before. A hammer the USER turns on stays
  // plain `true` — the app has no way to author a role and should not invent one.
  const tail = chain.at(-1).note, origin = tail.isHammerPullOrigin;
  if (origin && note.isHammerPullDestination) fx.hammer = "both";
  else if (origin) fx.hammer = "origin";
  else if (note.isHammerPullDestination) fx.hammer = "dest";
  if (note.isPalmMute) fx.palmMute = true;
  if (note.isGhost) fx.ghost = true;
  if (note.isLetRing) fx.letRing = true;
  const vibrato = chain.find((part) => part.note.vibrato);
  if (vibrato) {
    fx.vibrato = true;
    if (vibrato.from > 1e-6) out.vibratoStart = vibrato.from;
    const end = chain.filter(part => part.note.vibrato).at(-1).to;
    if (end < 1 - 1e-6) out.vibratoEnd = end;
  }
  if (note.isStaccato) fx.staccato = true;
  if (note.accentuated) fx.accent = true;
  if (note.isDead) fx.dead = true;
  if (Object.keys(fx).length) out.fx = fx;
  const into = SLIDE_INTO[note.slideInType], on = chain.findLast((part) => SLIDE_ON[part.note.slideOutType]);
  if (on) {
    out.slide = SLIDE_ON[on.note.slideOutType];
    // In the part that slides (a later tied part, or the whole note), where the player starts it.
    out.slideStart = on.from + gpSlideAt(out.slide) * (on.to - on.from);
    if (into) out.slideIn = into;
  } else if (into) out.slide = into;
  // A bend runs over the parts it is written on and holds after (a bend on the first
  // part only bends during that part); later parts can hold or release it.
  const bent = chain.find((part) => part.note.hasBend && part.note.bendPoints?.length);
  const bendPoints = bent && chainCurve(chain, (part) => part.note.hasBend ? part.note.bendPoints : null);
  if (bendPoints) { out.bend = bendPreset(bent.note) || "custom"; out.bendPoints = bendPoints; }
  // The file's fretting finger is the note's typed finger (laid over the engine's own).
  if (note.fret > 0 && note.leftHandFinger >= 0 && note.leftHandFinger <= 4) out.finger = note.leftHandFinger;
  if (note.harmonicType === 1) out.harmonic = "natural";
  else if (note.harmonicType === 3) out.harmonic = "pinch";
  else if (note.harmonicType === 2) out.harmonic = "artificial";
  const decorated = chain.find((p) => p.note.ornament);
  if (decorated) out.ornament = { 1: "invertedTurn", 2: "turn", 3: "upperMordent", 4: "lowerMordent" }[decorated.note.ornament];
  if (note.trillValue >= 0) out.trill = note.trillValue - note.fret >= 2 ? "whole" : "half";
  const tremoloDuration = beat.tremoloPicking?.getDuration?.(beat.duration);
  if ([8, 16, 32].includes(tremoloDuration)) out.tremPick = String(tremoloDuration);
  if (beat.tap || chain.some((p) => p.note.isLeftHandTapped)) out.slap = "tap";
  else if (beat.slap) out.slap = "slap";
  else if (beat.pop) out.slap = "pop";
  if (chain.some((p) => p.beat.deadSlapped)) {
    out.slap = "slap";
    out.fx = { ...out.fx, dead: true };
  }
  // Strum directions stay in the Guitar Pro data, outside the editor's effects.
  const whammy = whammyPoints(chain);
  if (whammy) { out.whammy = whammyKind(whammy); out.whammyPoints = whammy; }
  return out;
}

// The whammy over the whole note, from every part's curve; null when there is none.
const whammyPoints = (chain) => chainCurve(chain, (part) => part.beat.whammyBarPoints);

// One curve over the whole note from each part's own points (offsets 0..60, values
// in quarter-tones), as [t, semitones]; null when it never leaves 0.
function chainCurve(chain, pointsOf) {
  const points = [[0, 0]];   // nothing before the first part that has points
  for (const part of chain) {
    const { from, to } = part;
    const own = (pointsOf(part) || []).map((p) =>
      [from + (Number(p.offset ?? p.position) || 0) / 60 * (to - from), (Number(p.value) || 0) / 2]);
    // A part's curve holds its first value from the part's start (a continued dive starts down).
    if (own.length && own[0][0] > from + 1e-6) own.unshift([from, own[0][1]]);
    points.push(...own);
  }
  if (points.every(([, v]) => Math.abs(v) < 1e-6)) return null;
  if (points.length > 1 && points[1][0] < 1e-6) points.shift();
  return points.filter((p, i) => !i || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
}

// What Guitar Pro marks on one tied part, which the editor marks once for the whole
// note: kept so the export writes each part as the file had it (guitar-pro-edit.js).
function partFlags(note) {
  const out = {};
  for (const [key, on] of [["letRing", note.isLetRing], ["palmMute", note.isPalmMute],
    ["dead", note.isDead], ["ghost", note.isGhost], ["staccato", note.isStaccato],
    ["bend", note.hasBend]]) if (on) out[key] = true;
  if (note.accentuated) out.accent = note.accentuated;   // how strong
  if (note.trillValue >= 0) { out.trillValue = note.trillValue; out.trillSpeed = note.trillSpeed; }
  // The part's own beat and note details (lyrics and dynamics on a tied beat, a finger).
  const beatExtras = fileExtras(note.beat, BEAT_OWN), noteExtras = fileExtras(note, NOTE_OWN);
  if (beatExtras) out.beatExtras = beatExtras;
  if (noteExtras) out.noteExtras = noteExtras;
  if (note.vibrato) out.vibrato = note.vibrato;   // its width (slight, wide)
  if (note.harmonicType) out.harmonicType = note.harmonicType;
  if (note.slideOutType) out.slideOutType = note.slideOutType;
  if (note.slideInType) out.slideInType = note.slideInType;
  return out;
}

function tiedEnd(note) {
  const segments = [], chain = [];
  let tail = note, endTick = note.beat.absolutePlaybackStart + note.beat.playbackDuration;
  const seen = new Set();
  while (tail && !seen.has(tail.id)) {
    seen.add(tail.id);
    chain.push(tail);
    segments.push({ noteId: tail.id, beatId: tail.beat.id, bar: tail.beat.voice.bar.index,
      voice: tail.beat.voice.index, startTick: tail.beat.absolutePlaybackStart,
      durationTicks: tail.beat.playbackDuration, ...partFlags(tail) });
    endTick = Math.max(endTick, tail.beat.absolutePlaybackStart + tail.beat.playbackDuration);
    tail = tail.isTieOrigin ? tail.tieDestination : null;
  }
  return { endTick, segments, chain };
}

export const GM_GUITARS = ["Nylon Guitar", "Steel Guitar", "Jazz Guitar", "Clean Guitar", "Muted Guitar",
  "Overdriven Guitar", "Distortion Guitar", "Guitar Harmonics", "Acoustic Bass", "Fingered Bass",
  "Picked Bass", "Fretless Bass", "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2"];
// A tone switch for each instrument change in the file. Its key names no preset of
// the sound library on purpose: the file cannot know which tones the user has, so the
// switch shows as "Tone preset missing" (marker-artifacts.js) until the user picks one.
function toneSwitches(track, staff, timeline) {
  const key = (program) => `guitar pro: ${GM_GUITARS[program - 24] || `program ${program}`}`;
  const changes = [];
  let current = track.playbackInfo?.program ?? 0;
  for (const bar of staff.bars || []) for (const beat of bar.voices?.[0]?.beats || [])
    for (const automation of beat.automations || []) {
      if (automation.type !== 2 /* AutomationType.Instrument */ || automation.value === current) continue;
      current = automation.value;
      changes.push({ t: tickToSeconds(beat.absolutePlaybackStart, timeline), program: current });
    }
  if (!changes.length) return [];   // one sound throughout: the app's start tone is as good a guess
  return [{ t: 0, program: track.playbackInfo?.program ?? 0 }, ...changes]
    .map(({ t, program }, i) => ({ id: `tone_gp_${i}`, t, tone: key(program), gpProgram: program }));
}

// As the file spells it (♯, ♭): Rocksmith gets # and b (rocksmith/chart.py _chord_name).
const chordNameOf = (beat) => beat.chord?.name || "";

function staffLane(track, staff, classification, timeline, laneNumber, beatRecords) {
  const tuning = [...(staff.stringTuning?.tunings || [])];
  const notes = [], scoreText = [];
  for (const bar of staff.bars || []) for (const voice of bar.voices || []) {
    if (voice.isEmpty) continue;
    for (const beat of voice.beats || []) {
      beatRecords.push(exactGpBeat(beat, track, staff, bar, voice));
      // Text, and a chord name over a rest: nothing in the editor to hang them on.
      const restLyrics = !beat.notes.length && beat.lyrics?.some((l) => l) ? beat.lyrics : null;
      if (beat.text || (chordNameOf(beat) && !beat.notes.length) || restLyrics)
        scoreText.push({ t: tickToSeconds(beat.absolutePlaybackStart, timeline), voice: voice.index,
          ...(beat.text ? { text: beat.text } : {}), ...(chordNameOf(beat) && !beat.notes.length ? { chord: chordNameOf(beat) } : {}),
          ...(restLyrics ? { lyrics: [...restLyrics] } : {}) });
      // The file's chord name, given to these tones (chord-names.js setChordName).
      const chordName = chordNameOf(beat);
      const chordNameFor = [...new Set(beat.notes.filter((n) => !n.isDead).map((n) => n.realValueWithoutHarmonic))]
        .sort((a, b) => a - b).join(",");
      for (const note of beat.notes || []) {
      if (note.isTieDestination) continue; // represented by the origin's exact tieSegments
      const startTick = beat.absolutePlaybackStart;
      const { endTick, segments, chain } = tiedEnd(note);
      const startSeconds = tickToSeconds(startTick, timeline), endSeconds = tickToSeconds(endTick, timeline);
      const at = (tick) => endSeconds > startSeconds ? (tickToSeconds(tick, timeline) - startSeconds) / (endSeconds - startSeconds) : 0;
      const parts = chain.map((part) => ({ note: part, beat: part.beat, from: at(part.beat.absolutePlaybackStart),
        to: at(part.beat.absolutePlaybackStart + part.beat.playbackDuration) }));
      const effects = editorEffects(note, beat, parts);
      // alphaTab numbers internal strings low-to-high (1 = lowest), while the
      // editor and GP5 adapter use 0 = highest. Do not use note.string - 1 here.
      const editorString = tuning.length - note.string;
      const basePitch = note.realValueWithoutHarmonic;
      notes.push({
        id: `gp_${track.index}_${staff.index}_${note.id}`,
        start: Math.max(0, tickToSeconds(startTick, timeline)),
        end: Math.max(0.001, tickToSeconds(endTick, timeline)),
        pitch: basePitch,
        soundingPitch: note.realValue,
        pos: { string: editorString, fret: note.fret, scope: "local", ...defaultPinFlags() },
        ...effects,
        ...(chordName ? { chordName, chordNameFor } : {}),
        gp: exactGpNote(note, beat, track, staff, bar, voice, startTick, endTick, segments, effects),
      });
    }
    }
  }
  notes.sort((a, b) => a.start - b.start || a.gp.voice - b.gp.voice || a.pitch - b.pitch);
  const rgba = track.color?.rgba;
  return {
    id: `gp_t${track.index}_s${staff.index}`,
    name: track.staves.length > 1 ? `${track.name} - Staff ${staff.index + 1}` : track.name,
    kind: "edit",
    color: /^#[0-9a-f]{6}$/i.test(rgba || "") ? rgba : ["#6ee7b7", "#fbbf72", "#a5b4fc", "#f9a8d4", "#67e8f9", "#fca5a5"][laneNumber % 6],
    visible: true,
    active: laneNumber === 0,
    locked: false,
    ...instrumentFor(track.playbackInfo?.program, classification.family),
    gmProgram: track.playbackInfo?.program ?? 0,
    capo: staff.capo || 0,
    transpositionPitch: staff.transpositionPitch || 0,
    displayTranspositionPitch: staff.displayTranspositionPitch || 0,
    tuning: "custom",
    customTuning: tuning.map(noteName).join(" "),
    volume: 1,
    muted: false,
    tablatureEnabled: true,
    toneMarkers: toneSwitches(track, staff, timeline),
    // The track's own settings (its short name, mixer, how the staff is shown), for an
    // export that writes the layer from its notes.
    gpTrack: { track: fileExtras(track, TRACK_OWN), playback: fileExtras(track.playbackInfo, PLAYBACK_OWN), staff: fileExtras(staff, STAFF_OWN) },
    ...(scoreText.length ? { scoreText } : {}),
    sourceTrackIndex: track.index,
    sourceStaffIndex: staff.index,
    notes,
  };
}

function compactMasterBars(score, timeline) {
  return (score.masterBars || []).map((bar) => ({
    index: bar.index,
    startTick: bar.start,
    durationTicks: masterBarDuration(bar),
    timeSignatureNumerator: bar.timeSignatureNumerator,
    timeSignatureDenominator: bar.timeSignatureDenominator,
    keySignature: bar.keySignature,
    keySignatureType: bar.keySignatureType,
    isDoubleBar: !!bar.isDoubleBar,
    isRepeatStart: !!bar.isRepeatStart,
    repeatCount: bar.repeatCount,
    alternateEndings: bar.alternateEndings,
    isAnacrusis: !!bar.isAnacrusis,
    isFreeTime: !!bar.isFreeTime,
    tripletFeel: bar.tripletFeel,
    section: bar.section ? { marker: bar.section.marker || "", text: bar.section.text || "" } : null,
    tempoAutomations: (bar.tempoAutomations || []).map((a) => ({
      ratioPosition: a.ratioPosition, value: a.value, isLinear: !!a.isLinear,
    })),
    seconds: tickToSeconds(bar.start || 0, timeline),
  }));
}

export function convertGpScore(score, selectedTrackIndexes, alphaTabVersion = "") {
  const selected = new Set(selectedTrackIndexes.map(Number));
  const timeline = tempoTimeline(score);
  const lanes = [];
  const beatRecords = [];
  const selectedTracks = [];
  for (const track of score.tracks || []) {
    if (!selected.has(track.index)) continue;
    const classification = classifyGpTrack(track);
    if (!classification.supported) continue;
    selectedTracks.push({
      index: track.index,
      name: track.name,
      shortName: track.shortName || "",
      color: track.color?.rgba || null,
      program: track.playbackInfo?.program,
      volume: track.playbackInfo?.volume,
      balance: track.playbackInfo?.balance,
      family: classification.family,
      staves: track.staves.map((staff) => ({
        index: staff.index,
        tuning: [...(staff.stringTuning?.tunings || [])],
        tuningName: staff.stringTuning?.name || "",
        capo: staff.capo || 0,
        transpositionPitch: staff.transpositionPitch || 0,
        displayTranspositionPitch: staff.displayTranspositionPitch || 0,
      })),
    });
    for (const staff of track.staves || []) {
      if (!(staff.stringTuning?.tunings || []).length) continue;
      lanes.push(staffLane(track, staff, classification, timeline, lanes.length, beatRecords));
    }
  }
  if (!lanes.length) throw new Error("Select at least one supported guitar or bass track");
  const masterBars = compactMasterBars(score, timeline);
  const last = masterBars[masterBars.length - 1];
  const duration = last ? tickToSeconds(last.startTick + last.durationTicks, timeline)
    : Math.max(0, ...lanes.flatMap((l) => l.notes.map((n) => n.end)));
  const firstBar = score.masterBars?.[0];
  const tempoMap = [];
  let previousMeter = `${firstBar?.timeSignatureNumerator || 4}/${firstBar?.timeSignatureDenominator || 4}`;
  for (const bar of masterBars) {
    const meter = `${bar.timeSignatureNumerator || 4}/${bar.timeSignatureDenominator || 4}`;
    for (const tempo of bar.tempoAutomations) {
      const t = tickToSeconds(bar.startTick + bar.durationTicks * (tempo.ratioPosition || 0), timeline);
      if (t > 1e-6) tempoMap.push({ t, bpm: tempo.value,
        tsNum: bar.timeSignatureNumerator || 4, tsDen: bar.timeSignatureDenominator || 4, subdiv: 4 });
    }
    if (bar.index && meter !== previousMeter && !bar.tempoAutomations.length) {
      const activeTempo = [...timeline].reverse().find((p) => p.tick <= bar.startTick)?.bpm || score.tempo || 120;
      tempoMap.push({ t: bar.seconds, bpm: activeTempo,
        tsNum: bar.timeSignatureNumerator || 4, tsDen: bar.timeSignatureDenominator || 4, subdiv: 4 });
    }
    previousMeter = meter;
  }
  tempoMap.sort((a, b) => a.t - b.t);
  const guitarPro = {
    schemaVersion: GP_SCHEMA_VERSION,
    alphaTabVersion,
    selectedTrackIndexes: [...selected].sort((a, b) => a - b),
    selectedTracks,
    score: {
      title: score.title || "", subTitle: score.subTitle || "",
      artist: score.artist || "", album: score.album || "",
      words: score.words || "", music: score.music || "", tab: score.tab || "",
      notices: score.notices || "",
      copyright: score.copyright || "", instructions: score.instructions || "",
      tempo: score.tempo, durationSeconds: duration, masterBars, beats: beatRecords,
    },
  };
  return {
    name: score.title || "Imported Guitar Pro",
    duration,
    metadata: { title: score.title || "", artist: score.artist || "", album: score.album || "", year: null },
    grid: {
      bpm: timeline[0]?.bpm || score.tempo || 120, offset: 0, subdiv: 8,
      tsNum: firstBar?.timeSignatureNumerator || 4,
      tsDen: firstBar?.timeSignatureDenominator || 4,
      snap: true, showGrid: true, tempoMap,
    },
    editLanes: lanes,
    guitarPro,
  };
}
