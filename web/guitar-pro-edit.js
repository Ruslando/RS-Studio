// Source-preserving editor projection -> alphaTab score adapter.
//
// The imported alphaTab score remains authoritative for every construct the
// editor does not touch.  Simple changes are patched onto those source objects.
// Only voices containing added/deleted/moved/resized notes are rebuilt, and
// even there original beats/notes are reused whenever their rhythmic slot still
// exists.  This keeps custom GP data out of the lossy flat-note conversion path.

import { bendCurve, bendPeak, bendShape } from "./bend.js";
import { MAX_RHYTHM_PIECES, MAX_TIE_CHAIN } from "./constants.js";
import { parseTuning } from "./util.js";
import { arrangedNotes, representPickedOpenSlides, voiceNotes } from "./voicing-core.js";

const QUARTER_TICKS = 960;
const TICK_QUANTUM = 15; // a 1/256 note; finer than the editor's normal grid
const MAX_VOICES = 4;

function same(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
function effectsOf(note) {
  const out = {};
  for (const key of ["slide", "bend", "bendPoints", "harmonic", "grace", "trill", "tremPick", "slap", "stroke", "whammy"])
    if (note[key] != null) out[key] = note[key];
  if (note.fx && Object.keys(note.fx).length) out.fx = { ...note.fx };
  return out;
}

function tuningFromImportedLane(lane) {
  const tuning = parseTuning(lane.customTuning);
  if (!tuning) throw new Error(`Modern export cannot parse the tuning on “${lane.name}”.`);
  return tuning;
}

const BUILTIN_TUNINGS = {
  bass4: [43, 38, 33, 28], bass5: [43, 38, 33, 28, 23],
  guitar6: [64, 59, 55, 50, 45, 40], guitar7: [64, 59, 55, 50, 45, 40, 35],
  ds_standard: [63, 58, 54, 49, 44, 39], d_standard: [62, 57, 53, 48, 43, 38],
  cs_standard: [61, 56, 52, 47, 42, 37], c_standard: [60, 55, 51, 46, 41, 36],
  drop_d: [64, 59, 55, 50, 45, 38], drop_cs: [63, 58, 54, 49, 44, 37],
  drop_c: [62, 57, 53, 48, 43, 36], drop_b: [61, 56, 52, 47, 42, 35],
  drop_as: [60, 55, 51, 46, 41, 34],
};

function tuningFromLane(lane) {
  if (BUILTIN_TUNINGS[lane.tuning]) return [...BUILTIN_TUNINGS[lane.tuning]];
  if ((lane.customTuning || "").trim()) return tuningFromImportedLane(lane);
  return [...(String(lane.instrument || "").includes("bass") ? BUILTIN_TUNINGS.bass4 : BUILTIN_TUNINGS.guitar6)];
}

export function validateImportedProjection(lanes) {
  for (const lane of lanes) {
    const tuning = tuningFromImportedLane(lane);
    const transposition = Number(lane.transpositionPitch) || 0;
    const ids = new Set();
    for (const note of lane.notes) {
      const sourceId = note.gp?.noteId;
      if (Number.isFinite(sourceId)) {
        if (ids.has(sourceId)) throw new Error(`Modern export found a duplicate source note on “${lane.name}”.`);
        ids.add(sourceId);
      }
      const position = resolvedPosition(note, tuning, transposition);
      if (!position) throw new Error(`A pitch on “${lane.name}” is below every open string in its tuning.`);
      if (note.pos && (position.string !== Number(note.pos.string) || position.fret !== Number(note.pos.fret)))
        throw new Error(`A pitch on “${lane.name}” no longer matches its stored string and fret.`);
      if (!Number.isFinite(note.start) || !Number.isFinite(note.end) || note.end <= note.start)
        throw new Error(`Modern export found an invalid note duration on “${lane.name}”.`);
    }
  }
}

function resolvedPosition(note, tuning, transposition = 0) {
  const string = Number(note.pos?.string), fret = Number(note.pos?.fret), pitch = Number(note.pitch);
  if (Number.isInteger(string) && string >= 0 && string < tuning.length && Number.isFinite(fret) && fret >= 0
      && Math.abs(tuning[string] + fret - transposition - pitch) < 1e-6) return { string, fret: Math.round(fret) };
  if (note.pos) return null; // explicit but stale positions must never be silently changed
  let best = null;
  for (let index = 0; index < tuning.length; index++) {
    const candidate = Math.round(pitch + transposition - tuning[index]);
    if (candidate >= 0 && (!best || candidate < best.fret)) best = { string: index, fret: candidate };
  }
  return best;
}

function masterBarDuration(bar) {
  return typeof bar.calculateDuration === "function" ? bar.calculateDuration()
    : Math.round((bar.timeSignatureNumerator || 4) * 4 / (bar.timeSignatureDenominator || 4) * QUARTER_TICKS);
}

function timeline(score) {
  const points = [];
  let fallback = 0;
  for (const bar of score.masterBars || []) {
    const start = Number.isFinite(bar.start) ? bar.start : fallback;
    const duration = masterBarDuration(bar);
    for (const automation of [...(bar.tempoAutomations || [])].sort((a, b) => a.ratioPosition - b.ratioPosition))
      points.push({ tick: start + duration * (automation.ratioPosition || 0), bpm: Math.max(1, Number(automation.value) || score.tempo || 120) });
    fallback = start + duration;
  }
  if (!points.length || points[0].tick > 0) points.unshift({ tick: 0, bpm: Math.max(1, Number(score.tempo) || 120) });
  points.sort((a, b) => a.tick - b.tick);
  const compact = [];
  for (const point of points) {
    const previous = compact[compact.length - 1];
    if (previous && Math.abs(previous.tick - point.tick) < 1e-6) previous.bpm = point.bpm;
    else compact.push(point);
  }
  let seconds = 0;
  for (let i = 0; i < compact.length; i++) {
    if (i) seconds += (compact[i].tick - compact[i - 1].tick) / QUARTER_TICKS * 60 / compact[i - 1].bpm;
    compact[i].seconds = seconds;
  }
  return compact;
}

function secondsToTick(seconds, points) {
  let point = points[0];
  for (let i = 1; i < points.length && points[i].seconds <= seconds + 1e-9; i++) point = points[i];
  return point.tick + (seconds - point.seconds) * QUARTER_TICKS * point.bpm / 60;
}

function quantizeTick(value) { return Math.max(0, Math.round(value / TICK_QUANTUM) * TICK_QUANTUM); }

function barBounds(score) {
  return score.masterBars.map((bar, index) => ({ index, start: bar.start, end: bar.start + masterBarDuration(bar) }));
}

function barsOverlapping(bounds, start, end) {
  return bounds.filter((bar) => start < bar.end && end > bar.start).map((bar) => bar.index);
}

function durationFigures() {
  const out = [];
  for (const duration of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
    const base = 4 * QUARTER_TICKS / duration;
    for (const dots of [2, 1, 0]) {
      const factor = dots === 2 ? 1.75 : dots === 1 ? 1.5 : 1;
      const ticks = base * factor;
      if (Number.isInteger(ticks) && ticks >= TICK_QUANTUM) out.push({ ticks, duration, dots });
    }
  }
  return out.sort((a, b) => b.ticks - a.ticks || a.duration - b.duration);
}
const FIGURES = durationFigures();

function decompose(ticks) {
  const result = [];
  let remaining = Math.max(TICK_QUANTUM, quantizeTick(ticks));
  while (remaining > 0) {
    const figure = FIGURES.find((candidate) => candidate.ticks <= remaining) || FIGURES[FIGURES.length - 1];
    result.push(figure);
    remaining -= figure.ticks;
    if (result.length > MAX_RHYTHM_PIECES) throw new Error("Modern export could not represent an edited rhythm.");
  }
  return result;
}

function sourceNotes(staff) {
  const byId = new Map(), origins = [];
  for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) {
    byId.set(note.id, note);
    if (!note.isTieDestination) origins.push(note);
  }
  return { byId, origins };
}

function resetRelationships(note) {
  for (const key of ["bendOrigin", "hammerPullOrigin", "hammerPullDestination", "slurOrigin", "slurDestination",
    "slideTarget", "slideOrigin", "tieOrigin", "tieDestination", "effectSlurOrigin", "effectSlurDestination"])
    note[key] = null;
  note.isTieDestination = false;
}

// Copy every field alphaTab's model exposes EXCEPT the ones it owns itself.
// Two kinds are skipped, and that is the whole criterion:
//   1. identity and graph links (id, index, beat, tie/slur/slide partners) —
//      copying them points the clone at the original's neighbours;
//   2. anything score.finish() recomputes (bend points are rebuilt through
//      addBendPoint below so the derived maxBendPoint comes out consistent).
// A new alphaTab version adding a field of either kind means adding it here;
// everything else copies correctly by default, which is why this is a skip list
// and not an allow list.
function copyNote(alphaTab, source) {
  const note = new alphaTab.model.Note();
  if (!source) return note;
  const skip = new Set(["id", "index", "beat", "bendOrigin", "hammerPullOrigin", "hammerPullDestination", "slurOrigin",
    "slurDestination", "slideTarget", "slideOrigin", "tieOrigin", "tieDestination", "effectSlurOrigin", "effectSlurDestination",
    "bendPoints", "maxBendPoint"]);
  for (const key of Object.keys(source)) if (!skip.has(key)) note[key] = source[key];
  if (source.bendPoints?.length) for (const point of source.bendPoints)
    note.addBendPoint(new alphaTab.model.BendPoint(point.offset, point.value));
  return note;
}

// Same criterion as copyNote, plus a third: everything describing the beat's
// RHYTHM (duration, dots, tuplets, display/playback timing) is skipped, because
// the caller is re-deriving it. This copies what a beat *means* — its effects,
// text, dynamics — onto a beat whose timing is being rebuilt.
function copyBeatSemantics(alphaTab, source) {
  const beat = new alphaTab.model.Beat();
  if (!source) return beat;
  const skip = new Set(["id", "index", "voice", "notes", "noteStringLookup", "noteValueLookup", "previousBeat", "nextBeat",
    "duration", "dots", "tupletNumerator", "tupletDenominator", "tupletGroup", "displayStart", "playbackStart",
    "displayDuration", "playbackDuration", "graceGroup", "graceIndex", "whammyBarPoints", "maxWhammyPoint", "minWhammyPoint"]);
  for (const key of Object.keys(source)) {
    if (skip.has(key)) continue;
    const value = source[key];
    if (value == null || typeof value !== "object") beat[key] = value;
    else if (Array.isArray(value)) beat[key] = [...value];
    else beat[key] = value;
  }
  if (source.whammyBarPoints?.length) for (const point of source.whammyBarPoints)
    beat.addWhammyBarPoint(new alphaTab.model.BendPoint(point.offset, point.value));
  return beat;
}

// alphaTab offsets run 0..60 and values are quarter-tones, same as the .gp5 file.
// A hand-edited curve is fed through verbatim as BendType.Custom — the shape
// presets only tell alphaTab which glyph to draw, and none of them describes an
// arbitrary curve.
function setBend(alphaTab, note, editorNote) {
  note.bendPoints = null; note.maxBendPoint = null; note.bendType = alphaTab.model.BendType.None;
  const pts = bendCurve(editorNote);
  if (!pts) return;
  const SHAPES = { bend: alphaTab.model.BendType.Bend, bendRelease: alphaTab.model.BendType.BendRelease,
    bendReleaseBend: alphaTab.model.BendType.Custom, prebend: alphaTab.model.BendType.Prebend,
    prebendRelease: alphaTab.model.BendType.PrebendRelease };
  const shape = editorNote.bendPoints?.length ? "custom" : bendShape(pts);
  note.bendType = SHAPES[shape] ?? alphaTab.model.BendType.Custom;
  const peak = Math.round(bendPeak(pts) * 2);
  const points =
    // A plain rise is encoded by alphaTab as one continuous line. Feeding it the
    // preset's redundant midpoint looks harmless in memory but is normalized away
    // by Score.finish/export, and made strict round-trip checks disagree.
    shape === "bend" ? [[0, 0], [60, peak]]
      // alphaTab's canonical BendRelease shape has two identical middle points:
      // its renderer reads point 3 as the released value when bendType is already
      // explicit, so the plain three-point curve is valid GP input but not a
      // valid constructed alphaTab BendRelease model.
      : shape === "bendRelease" ? [[0, 0], [30, peak], [30, peak], [60, Math.round(pts[pts.length - 1][1] * 2)]]
        : shape === "prebend" ? [[0, peak], [60, peak]]
          : pts.map(([t, v]) => [Math.round(t * 60), Math.round(v * 2)]);
  for (const [offset, value] of points) note.addBendPoint(new alphaTab.model.BendPoint(offset, value));
}

function setWhammy(alphaTab, beat, preset) {
  beat.whammyBarPoints = null; beat.maxWhammyPoint = null; beat.minWhammyPoint = null;
  beat.whammyBarType = alphaTab.model.WhammyType.None;
  const points = preset === "dip" ? [[0, 0], [30, -4], [60, 0]]
    : preset === "dive" ? [[0, 0], [60, -4]] : null;
  if (!points) return;
  beat.whammyBarType = preset === "dip" ? alphaTab.model.WhammyType.Dip : alphaTab.model.WhammyType.Dive;
  for (const [offset, value] of points) beat.addWhammyBarPoint(new alphaTab.model.BendPoint(offset, value));
}

function setTremoloPicking(alphaTab, beat, preset) {
  beat.tremoloPicking = undefined;
  const targetDuration = Number(preset);
  if (![8, 16, 32].includes(targetDuration)) return;
  const baseDuration = Math.max(1, Math.abs(Number(beat.duration) || 4));
  const effect = new alphaTab.model.TremoloPickingEffect();
  effect.marks = Math.max(1, Math.min(5, Math.round(Math.log2(targetDuration / baseDuration))));
  beat.tremoloPicking = effect;
}

function applyEditorEffects(alphaTab, sourceProjection, targetNote, targetBeat, force = false, writeBend = true) {
  if (!force && !sourceProjection.gp?.editorEffects) return;
  const current = effectsOf(sourceProjection), original = sourceProjection.gp?.editorEffects || {};
  const changed = (key) => force || !same(current[key], original[key]);
  const fx = current.fx || {}, oldFx = original.fx || {};
  const flag = (key, property, on = true, off = false) => {
    if (force || !!fx[key] !== !!oldFx[key]) targetNote[property] = fx[key] ? on : off;
  };
  flag("palmMute", "isPalmMute"); flag("ghost", "isGhost"); flag("letRing", "isLetRing");
  flag("vibrato", "vibrato", alphaTab.model.VibratoType.Slight, alphaTab.model.VibratoType.None);
  flag("staccato", "isStaccato"); flag("dead", "isDead");
  flag("accent", "accentuated", alphaTab.model.AccentuationType.Normal, alphaTab.model.AccentuationType.None);
  if (force || !!fx.hammer !== !!oldFx.hammer) {
    if (!fx.hammer && targetNote.isHammerPullDestination && targetNote.hammerPullOrigin)
      targetNote.hammerPullOrigin.isHammerPullOrigin = false;
    else targetNote.isHammerPullOrigin = !!fx.hammer;
  }
  if (changed("slide")) {
    targetNote.slideInType = alphaTab.model.SlideInType.None; targetNote.slideOutType = alphaTab.model.SlideOutType.None;
    const slide = current.slide;
    if (slide === "inBelow") targetNote.slideInType = alphaTab.model.SlideInType.IntoFromBelow;
    else if (slide === "inAbove") targetNote.slideInType = alphaTab.model.SlideInType.IntoFromAbove;
    else if (slide === "shift") targetNote.slideOutType = alphaTab.model.SlideOutType.Shift;
    else if (slide === "legato") targetNote.slideOutType = alphaTab.model.SlideOutType.Legato;
    else if (slide === "outUp") targetNote.slideOutType = alphaTab.model.SlideOutType.OutUp;
    else if (slide === "outDown") targetNote.slideOutType = alphaTab.model.SlideOutType.OutDown;
  }
  // A long editor note may be represented as tied score segments. Its bend is
  // one continuous gesture across that tie chain, not a new bend on every
  // written segment. AlphaTab extends the origin's bend across tie-only
  // continuations; writing the whole curve on each continuation restarts it
  // and produces repeated bend symbols.
  if (changed("bend") || changed("bendPoints"))
    setBend(alphaTab, targetNote, writeBend ? current : null);
  if (changed("harmonic")) targetNote.harmonicType = current.harmonic === "natural" ? alphaTab.model.HarmonicType.Natural
    : current.harmonic === "pinch" ? alphaTab.model.HarmonicType.Pinch : alphaTab.model.HarmonicType.None;
  if (changed("trill")) {
    targetNote.trillValue = current.trill ? targetNote.fret + (current.trill === "whole" ? 2 : 1) : -1;
    targetNote.trillSpeed = alphaTab.model.Duration.Sixteenth;
  }
  if (changed("tremPick")) setTremoloPicking(alphaTab, targetBeat, current.tremPick);
  if (changed("slap")) {
    targetBeat.tap = current.slap === "tap"; targetBeat.slap = current.slap === "slap"; targetBeat.pop = current.slap === "pop";
  }
  if (changed("stroke")) targetBeat.pickStroke = current.stroke === "up" ? alphaTab.model.PickStroke.Up
    : current.stroke === "down" ? alphaTab.model.PickStroke.Down : alphaTab.model.PickStroke.None;
  if (changed("whammy")) setWhammy(alphaTab, targetBeat, current.whammy);
}

function addGraceBeat(alphaTab, voice, projected, tuning) {
  const beat = new alphaTab.model.Beat();
  beat.duration = alphaTab.model.Duration.ThirtySecond; beat.graceType = alphaTab.model.GraceType.BeforeBeat;
  const note = new alphaTab.model.Note();
  note.string = tuning.length - projected.pos.string;
  note.fret = Math.max(0, Math.round(projected.pos.fret) - (projected.grace === "whole" ? 2 : 1));
  note.isHammerPullOrigin = true;
  beat.addNote(note); voice.addBeat(beat);
}

function chooseVoices(notes) {
  const assigned = new Map(), occupied = Array.from({ length: MAX_VOICES }, () => []);
  const ordered = [...notes].sort((a, b) => a.startTick - b.startTick || a.endTick - b.endTick);
  // Source-authored voice choices are canonical, including deliberate overlap
  // and let-ring situations that look conflicting in the flattened editor.
  for (const item of ordered.filter((candidate) => Number.isInteger(candidate.projected.gp?.voice))) {
    const voice = Math.max(0, Math.min(MAX_VOICES - 1, item.projected.gp.voice));
    item.voice = voice; assigned.set(item.projected, voice); occupied[voice].push(item);
  }
  // Only genuinely new editor notes need automatic voice placement.
  for (const item of ordered.filter((candidate) => !Number.isInteger(candidate.projected.gp?.voice))) {
    // Lowest free voice wins. This used to prepend a `preferred` that was a
    // literal 0 and then dedupe the duplicate it had just created.
    const order = [0, 1, 2, 3].filter((value) => value < MAX_VOICES);
    const voice = order.find((candidate) => !occupied[candidate].some((other) =>
      other.string === item.string && other.startTick < item.endTick && item.startTick < other.endTick));
    if (voice == null) throw new Error("Modern export needs more than four voices to represent overlapping notes on one string.");
    item.voice = voice; assigned.set(item.projected, voice); occupied[voice].push(item);
  }
  return assigned;
}

function ensureVoice(alphaTab, bar, index) {
  while (bar.voices.length <= index) bar.addVoice(new alphaTab.model.Voice());
  return bar.voices[index];
}

function rebuildVoice(alphaTab, staff, barIndex, voiceIndex, items, tuning, sourceById) {
  const bar = staff.bars[barIndex], voice = ensureVoice(alphaTab, bar, voiceIndex), master = bar.masterBar;
  const barStart = master.start, barEnd = barStart + masterBarDuration(master);
  const oldBeats = [...voice.beats];
  const reusable = new Map();
  for (const beat of oldBeats) {
    const key = `${beat.absolutePlaybackStart}:${beat.playbackDuration}`;
    if (!reusable.has(key)) reusable.set(key, []);
    reusable.get(key).push(beat);
  }
  const boundaries = new Set([barStart, barEnd]);
  for (const item of items) {
    boundaries.add(Math.max(barStart, item.startTick)); boundaries.add(Math.min(barEnd, item.endTick));
  }
  const ordered = [...boundaries].filter((tick) => tick >= barStart && tick <= barEnd).sort((a, b) => a - b);
  voice.beats = [];
  for (let boundaryIndex = 0; boundaryIndex < ordered.length - 1; boundaryIndex++) {
    let cursor = ordered[boundaryIndex], end = ordered[boundaryIndex + 1];
    const active = items.filter((item) => item.startTick <= cursor && item.endTick > cursor);
    for (const figure of decompose(end - cursor)) {
      const onset = active.filter((item) => item.startTick === cursor);
      for (const item of onset) if (item.projected.grace) addGraceBeat(alphaTab, voice, item.projected, tuning);
      const key = `${cursor}:${figure.ticks}`;
      const bucket = reusable.get(key);
      const semanticSource = onset.map((item) => sourceById.get(item.projected.gp?.noteId)?.beat).find(Boolean);
      const beat = bucket?.length ? bucket.shift() : copyBeatSemantics(alphaTab, semanticSource);
      beat.notes = []; beat.noteStringLookup = new Map(); beat.noteValueLookup = new Map();
      beat.duration = figure.duration; beat.dots = figure.dots; beat.tupletNumerator = -1; beat.tupletDenominator = -1;
      beat.isEmpty = false;
      for (const item of active) {
        const segmentIds = item.projected.gp?.tieSegments || [];
        const matching = segmentIds.find((segment) => segment.startTick === cursor);
        const source = matching ? sourceById.get(matching.noteId)
          : cursor === item.startTick && Number.isFinite(item.projected.gp?.noteId) ? sourceById.get(item.projected.gp.noteId) : null;
        const note = source || copyNote(alphaTab, sourceById.get(item.projected.gp?.noteId));
        resetRelationships(note);
        note.string = tuning.length - item.string; note.fret = Math.round(item.projected.pos.fret);
        note.isTieDestination = cursor !== item.startTick;
        // Slide-in belongs to the onset; slide-out belongs to the final tied segment.
        const finalSegment = cursor + figure.ticks >= item.endTick;
        applyEditorEffects(alphaTab, item.projected, note, beat, !source,
          cursor === item.startTick);
        if (!finalSegment && note.slideOutType) note.slideOutType = alphaTab.model.SlideOutType.None;
        if (cursor !== item.startTick) note.slideInType = alphaTab.model.SlideInType.None;
        beat.addNote(note);
      }
      voice.addBeat(beat);
      cursor += figure.ticks;
    }
  }
}

function planLane(score, staff, lane, points, bounds) {
  const { byId, origins } = sourceNotes(staff), items = [];
  const scoreEnd = bounds[bounds.length - 1]?.end || 0;
  for (const projected of lane.notes) {
    const rawStart = secondsToTick(projected.start, points), rawEnd = secondsToTick(projected.end, points);
    if (rawStart < -1 || rawEnd > scoreEnd + 1)
      throw new Error(`A note on “${lane.name}” extends beyond the imported score's first or final bar.`);
    // Round-tripped source seconds can carry tiny floating error. Preserve the
    // exact imported tick when the user has not actually moved that edge.
    let startTick = projected.gp && Math.abs(rawStart - projected.gp.startTick) < 1 ? projected.gp.startTick : quantizeTick(rawStart);
    let endTick = projected.gp && Math.abs(rawEnd - projected.gp.endTick) < 1 ? projected.gp.endTick : quantizeTick(rawEnd);
    startTick = Math.min(startTick, Math.max(0, scoreEnd - TICK_QUANTUM));
    endTick = Math.min(scoreEnd, Math.max(startTick + TICK_QUANTUM, endTick));
    items.push({ projected, startTick, endTick, string: Number(projected.pos.string) });
  }
  const assignments = chooseVoices(items), affected = new Set();
  const currentIds = new Set(items.map((item) => item.projected.gp?.noteId).filter(Number.isFinite));
  for (const origin of origins) if (!currentIds.has(origin.id)) {
    let tail = origin, guard = 0;
    while (tail && guard++ < MAX_TIE_CHAIN) {
      affected.add(`${tail.beat.voice.bar.index}:${tail.beat.voice.index}`);
      tail = tail.isTieOrigin ? tail.tieDestination : null;
    }
  }
  for (const item of items) {
    const gp = item.projected.gp, assigned = assignments.get(item.projected);
    const changed = !gp || Math.abs(item.startTick - gp.startTick) > 1 || Math.abs(item.endTick - gp.endTick) > 1 || assigned !== gp.voice;
    const graceChanged = !same(item.projected.grace, gp?.editorEffects?.grace);
    if (changed || graceChanged) {
      if (gp) for (const bar of barsOverlapping(bounds, gp.startTick, gp.endTick)) affected.add(`${bar}:${gp.voice}`);
      for (const bar of barsOverlapping(bounds, item.startTick, item.endTick)) affected.add(`${bar}:${assigned}`);
    }
  }
  return { byId, items, assignments, affected };
}

export function applyImportedProjection(alphaTab, score, lanes, selectedTrackIndexes) {
  validateImportedProjection(lanes);
  const selectedPosition = new Map((selectedTrackIndexes || []).map((sourceIndex, index) => [Number(sourceIndex), index]));
  const points = timeline(score), bounds = barBounds(score);
  const connectedSlidePlans = [];
  let didRebuild = false;
  for (const lane of lanes) {
    const track = score.tracks[selectedPosition.get(Number(lane.sourceTrackIndex))];
    const staff = track?.staves?.[Number(lane.sourceStaffIndex)];
    if (!track || !staff) throw new Error(`The source staff for “${lane.name}” is missing.`);
    if (track.staves.length === 1) track.name = lane.name;
    if (Number.isFinite(lane.gmProgram)) track.playbackInfo.program = Math.round(lane.gmProgram);
    const tuning = tuningFromImportedLane(lane);
    // New notes drawn/pasted into an exact imported lane have no source
    // fingering, and one has to be picked to write the file. On COPIES: export
    // is a read-only operation as far as the user is concerned, and writing the
    // chosen positions back into lane.notes edited the project outside undo,
    // without marking it dirty and without bumping voicingRevision — so the
    // change rode along invisibly with whatever save came next.
    // appendCreatedLanes below does the same job on copies already.
    const laneNotes = (lane.notes || []).map((note) => (note.pos ? note : {
      ...note,
      pos: { ...resolvedPosition(note, tuning, Number(lane.transpositionPitch) || 0), scope: "local" },
    }));
    const sourceTuning = [...(staff.stringTuning?.tunings || [])];
    const tuningChanged = sourceTuning.length !== tuning.length
      || sourceTuning.some((pitch, index) => pitch !== tuning[index]);
    staff.stringTuning.tunings = [...tuning];
    // Keep Guitar Pro's authored tuning label/standard flag when the app has
    // not changed the pitches. Clearing them made a pristine import subtly
    // different even though every note still sounded at the same pitch.
    if (tuningChanged) {
      staff.stringTuning.name = "";
      staff.stringTuning.isStandard = false;
    }
    staff.capo = Number(lane.capo) || 0;
    staff.transpositionPitch = Number(lane.transpositionPitch) || 0;
    staff.displayTranspositionPitch = Number(lane.displayTranspositionPitch) || 0;
    const projectedLane = {
      ...lane,
      notes: representPickedOpenSlides(laneNotes),
    };
    const plan = planLane(score, staff, projectedLane, points, bounds);
    // Patch position and editor effects onto surviving source notes first. Voice
    // rebuilds below reuse these objects where possible.
    for (const item of plan.items) {
      const source = plan.byId.get(item.projected.gp?.noteId);
      if (!source) continue;
      source.string = tuning.length - item.string; source.fret = Math.round(item.projected.pos.fret);
      applyEditorEffects(alphaTab, item.projected, source, source.beat);
      for (const segment of item.projected.gp?.tieSegments || []) {
        const tied = plan.byId.get(segment.noteId);
        if (tied) { tied.string = source.string; tied.fret = source.fret; }
      }
    }
    for (const key of plan.affected) {
      didRebuild = true;
      const [barIndex, voiceIndex] = key.split(":").map(Number);
      const active = plan.items.filter((item) => plan.assignments.get(item.projected) === voiceIndex
        && item.startTick < bounds[barIndex].end && item.endTick > bounds[barIndex].start);
      rebuildVoice(alphaTab, staff, barIndex, voiceIndex, active, tuning, plan.byId);
    }
    connectedSlidePlans.push({ staff, plan });
  }
  if (didRebuild) score.finish(new alphaTab.Settings());
  if (restoreConnectedSlideLinks(alphaTab, connectedSlidePlans))
    score.finish(new alphaTab.Settings());
  return score;
}

function normalizeAutomaticStringPerformance(notes) {
  const kept = new Set(notes);
  let dropped = 0, shortened = 0;
  const stringCount = notes.reduce((count, note) => Math.max(count, (Number(note.pos?.string) + 1) || 0), 0);
  for (let string = 0; string < stringCount; string++) {
    const onString = notes.filter((note) => Number(note.pos?.string) === string)
      .sort((a, b) => a.start - b.start || a.pos.fret - b.pos.fret || a.end - b.end);
    const ordered = [];
    for (let index = 0; index < onString.length;) {
      let end = index + 1;
      while (end < onString.length && Math.abs(onString[end].start - onString[index].start) < 1e-6) end++;
      // One string cannot sound two frets at one onset. Keep the lower fret,
      // matching the legacy GP5 writer's collision behavior.
      ordered.push(onString[index]);
      for (let duplicate = index + 1; duplicate < end; duplicate++) {
        kept.delete(onString[duplicate]);
        dropped++;
      }
      index = end;
    }
    // Re-picking a string stops its previous note. The legacy writer already
    // clips that sustain; doing it here prevents artificial voice explosions
    // when a polyphonic MIDI transcription is assigned to guitar strings.
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1], current = ordered[index];
      if (previous.end > current.start + 1e-6) {
        previous.end = current.start;
        shortened++;
      }
    }
  }
  return { notes: notes.filter((note) => kept.has(note) && note.end > note.start + 1e-6), dropped, shortened };
}

// alphaTab resolves connected slides during Score.finish(). On the first pass,
// within-bar beat links exist but a following bar is not yet reachable, so it
// destructively clears cross-bar slides. After that pass has linked the score,
// restore the editor effects with explicit targets and finish once more.
function restoreConnectedSlideLinks(alphaTab, plans) {
  let restored = 0;
  for (const { staff, plan } of plans) {
    const notes = [];
    for (const bar of staff.bars) for (const voice of bar.voices)
      for (const beat of voice.beats) for (const note of beat.notes)
        notes.push({ note, voice: voice.index, start: beat.absolutePlaybackStart });
    for (const item of plan.items) {
      if (item.projected.slide !== "shift" && item.projected.slide !== "legato") continue;
      const string = staff.stringTuning.tunings.length - item.string;
      const voice = plan.assignments.get(item.projected);
      const origin = notes
        .filter((entry) => entry.voice === voice && entry.note.string === string
          && entry.start >= item.startTick && entry.start < item.endTick)
        .sort((a, b) => b.start - a.start)[0]?.note;
      if (!origin) continue;
      const target = alphaTab.model.Note.nextNoteOnSameLine(origin);
      if (!target) continue;
      origin.slideOutType = item.projected.slide === "legato"
        ? alphaTab.model.SlideOutType.Legato : alphaTab.model.SlideOutType.Shift;
      origin.slideTarget = target;
      target.slideOrigin = origin;
      restored++;
    }
  }
  return restored;
}

// `bars` is the song's bar-line times, which the voicer plans the fretting hand
// against (planSeats). Passed in rather than read from the store: this module stays
// DOM-free so the headless GP tests can import it. Without them a created lane is
// still voiced, just without a plan — and then the exported file disagrees with the
// tab on screen, which is why every caller in guitar-pro-score.js supplies them.
export function appendCreatedLanes(alphaTab, score, lanes, bars = []) {
  if (!lanes.length) return score;
  const connectedSlidePlans = [];
  for (const lane of lanes) {
    const tuning = tuningFromLane(lane);
    const sourceNotes = arrangedNotes(lane.notes || []);
    const positions = lane.fingeringMode === "exact"
      ? new Map(sourceNotes.map((note) => [note, note.pos]))
      : voiceNotes(sourceNotes, tuning, Infinity, { bars, instrument: lane.instrument, holds: lane.handHolds });
    const missing = sourceNotes.filter((note) => !positions.get(note));
    if (missing.length && lane.fingeringMode === "exact")
      throw new Error(`Modern export needs the original string/fret position for every note on "${lane.name}".`);
    if (missing.length) {
      score.cwWarnings ||= [];
      score.cwWarnings.push(`${lane.name}: ${missing.length} note(s) cannot be played in this tuning and were skipped`);
    }
    let projected = sourceNotes.flatMap((note) => {
      const position = positions.get(note);
      return position ? [{ ...note, pos: { string: Number(position.string), fret: Number(position.fret), scope: "local" } }] : [];
    });
    if (lane.fingeringMode !== "exact") {
      const normalized = normalizeAutomaticStringPerformance(projected);
      projected = normalized.notes;
      if (normalized.dropped) {
        score.cwWarnings ||= [];
        score.cwWarnings.push(`${lane.name}: ${normalized.dropped} simultaneous note(s) competed for one string and were skipped`);
      }
      if (normalized.shortened) {
        score.cwWarnings ||= [];
        score.cwWarnings.push(`${lane.name}: ${normalized.shortened} earlier note(s) were shortened when their string was played again`);
      }
    }
    projected = representPickedOpenSlides(projected);

    const track = new alphaTab.model.Track();
    track.name = lane.name || "Guitar";
    if (Number.isFinite(lane.gmProgram)) track.playbackInfo.program = Math.max(0, Math.min(127, Math.round(lane.gmProgram)));
    const staff = new alphaTab.model.Staff();
    staff.stringTuning.tunings = [...tuning]; staff.stringTuning.name = ""; staff.stringTuning.isStandard = false;
    staff.capo = Number(lane.capo) || 0;
    staff.transpositionPitch = Number(lane.transpositionPitch) || 0;
    staff.displayTranspositionPitch = Number(lane.displayTranspositionPitch) || 0;
    track.addStaff(staff); score.addTrack(track);
    for (let index = 0; index < score.masterBars.length; index++) {
      const bar = new alphaTab.model.Bar();
      bar.addVoice(new alphaTab.model.Voice());
      staff.addBar(bar);
    }
    const points = timeline(score), bounds = barBounds(score);
    const plan = planLane(score, staff, { ...lane, notes: projected }, points, bounds);
    const rebuild = new Set(plan.affected);
    for (let barIndex = 0; barIndex < bounds.length; barIndex++) rebuild.add(`${barIndex}:0`);
    for (const key of rebuild) {
      const [barIndex, voiceIndex] = key.split(":").map(Number);
      const active = plan.items.filter((item) => plan.assignments.get(item.projected) === voiceIndex
        && item.startTick < bounds[barIndex].end && item.endTick > bounds[barIndex].start);
      rebuildVoice(alphaTab, staff, barIndex, voiceIndex, active, tuning, plan.byId);
    }
    connectedSlidePlans.push({ staff, plan });
  }
  score.finish(new alphaTab.Settings());
  if (restoreConnectedSlideLinks(alphaTab, connectedSlidePlans))
    score.finish(new alphaTab.Settings());
  return score;
}

export function applyScoreStructure(alphaTab, score, bars) {
  if (!Array.isArray(bars) || !bars.length || !score.tracks?.length) return score;
  const oldMasters = [...score.masterBars];
  const oldStaffBars = new Map();
  for (const track of score.tracks) for (const staff of track.staves) oldStaffBars.set(staff, [...staff.bars]);
  score.masterBars = bars.map((item) => Number.isInteger(item.sourceIndex) && oldMasters[item.sourceIndex]
    ? oldMasters[item.sourceIndex] : new alphaTab.model.MasterBar());
  for (const [staff, originals] of oldStaffBars) {
    staff.bars = bars.map((item) => {
      if (Number.isInteger(item.sourceIndex) && originals[item.sourceIndex]) return originals[item.sourceIndex];
      const bar = new alphaTab.model.Bar(); bar.addVoice(new alphaTab.model.Voice()); return bar;
    });
  }
  let start = 0;
  score.masterBars.forEach((master, index) => {
    const item = bars[index];
    master.score = score; master.index = index; master.start = start;
    master.previousMasterBar = score.masterBars[index - 1] || null;
    master.nextMasterBar = score.masterBars[index + 1] || null;
    master.timeSignatureNumerator = Math.max(1, Number(item.timeSignatureNumerator) || 4);
    master.timeSignatureDenominator = Math.max(1, Number(item.timeSignatureDenominator) || 4);
    start += masterBarDuration(master);
  });
  for (const [staff] of oldStaffBars) staff.bars.forEach((bar, index) => {
    bar.staff = staff; bar.index = index; bar.previousBar = staff.bars[index - 1] || null; bar.nextBar = staff.bars[index + 1] || null;
    if (!Number.isInteger(bars[index].sourceIndex))
      rebuildVoice(alphaTab, staff, index, 0, [], staff.stringTuning.tunings || [], new Map());
  });
  score.finish(new alphaTab.Settings());
  // The time signature is set twice on purpose. finish() recomputes bar timing
  // from the whole score and normalizes the master bars while doing it, so
  // anything that must survive has to be written AFTERWARDS — the same hazard
  // spelled out for connected slides ~120 lines above ("alphaTab destructively
  // clears cross-bar slides... restore... and finish once more"). Delete either
  // assignment and the meter reverts to whatever alphaTab inferred.
  bars.forEach((item, index) => {
    const master = score.masterBars[index];
    master.timeSignatureNumerator = Math.max(1, Number(item.timeSignatureNumerator) || 4);
    master.timeSignatureDenominator = Math.max(1, Number(item.timeSignatureDenominator) || 4);
    master.keySignature = Math.max(-7, Math.min(7, Number(item.keySignature) || 0));
    master.keySignatureType = Number(item.keySignatureType) === 1 ? 1 : 0;
    master.isRepeatStart = !!item.isRepeatStart; master.repeatCount = Math.max(0, Number(item.repeatCount) || 0);
    master.alternateEndings = Math.max(0, Number(item.alternateEndings) || 0);
    master.isAnacrusis = !!item.isAnacrusis; master.isFreeTime = !!item.isFreeTime;
    if (Number.isFinite(Number(item.tripletFeel))) master.tripletFeel = Number(item.tripletFeel);
    if (item.section?.text || item.section?.marker) {
      const section = new alphaTab.model.Section();
      section.marker = item.section.marker || item.section.text || "";
      section.text = item.section.text || item.section.marker || ""; master.section = section;
    } else master.section = null;
  });
  score.finish(new alphaTab.Settings());
  return score;
}
