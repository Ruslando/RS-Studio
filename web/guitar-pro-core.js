// Pure Guitar Pro -> editor conversion helpers. The alphaTab runtime is passed
// in by callers so this module stays DOM-free and can be regression-tested in
// Node with the same vendored bundle used by the browser.

import { effectSignatureFields } from "./note-effects.js";

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

// Lightweight integrity marker for deciding whether the original alphaTab score
// still represents the imported lanes. It is not a security hash; it catches
// normal edits/additions/deletions so modern export never silently ignores them.
export function gpProjectionSignature(lanes) {
  const projection = lanes
    .filter((lane) => lane.sourceTrackIndex != null)
    .map((lane) => ({
      sourceTrackIndex: lane.sourceTrackIndex,
      sourceStaffIndex: lane.sourceStaffIndex,
      name: lane.name,
      gmProgram: lane.gmProgram,
      tuning: lane.tuning,
      customTuning: lane.customTuning,
      capo: lane.capo || 0,
      notes: lane.notes.map((note) => ({
        sourceNoteId: note.gp?.noteId ?? null,
        start: note.start, end: note.end, pitch: note.pitch,
        soundingPitch: note.soundingPitch ?? null,
        string: note.pos?.string ?? null, fret: note.pos?.fret ?? null,
        ...effectSignatureFields(note),
      })),
    }));
  return projectionHash(projection);
}

// Fields we cannot yet apply safely to an existing alphaTab hierarchy. String,
// fret, pitch, lane name/program, tuning and capo are deliberately excluded so
// those non-structural edits can use modern export.
export function gpStructuralSignature(lanes) {
  return projectionHash(lanes
    .filter((lane) => lane.sourceTrackIndex != null)
    .map((lane) => ({
      sourceTrackIndex: lane.sourceTrackIndex,
      sourceStaffIndex: lane.sourceStaffIndex,
      notes: lane.notes.map((note) => ({
        sourceNoteId: note.gp?.noteId ?? null,
        start: note.start, end: note.end,
        ...effectSignatureFields(note),
      })),
    })));
}

// Cache identity for the app-authored score preview. Unlike the import
// integrity marker above, this intentionally covers created lanes and the
// explicit tablature role so toggling a reference layer invalidates the score
// without treating the toggle as an edit to the untouched GP source.
export function scoreProjectionSignature(lanes) {
  return projectionHash((lanes || []).map((lane) => ({
    id: lane.id,
    tablatureEnabled: lane.tablatureEnabled !== false,
    sourceTrackIndex: lane.sourceTrackIndex ?? null,
    sourceStaffIndex: lane.sourceStaffIndex ?? null,
    name: lane.name,
    instrument: lane.instrument,
    tone: lane.tone,
    gmProgram: lane.gmProgram ?? null,
    tuning: lane.tuning,
    customTuning: lane.customTuning,
    fingeringMode: lane.fingeringMode,
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

// A GP track states one General-MIDI program, which is a *sound*, and the family
// classifier tells a bass part from a guitar one. Between them they name both of
// the lane's fields — and the pair is where the split actually shows: an overdrive
// program used to import as a whole separate instrument.
function instrumentFor(program, family) {
  if (family === "bass") return { instrument: "bass", tone: "bass" };
  if (program === 24 || program === 25) return { instrument: "acoustic", tone: "acoustic" };
  if (program >= 29 && program <= 31) return { instrument: "electric", tone: "distortion" };
  return { instrument: "electric", tone: "electric" };
}

function slideKind(note) {
  if (note.slideInType === 1) return "inBelow";
  if (note.slideInType === 2) return "inAbove";
  if (note.slideOutType === 1) return "shift";
  if (note.slideOutType === 2) return "legato";
  if (note.slideOutType === 3) return "outUp";
  if (note.slideOutType === 4) return "outDown";
  return null;
}

function bendPreset(note) {
  if (!note.hasBend || !note.bendPoints?.length) return null;
  const peak = Math.max(...note.bendPoints.map((p) => Number(p.value) || 0));
  if (note.bendType === 4 || note.bendType === 8) return "release";
  if (note.bendType === 6 || note.bendType === 7) return "prebend";
  if (peak >= 6) return "onehalf";
  return peak <= 2 ? "half" : "full";
}

// The imported curve, verbatim: alphaTab offsets 0..60 and quarter-tone values ->
// the editor's [t, semitones]. The preset above is only a label; carrying the
// real points is what lets a source file's hand-drawn bend survive a round trip
// (and show up draggable on the spectrogram) instead of snapping to a preset.
function bendCurvePoints(note) {
  if (!note.hasBend || !note.bendPoints?.length) return null;
  const pts = [];
  for (const p of note.bendPoints) {
    const point = [(Number(p.offset ?? p.position) || 0) / 60, (Number(p.value) || 0) / 2];
    const last = pts[pts.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) pts.push(point);
  }
  return pts.length >= 2 ? pts : null;
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

function exactGpNote(note, beat, track, staff, bar, voice, startTick, endTick, tieSegments) {
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
    editorEffects: editorEffects(note, beat),
  };
  const put = (key, value, defaultValue) => {
    if (value !== undefined && value !== null && !Object.is(value, defaultValue)) out[key] = value;
  };
  if (tieSegments.length > 1) out.tieSegments = tieSegments;
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

function editorEffects(note, beat) {
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
  if (note.isHammerPullOrigin && note.isHammerPullDestination) fx.hammer = "both";
  else if (note.isHammerPullOrigin) fx.hammer = "origin";
  else if (note.isHammerPullDestination) fx.hammer = "dest";
  if (note.isPalmMute) fx.palmMute = true;
  if (note.isGhost) fx.ghost = true;
  if (note.isLetRing) fx.letRing = true;
  if (note.vibrato) fx.vibrato = true;
  if (note.isStaccato) fx.staccato = true;
  if (note.accentuated) fx.accent = true;
  if (note.isDead) fx.dead = true;
  if (Object.keys(fx).length) out.fx = fx;
  const slide = slideKind(note); if (slide) out.slide = slide;
  const bend = bendPreset(note);
  if (bend) { out.bend = bend; const pts = bendCurvePoints(note); if (pts) out.bendPoints = pts; }
  if (note.harmonicType === 1) out.harmonic = "natural";
  else if (note.harmonicType === 3) out.harmonic = "pinch";
  if (note.trillValue >= 0) out.trill = note.trillValue - note.fret >= 2 ? "whole" : "half";
  const tremoloDuration = beat.tremoloPicking?.getDuration?.(beat.duration);
  if ([8, 16, 32].includes(tremoloDuration)) out.tremPick = String(tremoloDuration);
  if (beat.tap) out.slap = "tap";
  else if (beat.slap) out.slap = "slap";
  else if (beat.pop) out.slap = "pop";
  if (beat.pickStroke === 1) out.stroke = "up";
  else if (beat.pickStroke === 2) out.stroke = "down";
  if (beat.whammyBarType === 3) out.whammy = "dip";
  else if (beat.whammyBarType === 2) out.whammy = "dive";
  return out;
}

function tiedEnd(note) {
  const segments = [];
  let tail = note, endTick = note.beat.absolutePlaybackStart + note.beat.playbackDuration;
  const seen = new Set();
  while (tail && !seen.has(tail.id)) {
    seen.add(tail.id);
    segments.push({ noteId: tail.id, beatId: tail.beat.id, bar: tail.beat.voice.bar.index,
      voice: tail.beat.voice.index, startTick: tail.beat.absolutePlaybackStart,
      durationTicks: tail.beat.playbackDuration });
    endTick = Math.max(endTick, tail.beat.absolutePlaybackStart + tail.beat.playbackDuration);
    tail = tail.isTieOrigin ? tail.tieDestination : null;
  }
  return { endTick, segments };
}

function staffLane(track, staff, classification, timeline, laneNumber, beatRecords) {
  const tuning = [...(staff.stringTuning?.tunings || [])];
  const notes = [];
  for (const bar of staff.bars || []) for (const voice of bar.voices || []) {
    if (voice.isEmpty) continue;
    for (const beat of voice.beats || []) {
      beatRecords.push(exactGpBeat(beat, track, staff, bar, voice));
      for (const note of beat.notes || []) {
      if (note.isTieDestination) continue; // represented by the origin's exact tieSegments
      const startTick = beat.absolutePlaybackStart;
      const { endTick, segments } = tiedEnd(note);
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
        pos: { string: editorString, fret: note.fret, scope: "local" },
        ...editorEffects(note, beat),
        gp: exactGpNote(note, beat, track, staff, bar, voice, startTick, endTick, segments),
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
    fingeringMode: "exact",
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
  guitarPro.projectionSignature = gpProjectionSignature(lanes);
  guitarPro.structuralSignature = gpStructuralSignature(lanes);
  return {
    name: score.title || "Imported Guitar Pro",
    duration,
    metadata: { title: score.title || "", artist: score.artist || "", album: score.album || "", year: null },
    grid: {
      bpm: timeline[0]?.bpm || score.tempo || 120, offset: 0, subdiv: 4,
      tsNum: firstBar?.timeSignatureNumerator || 4,
      tsDen: firstBar?.timeSignatureDenominator || 4,
      snap: true, showGrid: true, tempoMap,
    },
    editLanes: lanes,
    guitarPro,
  };
}
