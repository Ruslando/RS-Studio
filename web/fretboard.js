import { fretboardPreviewPhrase } from './fretboard-preview-phrase.js';
import { hammerPositionGroup, hammerPositionPlan, hammerPositionPreview } from './hammer-positions.js';
import { fretboardShapeFrames, shapeHandAt } from './fretboard-shapes.js';
import { boxOfNote, previewPositionReferences } from "./references.js";
import { positionPreviewHand, positionPreviewLane } from "./position-preview.js";
import { positionEditTargets, positionSelection, resetSharedPositions, sharedPositionPlan } from "./position-selection.js";
import { fretboardHandKey } from "./fretboard-cache.js";
import { suggestionLane, suggestionDiffers } from './fretboard-suggestion.js';
import { chordWarnings, SHAPE_WARNINGS } from "./chord-warnings.js";
import { panelControls, syncPanelControls } from "./canvas-controls.js";
// The fretboard panel: a canvas under the spectrogram showing the neck the song
// is played on, with the hand playing it.
//
// It shares the timeline's themed stage surface and puts every colour in PAINT.
// The board is the chrome tier, the nut,
// frets and strings are the three text tiers in brightness order (bone, nickel,
// steel), and that ladder is what makes the frets the thing you read first.
//
// The panel's height is not a chosen number. It is whatever the selected lane's
// own neck needs at the width the window gives it — which is why a bass panel is
// shorter than a guitar one rather than a guitar one with two strings missing: a
// 34" board is 10.6 : 1 where a 25.5" board is 8.5 : 1. CSS caps it at half the
// editor, and past that cap the board shrinks and centres instead of stretching.
// Both mm → px scales are the same one, always.

import { NO_FINGER, placeAt, slidLanding, slideInShift, slideSpan, fingerLabel, barreGroups, boardHalfWidthAt, boardLength, boardWidth, capoLine, dotCentre, fretCentre, fretDistance, fretboardFor, gripIndex, handAt, handColumns, ringingMarksAt, releasedStringsAt, stringContactAt, notePlacements, pickBox, shapeBox, stringOffsetAt } from "./fretboard-core.js";
import { $, editorEl, fretboardApply, fretboardAuto, fretboardBusy, fretboardBusyLabel, fretboardEl, fretboardName, fretboardPanel, fretboardPin, fretboardShape, fretboardStage } from "./dom.js";
import { UI_PAINT as PAINT, WASH } from "./stage-paint.js";
import { STAGE_ANCHORED, instrKey, stageMono, stageUi } from "./constants.js";
import { dpr, hexA, noteName, rememberPref } from "./util.js";
import { panelMotion } from "./panel-motion.js";
import { splitter } from "./splitters.js";
import { draw } from "./repaint.js";
import { canEditLane, editLanes } from "./lanes.js";
import { chordLabel, laneChords } from "./chord-names.js";
import { renameChord } from "./chord-rename.js";
import { songBarStarts } from "./song-bars.js";
import { gridAt, gridBpm, gridSegments, minDur, segBeatSec, snap, snapNote } from "./grid.js";
import { noteLength } from "./note-length.js";
import { playbackTime, transportPlaying } from "./playback.js";
import { selectedTablatureLane } from "./layer-role.js";
import { S } from "./store.js";
import { fingerLightAt, fingerPulseAt, fingerWaveAt, popLiftAt, popPreparation, popThicknessAt } from "./string-techniques.js";
import { fretStrikeAt, stringAttackPulse, stringGlow } from "./string-glow.js";
import { letRingEnd, strikeTime, strumOffset, tremoloStep } from "./articulations.js";
import { FX_GLYPHS } from "./note-effects.js";
import { laneFingering, laneFretCount, laneFretTuning, laneTuning } from "./tablature.js";
import { assignFingers, chordColumns, handChoices, handProfileForTuning, needsFret, overrideFlow, placementFault, placementLimits, soundingColumns } from "./voicing-core.js";
import { columnAlternatives, stepVoiceFocus } from "./voicing.js";
import { applyColumnAlternative, clearOverrideAt, columnOf, setColumnShape, setHandAnchor, draftNoteFinger, settleFingerDraft, setNotePosition, addNoteOnBoard, moveNoteOnBoard } from "./edit.js";
import { wireMenu } from "./ui.js";
import { ESC_DEPTH, registerEscapeLayer } from "./escape-stack.js";
import { toast } from "./notify.js";

// = --s-group. A canvas cannot read a token, which is the same concession rule 15
// already makes for the stage's colours and constants.js makes for its fonts.
const PAD = 16;
const controlsHeight = () => $("fretboardControls").offsetHeight;

// Off at launch: the neck is a second view of the song, and the editor opens on the
// song. A session toggle either way — like the marker lanes, and like zoom.
let visible = false;
let foldedState = null;   // the project the folded strip's picture belongs to
// A height the player dragged the panel to (the handle above it), or 0 for "as tall
// as the neck wants". The neck scales into whatever it is given — both axes share one
// scale — so smaller is a smaller neck and taller is the same neck with air round it.
const LS_HEIGHT = "cw.fretboardH", HEIGHT_MIN = 90, COLLAPSE_AT = 60;
let userHeight = Math.max(0, parseInt(localStorage.getItem(LS_HEIGHT), 10) || 0);
let settling = 0;     // until when an open/close tween is running; see layoutFretboard

// Which neck. The lane's instrument decides it — an acoustic lane gets a
// dreadnought, a bass lane a Jazz Bass — and the lane's *tuning* still decides
// whether a hand can be drawn on it, because a grip needs as many strings as the
// board has. The panel's height depends on this too, so `laidOut` remembers which
// neck it was measured for and drawFretboard bounces once through the layout when
// the answer changes.
// A capo is part of the neck the board draws, so it rides on the spec. One object per
// instrument and capo: `laidOut` compares specs by identity.
const capoSpecs = new Map();
const laneSpec = (lane) => {
  const base = fretboardFor(instrKey(lane?.instrument)), capo = Number(lane?.capo) || 0;
  if (!capo) return base;
  const key = `${instrKey(lane?.instrument)}:${capo}`;
  if (!capoSpecs.has(key)) capoSpecs.set(key, { ...base, capo });
  return capoSpecs.get(key);
};
const currentLane = () => (S.state ? selectedTablatureLane(editLanes()) : null);
let laidOut = null;

let sharedSelection = null;
function selectedPositions(lane) {
  if (!sharedSelection || sharedSelection.lane !== lane || sharedSelection.selection !== S.selection
    || sharedSelection.notes !== lane?.notes || sharedSelection.revision !== S.voicingRevision) {
    const group = positionSelection(lane, S.selection);
    sharedSelection = { lane, notes: lane?.notes, selection: S.selection,
      revision: S.voicingRevision, group, checks: new Map(), failures: new Set(), unchanged: false,
      key: [...S.selection].map(n => n.id).join(",") };
  }
  return sharedSelection.group;
}

function sharedShapeAllowed(lane, notes, shape) {
  const group = selectedPositions(lane);
  if (!group.multiple) return true;
  if (group.error) return false;
  const found = gripsFor(lane);
  if (!found) return false;
  const key = `${found.key}:${[...shape].map(([n, p]) => `${n.pitch}:${p?.string}:${p?.fret}`).sort().join("|")}`;
  if (!sharedSelection.checks.has(key)) {
    const plan = sharedPositionPlan(lane, S.selection, notes, shape, laneFretTuning(lane),
      note => found.voiced?.get(note), laneFretCount(lane));
    const changed = plan.changes.some(({ note, pos }) =>
      note.arrangement || !note.pos || Object.keys(pos).some(k => note.pos[k] !== pos[k]));
    if (plan.error) sharedSelection.failures.add(plan.error);
    else if (!changed) sharedSelection.unchanged = true;
    sharedSelection.checks.set(key, !plan.error && changed && !plan.changes.some(c => boxOfNote(c.note)?.group.locked));
  }
  return sharedSelection.checks.get(key);
}

let positionPreview = null;
function endPositionPreview() {
  positionPreview?.controller.abort();
  positionPreview = null;
}

function previewPosition(lane, notes, shape, kind) {
  const found = gripsFor(lane);
  if (!found) return null;
  const key = `${found.key}:${sharedSelection.key}:${kind}:${notes.map(n => n.id).join(",")}:${[...shape].map(([n, p]) => `${n.pitch}:${p.string}:${p.fret}`).sort().join("|")}:${songBarStarts().join(",")}`;
  if (positionPreview?.key !== key) {
    endPositionPreview();
    const prepared = positionPreviewLane(lane, notes, shape, S.selection, laneFretTuning(lane),
      note => found.voiced.get(note), laneFretCount(lane), kind);
    if (!prepared) return null;
    previewPositionReferences(lane, prepared.lane);
    const controller = new AbortController(), selection = S.selection;
    const request = { key, controller, pending: true, hand: null, selection, lane, sourceKey: found.key };
    positionPreview = request;
    laneFingering(prepared.lane, controller.signal).then(result => {
      if (positionPreview !== request || currentLane() !== lane || S.selection !== selection || handKey(lane) !== found.key) return;
      const linkedNotes = [...new Set(notes.flatMap(n => hammerPositionGroup(lane.notes, n, m => found.voiced.get(m))))];
      request.hand = positionPreviewHand(linkedNotes, prepared.noteFor, result);
      request.pending = false;
      drawFretboard();
    }).catch(() => {
      if (positionPreview !== request) return;
      request.pending = false;
      drawFretboard();
    });
  }
  return positionPreview;
}

function previewIsCurrent(offer, lane) {
  const preview = offer?.preview;
  return !!preview?.hand && preview === positionPreview && preview.lane === lane
    && preview.selection === S.selection && preview.sourceKey === handKey(lane);
}

// The selected tablature lane's fingering, as a timeline of grips. Voicing a whole
// lane runs in a worker, so this is filled in asynchronously and the board draws
// bare until it lands. Keyed the way draw.js keys its own voicing caches — the
// revision plus the notes array's identity — with the inputs that change a
// fingering without changing a note (the tuning).
let hand = null;      // { key, columns, strings }
let handJob = "";     // the key currently being voiced, so one lane is asked once

function handKey(lane) {
  return `${voicingKey(lane)}:f${S.fingerRevision || 0}`;
}

// The part of handKey that needs the lane voiced again. A typed finger is laid over
// the voicing after it (laneFingering), so it changes handKey and not this.
function voicingKey(lane) {
  const tempo = gridSegments().map((seg) => `${seg.t}:${seg.bpm}`).join(",");
  return fretboardHandKey(lane, S.voicingRevision, tempo);
}

// Which finger holds which note, and which fret the hand is anchored on.
//
// Both come from the WALK when the walk produced them (`fingers`/`seats`, see
// voiceNotesFingered), and only fall back to assignFingers on a lane whose positions
// nobody's hand chose — an exact import. The distinction matters and it is the whole
// reason the walk now hands these out: assignFingers reads a fingering off one shape
// in isolation, and one shape in isolation cannot say which finger takes a lone note.
// It answers "index, seated on its own fret" every time, which is true only if the
// hand arrived from nowhere.
function gripsFrom({ tuning, notes, voiced, fingers: walked, seats }) {
  const profile = handProfileForTuning(tuning);
  const columns = [], ringEnds = new Map(), following = new Map();
  for (const n of [...notes].sort((a, b) => b.start - a.start)) {
    const key = n.pos?.string != null ? `s${n.pos.string}` : `p${n.pitch}`;
    if (n.fx?.letRing) ringEnds.set(n, letRingEnd(n, following.get(key), S.state.duration) + 0.15);
    following.set(key, n.start);
  }
  for (const col of chordColumns(notes.filter(note => !note.gripOnly))) {
    const shape = new Map();
    for (const note of col.notes) {
      const pos = voiced.get(note);
      if (pos) shape.set(note, pos);
    }
    if (!shape.size) continue;
    const known = walked && [...shape.keys()].some((note) => walked.has(note));
    const fingers = known ? walked : assignFingers(shape, profile);
    // Where the index is standing. Null under a column the walk did not answer for,
    // and the board simply draws no anchor there rather than guessing one.
    const seat = seats ? [...shape.keys()].map((note) => seats.get(note)).find((v) => v != null) ?? null : null;
    columns.push({
      seat,
      // One of the column's own notes, so the board can hand the voicing engine a
      // column without re-grouping the lane: chordColumns over 1500 notes is not a
      // thing to run per frame, and this pass has already done it.
      note: col.notes[0],
      start: Math.min(...col.notes.map((n) => n.start)),
      // An eighth at the tempo here: how long a slide into or out of it takes (bend.js).
      eighth: 30 / (gridAt(col.notes[0].start)?.bpm || 120),
      end: Math.max(...[...shape.keys()].map((n) => n.end)),
      // Each finger keeps its own note's onset, not the column's. A strum is a
      // chord whose notes are milliseconds apart, so this is what makes the glow
      // sweep across the strings in the direction the hand moved.
      //
      // `dead` is carried rather than folded into the finger, because the voicing
      // model deliberately gives a dead note no finger at all — groupsAtEachFret()
      // filters it out, on the grounds that a mute is played by relaxing the grip
      // you already hold rather than by moving to a new one. So the absent finger
      // is the model's answer, not a gap in it, and the marker must say which.
      fingers: [...shape].map(([note, pos]) => ({
        note,
        soundingEnd: ringEnds.get(note),
        strikeStart: note.start + strumOffset(note, col.notes),
        tremoloStep: tremoloStep(note, gridAt(note.start)?.bpm || 120),
        string: pos.string, fret: pos.fret, start: note.start,
        finger: fingers.get(note) ?? NO_FINGER, dead: !!note.fx?.dead,
        // Carried so the grip can name itself. Not derivable from the mark, whose
        // fret and string are mid-slide while the hand travels.
        pitch: note.pitch,
      })),
    });
  }
  return handColumns(columns, tuning.length);
}

function gripsFor(lane) {
  const key = handKey(lane), vkey = voicingKey(lane);
  if (hand && hand.key === key) return hand;
  if (handJob !== key) {
    handJob = key;
    laneFingering(lane).then((fingering) => {
      if (handJob !== key) return;    // a later edit already asked for a newer one
      const columns = gripsFrom(fingering);
      const shapes = fretboardShapeFrames(fingering, columns);
      const blockedStarts = new Set(chordWarnings(lane, laneFretTuning(lane), laneFretCount(lane), S.voicingRevision)
        .filter(column => column.kind === "impossible").map(column => column.t0));
      const playableColumns = columns.filter(column => !blockedStarts.has(column.start));
      const fingers = playableColumns.flatMap(column => column.fingers);
      hand = { key, vkey, strings: fingering.tuning.length, columns, playableColumns, shapes, blockedStarts, voiced: fingering.voiced, fingers: fingering.fingers,
        ringFingers: fingers.filter((f) => f.note.fx?.letRing),
        releaseFingers: [...fingers].reverse(),
        popFingers: fingers.filter((f) => f.note.slap === "pop") };
      draw();
    // A failure is an *answer*, and it is stored as one: an empty timeline under the
    // same key. Leaving `hand` alone would re-ask sixty times a second, and leaving it
    // null makes "no answer yet" indistinguishable from "no answer", which is the
    // difference the spinner below is drawing. The one failure that actually happens
    // is an imported lane missing an authored position — a property of the lane, not
    // a hiccup, so it is not retried until an edit changes the key.
    }).catch(() => { hand = { key, vkey, strings: 0, columns: [] }; draw(); });
  }
  // Only the fingers changed: the last grips stand in for the few milliseconds until
  // the new ones are laid over the same voicing, instead of a "working out" flash.
  return hand && (hand.key === key || hand.vkey === vkey) ? hand : null;
}

// What the techniques on `note`'s column allow, per note — see placementLimits. Every
// offer below asks this before it is drawn, so the neck never proposes a place a
// slide, bend, trill or hammer-on rules out. Kept per fingering, because the pointer
// redraws the board far more often than the lane changes.
let limitsMemo = null;   // { key, limits }
function limitsFor(lane, note) {
  const found = lane && note && gripsFor(lane);
  if (!found) return null;
  if (limitsMemo?.key === found.key && limitsMemo.limits.has(note)) return limitsMemo.limits;
  const columns = chordColumns(lane.notes);
  const limits = placementLimits(columns, columns.findIndex((c) => c.notes.includes(note)),
    laneFretTuning(lane), (n) => found.voiced?.get(n) || null, laneFretCount(lane));
  limitsMemo = { key: found.key, limits };
  return limits;
}
const allowedAt = (lane, tuning, s) => (p) => {
  let limit = limitsFor(lane, p.note)?.get(p.note);
  // While staging a shared chord, linked neighbours may also be moving. Check
  // intrinsic effects now and the complete prospective links on Apply.
  const group = selectedPositions(lane);
  if (group.multiple) {
    if (group.error) return false;
    const source = group.columns.find(c => c.notes.includes(p.note));
    if (!source) return false;
    const index = [...source.notes].sort((a, b) => a.pitch - b.pitch).indexOf(p.note);
    return group.columns.every(c => {
      const target = [...c.notes].sort((a, b) => a.pitch - b.pitch)[index];
      return !placementFault({ fretted: needsFret(target), reach: target.trill === "whole" ? 2 : target.trill ? 1 : 0 },
        target.pitch, p.string, tuning, s.frets);
    });
  }
  const found = gripsFor(lane);
  if (found) {
    const plan = hammerPositionPlan(lane, new Map([[p.note, { string: p.string, fret: p.fret }]]),
      tuning, n => found.voiced.get(n), s.frets);
    if (plan.linked) return !plan.error && !plan.changes.some(c => boxOfNote(c.note)?.group.locked);
  }
  return !placementFault(limit, p.note.pitch, p.string, tuning, s.frets);
};

// How long a shift takes: one beat. A hand moves in musical time, not in the
// interface's 90ms — and taking it from the grid means a slow song shows the
// travel and a fast one snaps, which is what actually happens.
const travelSeconds = () => 60 / (gridBpm() || 120);

// ---- other positions ----
// Edit mode previews a hovered candidate; clicking its ring or box commits it.
let altsOn = false;
let alts = null;      // { note, rev, t0, notes, influence, ranked, boxes, hover }
// Pausing defaults to editing; playback switches to the neck preview. The mode owns three things at once —
// whether a click moves the hand, whether the other positions are drawn, and whether
// onion skin is offered — because all three are the same question ("what else could
// this be, and what would it do to its neighbours") and none of them is worth the
// panel's width while you are only watching the song go past.
let editing = false;
let previewAlternative = false;
let alternativeIndex = -1, alternativeCount = 0, alternativeKey = "", activeAlternative = null;

function selectAlternative(key, items) {
  if (alternativeKey !== key) { alternativeKey = key; alternativeIndex = -1; previewAlternative = false; }
  alternativeCount = items.length;
  alternativeIndex = Math.max(-1, Math.min(alternativeIndex, items.length - 1));
  return items[alternativeIndex] || null;
}

let altsJob = null;   // the note a request is out for, so one column is asked once

// A single note's rings are all click targets; for a chord only the displayed
// alternative is. Custom shape entry keeps its own per-note targets.
let spots = null;     // last frame's targets: { note, string, fret, x0, x1, y0, y1 }
let spotHover = -1;
let hoverPicked = false, hoverAt = -1;   // the browsed ring came from hovering, not the arrows
// The hand positions that can play it, as fret spaces you click; open with the rings.
// The chord the bar's name field is editing, so a commit lands on the right one.
let chordShown = null;
// A legal hand position under the pointer in the fret-number row.
let handPeek = null;
let comparisonPreview = null;
// A temporary, read-only view used by repeat comparison. It never seeks the
// transport or changes the editor's selection or positions.
export function previewFretboardNote(lane = null, note = null, label = '') {
  comparisonPreview = lane ? { lane, note, label } : null;
  fretboardPanel.toggleAttribute('data-comparison-preview', !!comparisonPreview);
  draw();
}
let pendingHandColumn = null;

let shownAnyway = null;   // { key: hand revision, column: "laneId:t0" }
let revealedHand = null;
const shapeRevealed = (lane, column) => !!shownAnyway && shownAnyway.key === handKey(lane)
  && shownAnyway.column === column;
const fretboardShowAnyway = $("fretboardShowAnyway");

// Custom shape entry keeps its existing staged walk; its redesign is separate.
let shaping = null;   // { notes, index, picked: Map(note -> { string, fret }) }
// THE MOMENT THE BOARD SHOWS. While the song runs that is the playhead. Stopped, it is
// the playhead plus a hair: a parked playhead is stored to the microsecond and a
// note's onset is not, so a cursor sitting "on" a note is routinely a few nanoseconds
// before it — which is the previous column, already released, and an empty neck. The
// travel animation used to paper over this by drawing the next grip arriving.
const boardTime = () => playbackTime() + (transportPlaying() ? 0 : 1e-3);

// The column under the playhead, without selecting it: only the latest onset column,
// since notes still held from earlier columns are other voices (reachable with ↑ ↓).
function playheadColumnNote(lane) {
  if (!lane?.notes?.length) return null;
  const latest = soundingColumns(lane.notes, boardTime()).reduce((a, c) => (!a || c.t0 >= a.t0 ? c : a), null);
  return latest?.notes.find((n) => Number.isFinite(n.pitch)) || null;
}

// Expose the actual edit recipients, independently of the playback cursor.
export function fretboardEditTargets() {
  if (comparisonPreview) return new Set();
  const lane = currentLane();
  if (!visible || !editing || transportPlaying() || !lane || !canEditLane(lane)) return new Set();
  const group = selectedPositions(lane);
  if (group.multiple) return positionEditTargets(group);
  const note = focusNote(lane);
  return positionEditTargets(group, note ? columnOf(note)?.col.notes || [] : []);
}

// The column being decided: the selection's, else the one under the playhead.
// Pausing no longer selects it, so the spectrogram shows no marking it did not ask for.
function focusNote(lane) {
  for (const n of S.selection) if (Number.isFinite(n.pitch) && lane?.notes.includes(n)) return n;
  return playheadColumnNote(lane);
}

// The moment the board holds while a choice is being made — the onset of the column
// being decided, instead of the playhead. Both working views freeze on it, and they
// read it from here rather than each keeping their own, so the boxes, the rings, the
// hand and the anchor band cannot end up looking at different chords.
function frozenAt(lane) {
  // NOTHING IS FROZEN WHILE THE SONG PLAYS. The freeze is for holding one column still
  // against the alternatives being compared with it, and while the transport runs
  // there is nothing to compare — the neck is being watched, and its job is to show the
  // hand playing the song. Entering edit mode used to pin it: the mode turns the offers
  // on, the offers freeze the column, and the hand then sat on one chord until you hit
  // pause.
  if (transportPlaying()) return null;
  if (!altsOn) return null;
  if (alts?.rev === S.voicingRevision && alts.lane === lane && alts.note === focusNote(lane)) return alts.t0;
  const note = focusNote(lane), found = lane && gripsFor(lane);
  if (!note || !found) return null;
  const i = gripIndex(found.columns, note.start + 1e-6);
  return i >= 0 ? found.columns[i].start : null;
}

// Keyed on the note and the edit revision, so applying a shape re-asks (the costs
// that ranked the list were scored against neighbours that have now moved) and
// nothing else does.
function altsFor(note) {
  const rev = S.voicingRevision;
  if (alts && alts.note === note && alts.rev === rev) return alts;
  // The job is the whole key, not the note: comparing against `alts` instead would
  // re-ask on every frame of the wait, because a pending request has nothing to
  // compare with. A request that comes back empty leaves the key standing, so a
  // column with no other position is asked once and not sixty times a second.
  if (altsJob?.note !== note || altsJob.rev !== rev) {
    altsJob = { note, rev };
    columnAlternatives(note, (found) => {
      if (altsJob?.note !== note || altsJob.rev !== rev) return;
      // AN EMPTY ANSWER IS STILL AN ANSWER, and it has to be stored as one. It used to
      // leave `alts` null, which is the same value as "nothing has come back yet" — so
      // a column the worker could not answer for spun the panel's spinner for ever.
      // Spread over the shell rather than replacing it: an empty answer has no `lane`,
      // and every reader below is already guarded on that.
      alts = { note, rev, boxes: [], hover: -1, ...(found || {}) };
      draw();
    });
  }
  return null;
}

// Transport state owns the editing controls; playback is always read-only.
export function setFretboardEdit(on) {
  const next = !!on && visible && !transportPlaying(), changed = next !== editing;
  const motion = panelMotion();
  if (changed) {
    // Keep resize observers from snapping the mode's height change to its end.
    fretboardPanel.style.transition = "";
    settling = performance.now() + motion.duration;
  }
  editing = next;
  previewAlternative = false; alternativeIndex = -1;
  fretboardPanel.toggleAttribute("data-editing", editing);
  drawFretboard();
  setFretboardAlts(editing);
  if (!editing) setFretboardShape(false);
  fretboardEl.style.cursor = "";
  if (!editing) { hideSuggestion(); fretboardPin.hidden = true; }
  layoutFretboard();
  if (changed && motion.duration) {
    $("fretboardControls").getAnimations().forEach(animation => animation.cancel());
    $("fretboardControls").animate([
      { opacity: .35, transform: "translateY(6px)" },
      { opacity: 1, transform: "translateY(0)" },
    ], { duration: motion.duration,
      easing: getComputedStyle(document.documentElement).getPropertyValue("--ease-panel").trim() });
  }
  draw();
}

function setFretboardAlts(on) {
  altsOn = !!on && visible;
  if (!altsOn) {
    alts = null; altsJob = null; spots = null; spotHover = -1;
    endPositionPreview();
    activeAlternative = null; alternativeCount = 0; alternativeKey = "";
    fretboardEl.style.cursor = "";
  }
  drawFretboard();
}

// Building a shape by hand. Entering seeds an EMPTY walk rather than the grip that is
// already there: "a shape that is not on offer" is what this is for, and a half-edited
// copy of the current one is what the circles on a single note already give you.
function setFretboardShape(on) {
  const lane = currentLane();
  const at = on ? focusGrip(lane, laneSpec(lane)) : null;
  const notes = (at?.marks || []).map((m) => m.note).filter(Boolean);
  // Low to high, which is the order a player names the strings of a chord in.
  shaping = notes.length > 1
    ? { notes: notes.slice().sort((a, b) => a.pitch - b.pitch), index: 0, picked: new Map() } : null;
  spots = null; spotHover = -1;
  if (shaping) { previewAlternative = false; hideSuggestion(); }
  syncShapeMode();
  layoutFretboard();
}

// Assign directly to the fretted note under the pointer. Each key is one undo
// step; leaving the board never leaves a pending fingering draft behind.
function typeFinger(e) {
  if (!visible || !boardEditable() || noteDrag || e.repeat || e.ctrlKey || e.metaKey || e.altKey
      || e.target.closest?.("input, textarea, select, [contenteditable]")) return false;
  const digit = /^[0-4]$/.test(e.key) ? Number(e.key) : null;
  if (digit == null && e.key !== "Delete" && e.key !== "Backspace") return false;
  const mark = boardHover?.mark;
  if (!mark?.note || !(mark.fret > 0) || mark.dead
      || !board.marks.some(current => current.note === mark.note && current.fret === mark.fret && current.string === mark.string)) return false;
  e.preventDefault(); e.stopPropagation();
  const original = new Map();
  draftNoteFinger(original, mark.note, digit, gripsFor(currentLane())?.voiced);
  settleFingerDraft(original, true);
  return true;
}

// The grip on the board back to the engine's fingers, in one undo step.
function resetGripFingers() {
  if (!boardEditable()) return;
  const original = new Map(), positions = gripsFor(currentLane())?.voiced;
  for (const m of focusGrip(currentLane(), laneSpec(currentLane()))?.marks || [])
    if (m.note && m.note.finger != null) draftNoteFinger(original, m.note, null, positions);
  settleFingerDraft(original, true);
}

function syncShapeMode() {
  fretboardPanel.toggleAttribute("data-shaping", !!shaping);
  fretboardShape.textContent = shaping ? "Cancel" : "Assign custom grip";
  fretboardShape.title = shaping ? "Discard custom shape" : "Place every note of the chord by hand";
  if (shaping) fretboardShape.removeAttribute("aria-pressed");
  else fretboardShape.setAttribute("aria-pressed", "false");
}

function stepShapeNote(delta) {
  if (!shaping) return;
  shaping.index = Math.max(0, Math.min(shaping.notes.length - 1, shaping.index + delta));
  spotHover = -1; drawFretboard();
}

// The walk, drawn: what is placed, filled in the layer's hue, and where the note being
// placed could go, as the same quiet circles the rest of the panel offers. Nothing
// else — no boxes, no other note's options — because sixteen unlabelled circles on one
// neck cannot say which belongs to which note, and this is the one view where that
// question has to have an answer.
//
// Placed marks remain selectable. Returning to a note keeps its draft position
// while offering all its other positions on strings not used by another note.
function drawShaping(ctx, s, scale, X, Y, lane) {
  const tuning = lane && laneFretTuning(lane);
  if (!tuning || tuning.length !== s.strings) return null;
  const hue = lane.color || PAINT.accent;
  shaping.preview = shaping.picked.size === shaping.notes.length
    ? previewPosition(lane, shaping.notes, shaping.picked, "custom") : null;
  const placed = [...shaping.picked].map(([note, p]) => ({
    note, pitch: note.pitch, string: p.string, fret: p.fret,
    x: fretCentre(p.fret, s), mm: fretCentre(p.fret, s), placed: true,
    finger: shaping.preview?.hand?.fingers.get(note) ?? NO_FINGER, dead: !!note.fx?.dead,
  }));
  const cur = shaping.notes[shaping.index];
  // The note being placed is handed in on string -1, which is no string at all: it
  // spends none of the ones already taken and it has no home to be excluded from.
  const asking = cur ? [{ note: cur, pitch: cur.pitch, string: -1 }] : [];
  const opts = cur
    ? notePlacements([...placed.filter(m => m.note !== cur), ...asking], tuning, s.frets, asking)
      .filter(allowedAt(lane, tuning, s))
      .filter(p => {
        if (!selectedPositions(lane).multiple) return true;
        const shape = new Map(shaping.picked);
        shape.set(p.note, { string: p.string, fret: p.fret });
        return shape.size < shaping.notes.length || sharedShapeAllowed(lane, shaping.notes, shape);
      })
      .map((p) => spotBox({ ...p, mm: fretCentre(p.fret, s) }, scale, s, X, Y))
    : [];
  spots = [...opts, ...placed.filter(m => m.note !== cur).map((m) => spotBox(m, scale, s, X, Y))];
  ctx.lineWidth = 1.8;
  for (let i = 0; i < opts.length; i++) {
    const p = opts[i];
    ctx.strokeStyle = i === spotHover ? hue : PAINT.hint;
    ctx.beginPath();
    ctx.arc((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, Math.max(1, p.r - 0.9), 0, Math.PI * 2);
    ctx.stroke();
  }
  // These are placement targets, so identify their pitch even when labels are
  // hidden for playback. A finger has not been assigned to this draft yet.
  const selected = shaping.picked.get(cur);
  drawGripNoteNames(ctx, s, scale, X, Y, opts.filter(p => p.string !== selected?.string)
    .map(p => ({ ...p, x: p.mm })), hue, false);
  drawGrip(ctx, s, scale, X, Y, placed, hue, true, { digits: !!shaping.preview?.hand, labels: "notes" });
  return cur;
}

// Onion skin: the grip before and the grip after, ghosted onto the same neck. The tab
// preview shows those two as diagrams either side of the current one; here they are in
// place, which is the point — changing a shape re-voices its neighbours, and on one
// neck you can see where the hand would have to come from and go to.

// How strong a ghost is, and whether it says which side it is on: both are the user's,
// in Editor options, and read here the way the voicing engine reads its preferences —
// off the input, at draw time, so a change previews as it is dragged and the settings
// window's Cancel walks it back with no second code path (rule 17).
// Two sliders, not one: the ghost you are working against is usually one side of
// the note — dropping the other to nothing is how you get a clean before-and-after,
// and a single knob cannot say that. 0 is a legal value on both, which is the third
// state the pair gets for free.
const onionAlpha = (side) => {
  const el = $(side === "prev" ? "onionAlphaPrev" : "onionAlphaNext");
  const v = parseFloat(el?.value);
  return (Number.isFinite(v) ? v : 35) / 100;
};


export const fretboardVisible = () => visible;

// The height the board wants at a given canvas width, plus its inset. The fret
// numbers live in the bottom half of that inset. The tuning gutter is not
// subtracted: it costs the board about 2px of height, and asking the panel for the
// height a slightly wider board wanted just leaves that 2px as slack it centres in.
const boardHeight = (w, s) =>
  Math.round(boardWidth(s) * ((w - 2 * PAD) / boardLength(s)) + 2 * PAD + 12 + controlsHeight());

// Add the toolbar's measured rows below a neck sized for the available width.
// Control wrapping changes panel height without changing the neck's proportions.
const preferredHeight = (w, s) => boardHeight(w, s);

// Two ways in — the View menu item and the panel's own chevron — so both go
// through here and the check, the chevron and the panel cannot disagree.
// The collapsed panel retains a read-only neck preview and its reopen chevron.
export function setFretboardVisible(on) {
  fretboardPanel.style.transition = "";
  settling = performance.now() + panelMotion().duration;
  // Freeze the currently rendered height before removing the collapsed rule.
  // Measuring width below flushes layout; without this, it first expands to
  // auto height and leaves the subsequent transition with nothing to animate.
  if (on && !visible) fretboardPanel.style.height = fretboardPanel.getBoundingClientRect().height + "px";
  visible = !!on;
  if (visible) fretboardPanel.classList.remove("is-peeking");
  // The canvas is not hidden, only clipped: hiding it would take the board off screen
  // in one frame and leave the panel's height animating over nothing.
  if (visible) fretboardPanel.removeAttribute("data-collapsed");
  else fretboardPanel.setAttribute("data-collapsed", "");
  // Preserve the explicit open height until the closing gesture. Clearing it
  // during opening introduces an auto-height layout that interrupts the tween.
  if (!visible) fretboardPanel.style.height = "";
  // Hide transient board controls as its contents retract out of view.
  // Closing the panel clears transient editing state. Reopening chooses the
  // default mode from the current transport state.
  if (!visible) {
    fretboardBusy.hidden = true;
    $("fretboardHandPositions").hidden = true;
    if ($("fretboardHandPositions").contains(document.activeElement)) document.activeElement.blur();
    hideSuggestion();
    fretboardPin.hidden = true;
    editing = false; pendingHandColumn = null;
    fretboardPanel.removeAttribute("data-editing");
    fretboardPanel.removeAttribute("data-edit-blocked");
    altsOn = false; alts = null; altsJob = null;
    spots = null; spotHover = -1; shaping = null; boardHover = null;
    syncShapeMode();
    fretboardShape.hidden = true;
    fretboardApply.hidden = true;
  }
  $("menuFretboardCheck").hidden = !visible;
  const label = visible ? "Hide fretboard" : "Show fretboard";
  syncPanelControls("fretboard", visible, label);
  if (visible) setFretboardEdit(!transportPlaying());
  layoutFretboard(true);      // this one IS the gesture
}

// Opening, closing and mode switches animate. Window/instrument resize settles
// immediately. The neck is measured at its destination size, then
// revealed by the panel's clip, so it never stretches during the transition.
function layoutFretboard(slide = false) {
  const cssW = fretboardStage.clientWidth;
  if (cssW < 2 * PAD) return;
  const spec = laneSpec(currentLane());
  // The strip that folds the panel sits above the board, in the panel's own padding.
  const edge = parseFloat(getComputedStyle(fretboardPanel).getPropertyValue("--w-edge")) || 0;
  // Wrapping controls adds panel height, never takes it away from the neck.
  const required = preferredHeight(cssW, spec) + edge;
  const height = Math.max(required, Math.min(userHeight || required, editorEl.clientHeight * 0.7));
  // Resize observers also fire while adjacent panels move. Repainting the same
  // destination must not cancel a reveal that is already running — and neither must
  // the drag that started it: a panel pulled open off its handle keeps tweening
  // toward the pointer instead of jumping to it.
  const snap = visible && !slide && performance.now() > settling && fretboardPanel.style.height !== height + "px";
  if (snap) fretboardPanel.style.transition = "none";
  laidOut = spec;
  fretboardPanel.style.height = visible ? height + "px" : "";
  // The board's box is pinned to the height the panel has *open*, so that closing the
  // panel slides it out of view instead of squashing it: the flex row would otherwise
  // stretch a neck into the collapsed bar while closing.
  fretboardStage.style.height = Math.max(0, height - edge - controlsHeight()
    - parseFloat(getComputedStyle(fretboardPanel).borderTopWidth)) + "px";
  // Restored on the next frame, not on this one: put back in the same task and the
  // style recalc that re-enables it has not happened yet, so the browser can still
  // animate from the old height. One frame later the new height is settled and the
  // transition is only armed for the next gesture.
  if (snap) requestAnimationFrame(() => { fretboardPanel.style.transition = ""; });
  // Re-read: the stylesheet's cap may have clipped the height we just asked for,
  // in which case the board is height-bound and fits itself to what is left.
  const w = fretboardEl.clientWidth, h = fretboardEl.clientHeight;
  const dp = dpr(), bw = Math.round(w * dp), bh = Math.round(h * dp);
  if (fretboardEl.width !== bw) fretboardEl.width = bw;
  if (fretboardEl.height !== bh) fretboardEl.height = bh;
  drawFretboard();
}

// One fret's own space on the board: the gap a finger sits in, named for the wire at
// its far end, tapering with the neck. Two things want it — the hand's anchor and the
// pointer — and a taper computed twice is a taper that drifts.
function fretSpace(ctx, n, s, X, Y) {
  n += s.capo || 0;                  // `n` counts from the capo, like every fret here
  const x0 = fretDistance(n - 1, s.scale), x1 = fretDistance(n, s.scale);
  fretSpaceBounds(ctx, x0, x1, s, X, Y);
}

function fretSpaceBounds(ctx, x0, x1, s, X, Y) {
  const h0 = boardHalfWidthAt(x0, s), h1 = boardHalfWidthAt(x1, s);
  ctx.beginPath();
  ctx.moveTo(X(x0), Y(-h0)); ctx.lineTo(X(x1), Y(-h1));
  ctx.lineTo(X(x1), Y(h1)); ctx.lineTo(X(x0), Y(h0));
  ctx.closePath();
}

function paintBoardCapo(ctx, s, scale, X, Y) {
  if (!s.capo) return;
  const x = capoLine(s), half = boardHalfWidthAt(x, s) + 1;
  ctx.fillStyle = PAINT.text;
  ctx.fillRect(X(x) - 3 * scale, Math.min(Y(-half), Y(half)), 6 * scale, half * 2 * scale);
}

function paintBoardTuning(ctx, s, X, Y, tuning, fontSize) {
  ctx.save(); ctx.font = stageMono(fontSize); ctx.fillStyle = PAINT.label;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let string = 0; string < s.strings; string++)
    ctx.fillText(noteName(tuning[string]), X(-s.nutDepth) - 8, Y(stringOffsetAt(string, 0, s)));
  ctx.restore();
}

// Shared by the live neck and the settings preview: identical dimensions and paint.
function boardProjection(ctx, s, w, h, tuning, lastFret = s.frets) {
  const length = s.nutDepth + fretDistance(lastFret, s.scale) + s.overhang;
  const width = lastFret === s.frets ? boardWidth(s) : boardHalfWidthAt(fretDistance(lastFret, s.scale), s) * 2;
  const neckH = Math.max(2 * PAD + 1, h);
  const rowPx = (s.spreadAtNut / (s.strings - 1))
    * Math.min((w - 2 * PAD) / length, (neckH - 2 * PAD) / width);
  const tunePx = rowPx >= 11 ? 11 : rowPx >= STAGE_ANCHORED ? STAGE_ANCHORED : 0;
  const strung = tuning && tuning.length === s.strings && tunePx ? tuning : null;
  // The tuning's own gutter, left of the nut. Its width follows the widest name it
  // has to hold (rule 13) rather than a chosen number, so a drop tuning cannot run
  // out under the nut; 8 is the gap from the name to the board.
  ctx.font = stageMono(tunePx || 11);
  const gutter = strung
    ? Math.max(...strung.map((p) => ctx.measureText(noteName(p)).width)) + 8 : 0;
  // One scale for both axes — the whole point. Whichever dimension binds, binds.
  const scale = Math.min((w - 2 * PAD - gutter) / length, (neckH - 2 * PAD) / width);
  if (!(scale > 0)) return null;
  const originX = PAD + gutter + (w - 2 * PAD - gutter - length * scale) / 2
    + s.nutDepth * scale;
  const X = (mm) => originX + mm * scale;              // mm from the nut
  const direction = $("fretboardStringOrder")?.value === "low-top" ? -1 : 1;
  const Y = (off) => neckH / 2 + off * scale * direction;              // mm from the centreline
  return { scale, X, Y, strung, tunePx };
}

function paintNeckInlays(ctx, s, scale, X, Y, lastFret) {
  // Inlays, cut into the board, so they sit under the strings and the frets.
  ctx.fillStyle = hexA(PAINT.label, 0.45);
  for (const n of s.dots.filter(n => n <= lastFret)) {
    const cx = dotCentre(n, s), r = (s.dotDiameter * scale) / 2;
    const half = boardHalfWidthAt(cx, s);
    // A pair splits the board, one dot centred in each half.
    for (const off of s.doubleDots.includes(n) ? [-half / 2, half / 2] : [0]) {
      ctx.beginPath();
      ctx.arc(X(cx), Y(off), r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

}

function paintHandPositionBand(ctx, s, X, Y, { lane, now, seat, offered }) {
  // THE ANCHOR: the fret the hand is sitting on, which is where the index stands and
  // what every other finger's number is counted from. Cut into the wood like an inlay
  // — after the inlays and before the frets — because it is a fact about the board
  // under the hand, not a mark on top of it: the wire, the strings and the grip all
  // read over it. The layer's own hue at WASH, which is rule 15's "data you still have
  // to see through", and the same hue the hand is drawn in, because it is the hand.
  //
  // It is the one thing on the neck that says a lone note at fret 8 with a "3" on it
  // is a hand at 6 reaching, and not a hand that walked to 8.
  //
  // THE BAND SAYS WHERE THE HAND IS AND NOT WHO PUT IT THERE. It used to gain an
  // outline in the layer's hue on a beat the player had held, as a second signal that
  // the click landed. That signal now lives where it belongs — the mark at the top of
  // the spectrogram, which says the same thing at every scroll position and without
  // drawing a hard edge round a wash whose whole point is to be soft.
  // TWO HANDS WHEN ONE IS BEING OFFERED, told apart the way the grips are: the hand
  // as it stands is the filled band, fading while something else is considered, and
  // the hand as it WOULD stand — under a hovered shape, or with the override reset —
  // is an outline. Swapping one for the other left nothing to compare against.
  const hue = lane?.color || PAINT.accent;
  const moves = offered > 0 && offered !== seat;
  const anchor = now?.at?.anchor;
  if (anchor) {
    ctx.fillStyle = hexA(hue, (moves ? WASH * 0.6 : WASH) * anchor.opacity);
    fretSpaceBounds(ctx, anchor.x0, anchor.x1, s, X, Y);
    ctx.fill();
  }
  if (moves && offered <= s.frets) {
    ctx.save();
    ctx.strokeStyle = hue; ctx.lineWidth = 1.8; ctx.setLineDash([3, 2]);
    fretSpace(ctx, offered, s, X, Y);
    ctx.stroke();
    ctx.restore();
  }

}

function paintFretboardString(ctx, s, scale, X, Y, i, { lane, now, last }) {
  const held = stringContactAt(now, i);
  const contact = held?.trill?.down ? { ...held, ...held.trill, lift: 0 } : held;
  const end = last + s.overhang, nut = -s.nutDepth;
  const start = contact?.fret > 0 ? contact.x : s.capo ? capoLine(s) : 0;
  const y0 = Y(stringOffsetAt(i + (contact?.lift || 0), Math.max(0, start), s));
  const nutY = Y(stringOffsetAt(i, 0, s)), bridgeY = Y(stringOffsetAt(i, s.scale, s));
  const spacing = Math.abs(stringOffsetAt(1, end, s) - stringOffsetAt(0, end, s)) * scale;
  const preparing = now?.preparations?.find((f) => f.string === i);
  const pull = preparing ? popPreparation(preparing.note, now.t) : 0;
  const moving = now?.moving && contact && !contact.shapeHeld && ((contact.pressed ?? now.at?.pressed) || contact.ringing || contact.releasing);
  const n = contact?.note;
  const kind = !moving ? null : n?.slap === "slap" ? "slap"
    : n?.slap === "tap" ? "tap" : contact.hammerMotion === "hammer" ? "hammer" : null;
  const excitation = kind === "tap" || kind === "hammer" ? contact.start
    : contact ? strikeTime(contact, now?.t) : null;
  const age = excitation == null ? -1 : now.t - excitation;
  const waving = kind === "slap" && age >= 0 && age < 0.24;
  const baseY = (mm) => mm < start
    ? nutY + (y0 - nutY) * (mm - nut) / Math.max(0.001, start - nut)
    : y0 + (bridgeY - y0) * (mm - start) / Math.max(0.001, s.scale - start);
  const popAnchor = preparing ? fretCentre(preparing.fret, s) : start;
  const popX = Math.min(end - 2, Math.max(end - 12, popAnchor + 4));
  const popHeight = (mm) => popLiftAt(mm / s.scale, popX / s.scale, pull, Math.max(0, popAnchor) / s.scale);
  // A projected lift plus a detached shadow makes the depth visible from above.
  const yAt = (mm) => baseY(mm) - spacing * 0.65 * popHeight(mm) + (waving ? spacing * fingerWaveAt(
    (mm - nut) / (end - nut), (start - nut) / (end - nut), age, kind) : 0);
  const trace = (from) => {
    ctx.beginPath(); ctx.moveTo(X(from), yAt(from));
    if (waving || Math.abs(pull) > 0.001) {
      const steps = Math.max(24, Math.min(120, Math.ceil((X(end) - X(from)) / 7)));
      for (let k = 1; k <= steps; k++) {
        const mm = from + (end - from) * k / steps; ctx.lineTo(X(mm), yAt(mm));
      }
    } else {
      if (start > from && start < end) ctx.lineTo(X(start), yAt(start));
      ctx.lineTo(X(end), yAt(end));
    }
  };
  const width = Math.max(1, s.gauges[i] * scale);
  ctx.save(); ctx.lineCap = "round";
  ctx.strokeStyle = hexA(PAINT.label, 0.65); ctx.lineWidth = width;
  if (Math.abs(pull) > 0.001) {
    ctx.save();
    ctx.beginPath(); ctx.moveTo(X(Math.max(0, popAnchor)), baseY(Math.max(0, popAnchor)));
    ctx.lineTo(X(end), baseY(end));
    ctx.strokeStyle = hexA(PAINT.ink, 0.4 * Math.max(0, pull));
    ctx.lineWidth = width + 3 * Math.max(0, pull); ctx.stroke();
    ctx.restore();
    ctx.lineCap = "butt";
    const steps = Math.max(24, Math.min(160, Math.ceil((X(end) - X(nut)) / 5)));
    for (let k = 0; k < steps; k++) {
      const a = nut + (end - nut) * k / steps, b = nut + (end - nut) * (k + 1) / steps;
      const depth = popThicknessAt(Math.max(0, (a + b) / 2) / s.scale, popX / s.scale, pull, Math.max(0, popAnchor) / s.scale) - 1;
      // A little perspective thickening reinforces the projected depth.
      ctx.lineWidth = Math.max(width * 0.45, width + depth * Math.max(width, 2));
      ctx.beginPath(); ctx.moveTo(X(a), yAt(a)); ctx.lineTo(X(b), yAt(b)); ctx.stroke();
    }
  } else { trace(nut); ctx.stroke(); }
  const fingerLight = kind === "hammer" || kind === "tap";
  // Only an open string is struck on the board; a fretted pick pulses its fingertip (drawHand).
  const open = !(contact?.fret > 0);
  const glow = moving && open ? stringGlow(contact, now.t) * (fingerLight ? 0.3 : 1) : 0;
  const pulse = moving && open && !fingerLight ? stringAttackPulse(contact, now.t) : 0;
  if (glow > 0.001 || pulse > 0.001) {
    ctx.lineCap = "round"; trace(start);
    ctx.strokeStyle = hexA(lane.color || PAINT.accent, Math.min(1, glow * 0.3 + pulse * 0.45));
    ctx.lineWidth = width + 3 + pulse * 3; ctx.stroke();
    ctx.strokeStyle = hexA(PAINT.paper, Math.max(glow, pulse));
    ctx.lineWidth = Math.max(1.4, width) + pulse * 1.8; ctx.stroke();
  }
  if ((kind === "hammer" || kind === "tap") && age >= 0 && age < 0.24) {
    ctx.lineCap = "butt";
    const steps = Math.max(32, Math.min(160, Math.ceil((X(end) - X(nut)) / 5)));
    for (let k = 0; k < steps; k++) {
      const a = nut + (end - nut) * k / steps, b = nut + (end - nut) * (k + 1) / steps;
      const light = fingerLightAt(((a + b) / 2 - nut) / (end - nut),
        (start - nut) / (end - nut), age, kind);
      if (light < 0.002 || (kind === "hammer" && b <= start)) continue;
      ctx.beginPath(); ctx.moveTo(X(kind === "hammer" ? Math.max(start, a) : a), baseY(kind === "hammer" ? Math.max(start, a) : a));
      ctx.lineTo(X(b), baseY(b));
      ctx.strokeStyle = hexA(lane.color || PAINT.accent, light * 0.65);
      ctx.lineWidth = width + 5; ctx.stroke();
      ctx.strokeStyle = hexA(PAINT.paper, light);
      ctx.lineWidth = width + 1.5; ctx.stroke();
    }
  }
  ctx.restore();
}

function paintFretNumbers(ctx, s, X, Y, { endHalf, lastFret }) {
  // Fret numbers below the board, on the dotted frets only — a number under
  // every fret is 22 numbers nobody reads. Mono, because a fret number is a
  // value you compare (rule 6). With a capo they count from it, like the tab, unless
  // the player asked for the nut's numbers (Settings → Editor → Fret numbers).
  ctx.fillStyle = PAINT.label;
  ctx.font = stageMono(11);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const fromCapo = s.capo && $("fretNumbering")?.value !== "nut" ? s.capo : 0;
  // One level line under the board's widest end, shared with the hand-position row.
  const numberTop = Math.max(Y(endHalf), Y(-endHalf)) + 5;
  for (const n of s.dots.filter(n => n <= lastFret)) {
    if (n <= fromCapo) continue;
    ctx.fillText(String(n - fromCapo), X(dotCentre(n, s)), numberTop);
  }

}

function syncFretboardWarning(lane, comparing, missingPreview) {
  const warning = $("fretboardWarning");
  const warningTime = comparing && comparisonPreview.note ? comparisonPreview.note.start + 1e-6 : frozenAt(lane) ?? boardTime();
  const here = lane && !missingPreview ? chordWarnings(lane, laneFretTuning(lane), laneFretCount(lane), S.voicingRevision)
    .find(({ t0, notes }) => warningTime >= t0 - 1e-5 && warningTime < Math.max(...notes.map(n => n.end))) : null;
  // Stretched shapes are visible immediately; invalid shapes require opt-in.
  const invalidKey = here?.kind === "impossible" ? `${lane.id}:${here.t0}` : null;
  const impossible = !!invalidKey && !shapeRevealed(lane, invalidKey);
  const selectionError = !comparing && editing && !transportPlaying() ? selectedPositions(lane).error : null;
  const blocked = editing && !transportPlaying() && (!!selectionError || impossible);
  warning.hidden = !selectionError && !here;
  const [shapeTitle, shapeHelp] = SHAPE_WARNINGS[here?.kind] || SHAPE_WARNINGS.impossible;
  warning.textContent = selectionError || (here ? `${here.kind === "stretch" ? "ⓘ" : "⚠"} ${shapeTitle}` : "");
  warning.title = selectionError || shapeHelp;
  warning.toggleAttribute("data-error", here?.kind === "impossible" && !selectionError);
  fretboardShowAnyway.hidden = !impossible || !!selectionError;
  fretboardShowAnyway.dataset.key = invalidKey || "";
  fretboardPanel.toggleAttribute("data-unplayable", impossible);
  return { impossible, blocked };
}

function paintComparisonBoard(ctx, s, scale, X, Y, { lane, missingPreview, strung, tunePx }) {
  board = null; spots = null; activeAlternative = null;
  if (alts) alts.boxes = [];
  const now = missingPreview ? null : handNow(lane, s, comparisonPreview.note.start + 1e-6);
  const index = now ? gripIndex(now.found.columns, now.t) : -1;
  const seat = index >= 0 ? now.found.columns[index].seat : 0;
  paintFretboardNeck(ctx, s, scale, X, Y, { lane, now, seat, offered: 0, strung, tunePx });
  if (now) drawHand(ctx, s, scale, X, Y, lane, now, null, { onion: false });
  fretboardName.textContent = `${comparisonPreview.label} · ${missingPreview ? 'Missing note' : noteName(comparisonPreview.note.pitch)}`;
  fretboardBusy.hidden = missingPreview || !!now;
  if (!now && !missingPreview) fretboardBusyLabel.textContent = 'Loading comparison fingering';
}

function prepareBoardOffers(ctx, s, scale, X, Y, lane, impossible, blocked) {
  // Resolve the selected preview before painting its hand-position band.
  const at = editing ? focusGrip(lane, s) : null;
  board = editing && lane && laneFretTuning(lane).length === s.strings
    ? { lane, s, scale, X, Y, marks: (at?.marks || []).filter((m) => m.note && !m.releasing) } : null;
  const chord = (at?.marks.length || 0) > 1;
  spots = null; if (alts) alts.boxes = [];
  // And the working views stand down with it. They are offers about one column, so a
  // column arriving sixty times a second makes them noise — and the boxes would ask the
  // worker for a fresh set on every one of them.
  const offering = editing && altsOn && !shaping && !transportPlaying() && !impossible && !blocked && !suggestionVisible();
  activeAlternative = null; alternativeCount = 0;
  const chordOffer = offering && chord ? drawAlternatives(ctx, s, scale, X, Y, lane, at) : null;
  const noteOffer = offering && at && !chord ? drawNotePlaces(ctx, s, scale, X, Y, lane, at) : null;
  const hovered = previewAlternative ? chordOffer : null;
  const spot = previewAlternative ? noteOffer : null;
  activeAlternative = (hovered?.hand ? hovered : null) || (spot?.hand ? spot : null);
  fretboardPanel.dataset.alternativeCount = String(activeAlternative ? 1 : 0);
  if (!gripsShown && offering) spots = null;   // hidden rings are not targets either
  return { at, chord, offering, hovered, spot };
}

function syncFretboardBusy(lane, impossible, offering, chord) {
  // An empty board is two different answers and it has to say which. The wait that
  // matters is the lane's fingering — a whole-song DP in a worker, tens of seconds on
  // a big project, during which there is no hand and no readout at all; the column's
  // alternatives are the same question a second later. Blank in either case reads as
  // "there is nothing here", which is what an empty neck means when nothing is
  // playing, so the two states cannot share a picture.
  // Two waits, and they are not the same size, so they do not get the same sentence.
  // The fingering is a whole-song DP in a worker that can run for tens of seconds on
  // a big project with an empty neck the whole time; the alternatives are a few
  // hundred milliseconds over one column, on a board that already has a hand on it.
  // A spinner alone says "not yet" and leaves the user to guess which of those they
  // are in — and the long one is the one worth naming, because it is the one where
  // an unlabelled ring starts to read as stuck.
  // The second wait belongs to the BOXES, and only a chord asks for them: a lone note's
  // circles are arithmetic on this thread and land in the same frame. Without the
  // `chord` here the panel announced a worker run that was never started.
  const waiting = !impossible && lane?.notes?.length
    ? !gripsFor(lane) ? "Working out the fingering"
      : positionPreview?.pending && (previewAlternative || shaping?.preview) ? "Calculating position preview"
        : offering && chord && !alts ? "Finding other positions" : ""
    : "";
  fretboardBusy.hidden = !editing || !waiting;
  if (waiting && fretboardBusyLabel.textContent !== waiting) fretboardBusyLabel.textContent = waiting;
}

function paintHandImpacts(ctx, s, scale, X, Y, { at, t, moving, hue }) {
  // Technique pulses are tied to finger impacts, individually even inside barres.
  if (moving) for (const m of at.marks) {
    if (m.shapeHeld) continue;
    const pulse = fingerPulseAt(m, t);
    if (!pulse || !(m.fret > 0) || !(m.pressed ?? at.pressed)) continue;
    const x = X(m.x), y = Y(stringOffsetAt(m.string + (m.lift || 0), Math.max(0, m.x), s));
    const r = markRadius(m.x, scale, s);
    ctx.save();
    ctx.globalAlpha *= (m.opacity ?? 1) * (m.note?.fx?.ghost ? 0.4 : 1);
    ctx.lineWidth = pulse.kind === "tap" ? 3 : 3.5;
    for (let ring = 0; ring < pulse.rings; ring++) {
      const radius = r * (pulse.radius + ring * 0.45);
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = hexA(hue, pulse.strength * (ring ? 0.65 : 0.9));
      ctx.stroke();
    }
    // A bright, compact impact under the outgoing ripple.
    ctx.beginPath(); ctx.arc(x, y, r * (1.12 + pulse.progress * 0.25), 0, Math.PI * 2);
    ctx.fillStyle = hexA(PAINT.paper, pulse.strength * 0.35); ctx.fill();
    ctx.restore();
  }
  // A picked fretted note: a soft disc of the layer's hue closes in on the fingertip.
  // Filled and contracting, where a technique's rings above are outlined and spread.
  if (moving) for (const m of at.marks) {
    if (m.shapeHeld) continue;
    if (!(m.fret > 0) || !(m.pressed ?? at.pressed) || fingerPulseAt(m, t)) continue;
    const u = fretStrikeAt(m, t);
    if (u == null) continue;
    const x = X(m.x), y = Y(stringOffsetAt(m.string + (m.lift || 0), Math.max(0, m.x), s));
    const r = markRadius(m.x, scale, s), fade = (1 - u) ** 2;
    const fx = m.note?.fx || {};
    ctx.save();
    ctx.globalAlpha *= (m.opacity ?? 1) * (fx.ghost ? 0.4 : fx.accent ? 1 : 0.85);
    ctx.beginPath(); ctx.arc(x, y, r * (2 - u), 0, Math.PI * 2);
    ctx.fillStyle = hexA(hue, 0.45 * fade); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r * (1.35 - 0.35 * u), 0, Math.PI * 2);
    ctx.fillStyle = hexA(PAINT.paper, 0.5 * fade); ctx.fill();
    ctx.restore();
  }
}

function handDisplayMarks(at, moving) {
  // The low finger stays planted. A second finger taps/releases the upper fret;
  // its fill follows the same sixteenth-note phase as the audible trill.
  const marks = at.marks.flatMap((m) => {
    if (!moving && m.slideSpan) return slideEnds(m);
    if (m.graceTarget) return [m, { ...m, ...m.graceTarget, noteLabel: false, lift: 0, pressed: false, opacity: 0.55 }];
    if (m.graceOrigin) return [{ ...m, ...m.graceOrigin, noteLabel: false, lift: 0 }, m];
    if (m.trill) return [m, { ...m, ...m.trill, noteLabel: false, trill: undefined, lift: 0, pressed: m.trill.down,
      opacity: m.trill.down ? 1 : 0.55 }];
    const extra = m.hammerSupport || m.hammerTarget;
    if (extra && moving) return [{ ...m, ...extra, noteLabel: false, lift: 0 }, m];
    return [m];
  });
  return marks;
}

function paintHeldHandContacts(ctx, s, scale, X, Y, at) {
  if (at.gripMarks) for (const mark of at.marks) {
    if (mark.shapeHeld || mark.releasing) continue;
    const contact = at.gripMarks.find(contact => contact.string === mark.string);
    if (!contact) continue;
    const x = X(contact.x), y = Y(stringOffsetAt(contact.string, Math.max(0, contact.x), s));
    const radius = markRadius(contact.x, scale, s) * 1.2;
    ctx.save(); ctx.globalAlpha *= .85;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = PAINT.paper; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
  }
}

function paintFretboardNeck(ctx, s, scale, X, Y, { lane, now = null, seat = 0, offered = 0, strung = null, tunePx = 11, lastFret = s.frets }) {
  const last = fretDistance(lastFret, s.scale);
  const nutHalf = boardHalfWidthAt(0, s), endHalf = boardHalfWidthAt(last, s);

  // The slab: parallel behind the nut, tapered to the last fret, parallel again
  // over the overhang.
  ctx.fillStyle = PAINT.chrome;
  ctx.beginPath();
  ctx.moveTo(X(-s.nutDepth), Y(-nutHalf));
  ctx.lineTo(X(0), Y(-nutHalf));
  ctx.lineTo(X(last), Y(-endHalf));
  ctx.lineTo(X(last + s.overhang), Y(-endHalf));
  ctx.lineTo(X(last + s.overhang), Y(endHalf));
  ctx.lineTo(X(last), Y(endHalf));
  ctx.lineTo(X(0), Y(nutHalf));
  ctx.lineTo(X(-s.nutDepth), Y(nutHalf));
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = PAINT.line; ctx.lineWidth = 1; ctx.stroke();

  paintNeckInlays(ctx, s, scale, X, Y, lastFret);
  paintHandPositionBand(ctx, s, X, Y, { lane, now, seat, offered });
  // Frets: nickel, and the brightest thing after the nut because they are what
  // the eye measures the board by.
  ctx.fillStyle = hexA(PAINT.label, 0.6);
  for (let n = 1; n <= lastFret; n++) {
    const d = fretDistance(n, s.scale), half = boardHalfWidthAt(d, s);
    ctx.fillRect(X(d) - (s.fretCrown * scale) / 2, Math.min(Y(-half), Y(half)),
      Math.max(1, s.fretCrown * scale), half * 2 * scale);
  }

  // The nut is bone: lighter than the wire, and the only part of this that is
  // not metal.
  ctx.fillStyle = PAINT.text;
  ctx.fillRect(X(-s.nutDepth), Math.min(Y(-nutHalf), Y(nutHalf)), s.nutDepth * scale, nutHalf * 2 * scale);

  // The wood behind a capo is out of play: dimmed under the strings, so they still
  // read as running to the nut.
  if (s.capo) {
    ctx.fillStyle = hexA(PAINT.ink, 0.35);
    const x1 = capoLine(s), h0 = boardHalfWidthAt(0, s), h1 = boardHalfWidthAt(x1, s);
    ctx.beginPath();
    ctx.moveTo(X(0), Y(-h0)); ctx.lineTo(X(x1), Y(-h1)); ctx.lineTo(X(x1), Y(h1)); ctx.lineTo(X(0), Y(h0));
    ctx.closePath(); ctx.fill();
  }

  // Hand-driven waves are intentional technique cues. Ordinary picks only
  // brighten the string, including sustain beyond the authored note's end.
  for (let i = 0; i < s.strings; i++) paintFretboardString(ctx, s, scale, X, Y, i, { lane, now, last });

  paintBoardCapo(ctx, s, scale, X, Y);

  paintFretNumbers(ctx, s, X, Y, { endHalf, lastFret });
  // The tuning, at the nut, where a player looks for it — it is the one thing the
  // drawn instrument cannot state, and without it fret 5 on the top string names no
  // pitch at all. Right-aligned against the nut, and mono because a pitch is a
  // value (rule 6), in the same tier as the fret numbers because it does the same
  // job: annotating the board rather than being part of it.
  if (strung) paintBoardTuning(ctx, s, X, Y, strung, tunePx);
}

let suggestion = null;
const suggestionVisible = () => !!suggestion?.differs && $("fretboardSuggestion").checked;

function hideSuggestion() {
  suggestion?.controller.abort();
  suggestion = null;
  $("fretboardSuggestion").checked = false;
  $("fretboardSuggestionLabel").hidden = true;
  $("fretboardResetStatus").hidden = true;
}

function syncSuggestion(lane, s) {
  const at = lane && gripsFor(lane) && handColumnHere(lane);
  if (!editing || !canEditLane(lane) || transportPlaying() || shaping
      || fretboardPanel.hasAttribute("data-edit-blocked") || selectedPositions(lane).multiple || !at) {
    if (suggestion) hideSuggestion();
    return;
  }
  const key = `${handKey(lane)}:${at.column.start}:${songBarStarts().join(',')}`;
  if (suggestion?.key === key) return;
  hideSuggestion();
  const column = chordColumns(lane.notes).find(column => Math.abs(column.t0 - at.column.start) < 1e-6);
  if (!column) return;
  const preview = suggestionLane(lane, column.notes);
  if (!preview) return;
  const controller = new AbortController(), vkey = handKey(lane);
  const request = { key, controller, differs: false, preview: null };
  suggestion = request;
  laneFingering(preview, controller.signal).then(found => {
    if (controller.signal.aborted || suggestion !== request || handKey(lane) !== vkey) return;
    const columns = gripsFrom(found), index = gripIndex(columns, at.column.start);
    const pose = index >= 0 ? handAt(columns, at.column.start, 0, s, false) : null;
    request.preview = pose ? { marks: pose.marks, seat: columns[index].seat } : null;
    request.differs = suggestionDiffers({ marks: focusGrip(lane, s)?.marks || [], seat: anchorFret(lane) }, request.preview);
    $("fretboardSuggestionLabel").hidden = !request.differs;
    drawFretboard();
  }).catch(() => {});
}

function drawSuggestion(ctx, s, scale, X, Y, lane) {
  const shown = suggestionVisible(), status = $("fretboardResetStatus");
  status.hidden = !shown;
  if (!shown) return;
  const { marks, seat } = suggestion.preview;
  status.classList.remove("busy");
  // Counted from where a slide-in goes down, like the hand row and the band.
  const hand = seat ? Math.max(1, seat + (handColumnHere(lane)?.shift || 0)) : 0;
  status.textContent = hand ? `Suggested hand: ${hand}` : "Suggested position";
  ctx.save(); ctx.setLineDash([4, 3]);
  drawPreviewGrip(ctx, s, scale, X, Y, marks, lane.color || PAINT.accent, false);
  ctx.restore();
}

// The numbers are real buttons, aligned to the exact fret boundaries of the
// canvas on one level line under the board. They stay invisible over the
// canvas fret numbers until the pointer or focus enters the row.
function drawHandPositions(s, X, Y, lane) {
  const row = $("fretboardHandPositions"), at = lane && handColumnHere(lane);
  // A slide-in's buttons count from where the finger goes down (see slideInShift).
  const shift = at?.shift || 0;
  const choices = new Set((at?.choices || []).map((c) => c + shift).filter((c) => c >= 1));
  const shown = editing && !shaping && !transportPlaying() && !!at && choices.size > 0
    && !fretboardPanel.hasAttribute("data-edit-blocked") && !selectedPositions(lane).multiple;
  row.hidden = !shown;
  if (!shown) {
    if (row.contains(document.activeElement)) document.activeElement.blur();
    handPeek = null; return false;
  }
  if (handPeek != null && !at.choices.includes(handPeek)) handPeek = null;
  row.style.setProperty('--hand-hue', lane.color || PAINT.accent);
  row.setAttribute('aria-description', `Available hand positions: ${[...choices].join(', ')}`);
  const count = laneFretCount(lane), held = holdHere(lane), seat = (Number(at.column.seat) || 0) + shift;
  if (row.dataset.count !== String(count)) {
    row.dataset.count = String(count);
    row.replaceChildren(...Array.from({length: count + 1}, (_, fret) => {
      const button = document.createElement('button');
      button.type = 'button'; button.setAttribute('role', 'radio');
      button.dataset.value = fret ? String(fret) : 'auto';
      return button;
    }));
  }
  const capo = s.capo || 0, fromNut = $("fretNumbering")?.value === 'nut';
  const endHalf = boardHalfWidthAt(fretDistance(s.frets, s.scale), s);
  const top = Math.max(Y(endHalf), Y(-endHalf)) + 1;
  for (const button of row.children) {
    const fret = button.dataset.value === 'auto' ? 0 : Number(button.dataset.value);
    const left = fret ? X(fretDistance(capo + fret - 1, s.scale)) : X(fretDistance(capo, s.scale)) - 42;
    const right = fret ? X(fretDistance(capo + fret, s.scale)) : left + 38;
    button.style.left = `${left}px`; button.style.top = `${top}px`;
    button.style.width = `${right - left}px`;
    const allowed = !fret || choices.has(fret), chosen = fret ? !!held && Number(held.fret) + shift === fret : !held;
    button.disabled = !canEditLane(lane) || !allowed;
    button.textContent = fret ? String(fret + (fromNut ? capo : 0)) : 'Auto';
    button.setAttribute('aria-label', fret ? `Hand position ${fret}${allowed ? '' : ', unavailable'}` : 'Automatic hand position');
    button.setAttribute('aria-checked', String(chosen));
    button.tabIndex = chosen ? 0 : -1;
    button.title = fret ? `Hand position ${fret}${allowed ? '' : ' cannot play these notes'}` : 'Use the automatic hand position';
    button.classList.toggle('is-allowed', !!fret && allowed);
    button.classList.toggle('is-current', fret === seat);
    button.classList.toggle('is-suggested', suggestionVisible() && fret === (suggestion.preview.seat || 0) + shift);
  }
  return true;
}

function initHandPositions() {
  const row = $("fretboardHandPositions");
  row.addEventListener('click', event => {
    const button = event.target.closest('[data-value]'), lane = currentLane();
    if (!button || button.disabled || !editing || !canEditLane(lane) || transportPlaying()
        || shaping || selectedPositions(lane).multiple) return;
    const at = handColumnHere(lane), time = handTimeHere(lane);
    if (!at) return;
    const value = button.dataset.value === 'auto' ? null : Number(button.dataset.value) - at.shift;
    if (value !== null && !at.choices.includes(value)) return;
    // Changing only the hand keeps these legal positions valid while its worker
    // refingers the lane. Retain the row and its keyboard focus during that wait.
    pendingHandColumn = { lane, notes: lane.notes, focus: focusNote(lane),
      revision: S.voicingRevision + 1, at };
    handPeek = null;
    setHandAnchor(lane, time, value);
    drawFretboard();
  });
  row.addEventListener('mouseover', event => {
    const button = event.target.closest('[data-value]');
    const value = button && !button.disabled && button.dataset.value !== 'auto'
      ? Number(button.dataset.value) - (handColumnHere(currentLane())?.shift || 0) : null;
    if (handPeek !== value) { handPeek = value; drawFretboard(); }
  });
  row.addEventListener('mouseleave', () => { handPeek = null; drawFretboard(); });
}

export function drawFretboard() {
  if (editorEl.hidden || !S.state) return;
  const ctx = fretboardEl.getContext("2d");
  // Folded, the board is not worked out at all: the strip keeps its last picture
  // under the frost, and only a peek (the pointer over it) brings it up to date.
  // Another project's picture is wiped rather than kept.
  if (!visible && !fretboardPanel.classList.contains("is-peeking")) {
    if (foldedState !== S.state) { foldedState = S.state; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, fretboardEl.width, fretboardEl.height); }
    return;
  }
  foldedState = S.state;
  const dp = dpr(), w = fretboardEl.width / dp, h = fretboardEl.height / dp;
  ctx.setTransform(dp, 0, 0, dp, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // The lane whose hand this is, and its open strings. A lane whose tuning has
  // another string count than its instrument's neck gets the instrument and nothing
  // else, so its tuning is not drawn either.
  const lane = currentLane();
  const comparing = !!comparisonPreview && comparisonPreview.lane === lane && (!comparisonPreview.note || lane?.notes.includes(comparisonPreview.note));
  const missingPreview = comparing && !comparisonPreview.note;
  const { impossible, blocked } = syncFretboardWarning(lane, comparing, missingPreview);
  if (fretboardPanel.hasAttribute("data-edit-blocked") !== blocked) {
    fretboardPanel.toggleAttribute("data-edit-blocked", blocked);
    layoutFretboard(); return;
  }
  // Whether the player put the hand on this beat. Hoisted because holdHere walks
  // songBarStarts(), which rebuilds the bar list on every call, and this runs per frame.
  const held = holdHere(lane);
  const s = laneSpec(lane);
  // A different instrument is a different board shape, so the panel is the wrong
  // height until the layout has seen it. One bounce: layoutFretboard draws again.
  if (s !== laidOut) { layoutFretboard(); return; }
  const tuning = lane ? laneTuning(lane) : null;
  // How much room a name beside a string has, measured off the scale the board would
  // take with no gutter — within a few percent of the real one, which is circular,
  // and this only has to choose between three sizes. A string at the nut is a pitch
  // row, so it gets rule 6's anchored 9 when 11 will not fit, and nothing when 9
  // will not either: the same "drop the label too wide for its note" the stage does.
  const disabled = comparing || !editing || !canEditLane(lane) || transportPlaying();
  updateChordField(lane, disabled);
  const projection = boardProjection(ctx, s, w, h - 12, tuning);
  if (!projection) return;
  const { scale, X, Y, strung, tunePx } = projection;
  if (comparing) {
    paintComparisonBoard(ctx, s, scale, X, Y, { lane, missingPreview, strung, tunePx });
    return;
  }
  const { at, chord, offering, hovered, spot } = prepareBoardOffers(ctx, s, scale, X, Y, lane, impossible, blocked);
  const now = impossible || shaping ? null : handNow(lane, s);
  syncSuggestion(lane, s);
  drawHandPositions(s, X, Y, lane);
  // A slide-in's hand is drawn where the finger goes down, like the moving band.
  const slideIn = (editing && handColumnHere(lane)?.shift) || 0;
  const seat = anchorFret(lane) + slideIn, offered = impossible || !offeredSeat(lane) ? 0 : offeredSeat(lane) + slideIn;
  paintFretboardNeck(ctx, s, scale, X, Y, { lane, now, seat, offered, strung, tunePx });

  // WHICH GRAIN IS DECIDED BY THE COLUMN, not by a second switch. A lone note has one
  // question — which string — and every answer to it is legal, so it gets circles and
  // no boxes: a box drawn around a single circle says nothing. A chord's question is
  // the COMBINATION, and most combinations are not playable, so it gets the boxes the
  // engine vouched for and no free per-note circles. Building a combination nobody
  // vouched for is what the shape walk is for, and it is a mode you ask for.
  if (blocked) {
    spots = null; activeAlternative = null;
    hideSuggestion();
    fretboardBusy.hidden = true;
    return;
  }
  const placing = shaping && !impossible ? drawShaping(ctx, s, scale, X, Y, lane) : null;
  // Something else is on offer: the grip in the hand steps back. See drawHand.
  if (!shaping) drawHand(ctx, s, scale, X, Y, lane, now, hovered || spot || suggestionVisible() ? "fade" : null);
  drawBundle(ctx, s, scale, X, Y, lane, held, w, h, chord, placing, impossible);
  if (offering && at && !chord && gripsShown) drawNoteRings(ctx, lane);
  if (offering && chord && gripsShown) drawChordBoxes(ctx, lane);
  drawSuggestion(ctx, s, scale, X, Y, lane);
  if (hovered) drawOffer(ctx, s, scale, X, Y, hovered, lane);
  if (spot) drawNoteOffer(ctx, s, scale, X, Y, lane, spot);
  if (noteDrag?.to) drawDragTarget(ctx, s, scale, X, Y, lane);
  else if (boardHover && !noteDrag && spotHover < 0 && hoverAt < 0) drawBoardHover(ctx, s, scale, X, Y, lane);
  syncFretboardBusy(lane, impossible, offering, chord);
}

// The column under the hand, when it carries an override of any kind. Same focus the
// offer uses, so the strip is always talking about the grip the heading names, and
// the same test the note menu applies, so the two never disagree about whether a
// column has something to return from.
function pinnedColumn(lane) {
  const note = focusNote(lane);
  if (!note) return null;
  const col = columnOf(note)?.col;
  return col?.notes.some((n) => n.pos || n.arrangement || n.written) ? col : null;
}

// Reserve room for the controls only in edit mode, below the strings.
function drawBundle(ctx, s, scale, X, Y, lane, held, width, height, chord, placing, unplayable = false) {
  const playing = transportPlaying();
  const shown = editing;
  fretboardPin.hidden = !shown;
  if (!shown) { hideSuggestion(); return; }
  // Columns sounding at once (a held note under a moving line): which one is selected.
  const voices = !playing && !shaping && lane ? soundingColumns(lane.notes, boardTime()) : [];
  const voice = voices.findIndex(c => c.notes.some(n => S.selection.has(n)));
  $("fretboardVoices").hidden = voices.length < 2;
  $("fretboardVoiceCount").textContent = `${voice < 0 ? "–" : voice + 1} / ${voices.length}`;
  $("fretboardVoiceDown").disabled = voice === 0;
  $("fretboardVoiceUp").disabled = voice === voices.length - 1;
  const group = selectedPositions(lane);
  const column = (editing) && !shaping && !playing ? pinnedColumn(lane) : null;
  const selectedOverride = group.multiple && !group.error
    && group.columns.some(c => c.notes.some(n => n.pos || n.arrangement || n.written));
  const overridden = (editing) && !shaping && !playing
    && (group.multiple ? selectedOverride : !!column || !!held);
  // While a shape is being built the bundle names the note being placed, which is
  // the one thing you need to know and the reason no sentence says what to do.
  fretboardName.hidden = !placing;
  if (placing) fretboardName.textContent = `${shaping.index + 1} / ${shaping.notes.length} · ${noteName(placing.pitch)}`;
  $("fretboardShapeNotes").hidden = !shaping;
  $("fretboardShapePrev").disabled = !shaping || shaping.index === 0;
  $("fretboardShapeNext").disabled = !shaping || shaping.index === shaping.notes.length - 1;
  // Chords only: a lone note has every position on the board already.
  fretboardShape.hidden = !(editing) || playing || (!chord && !shaping);
  $("fretboardFingerReset").hidden = !editing || playing || !!shaping || unplayable || !(focusGrip(lane, s)?.marks || []).some((m) => m.note?.finger != null);
  fretboardShape.title = shaping ? "Discard custom shape" : unplayable ? "This chord cannot be played on this neck"
    : group.error || "Place every note of the chord by hand";
  fretboardShape.disabled = unplayable || !!group.error;
  fretboardApply.hidden = !shaping;
  fretboardApply.disabled = !shaping || shaping.picked.size !== shaping.notes.length || !shaping.preview?.hand
    || (group.multiple && !sharedShapeAllowed(lane, shaping.notes, shaping.picked));
  fretboardAuto.hidden = !overridden;

}

// The grip, on top of everything. A finger holding a note down is a disc filled in
// **the layer's own colour** — the same hue as its notes on the stage and its dot in
// the sidebar, so all three refer to the object the same way. It was --stage-accent
// first, on the grounds that a pressed string is "checked"; it is not. Nothing
// selected it, and accent said the same thing about every layer, which is the one
// thing a marker on a neck must not do when the sidebar is holding six of them.
// A finger on its way to the next grip is the same disc outlined in that hue, which
// is the button spec's own filled-versus-outlined idiom and not a size change. The
// one exception is a finger that appears from nowhere: it grows in from small, so
// an arriving note never looks like a leaving one fading out.
//
// Outlined rather than a second grey fill because the first build made a
// travelling finger a --stage-label disc, and an inlay is a --stage-hint disc of
// almost the same diameter one tier away — two filled grey circles on one board,
// and you could not tell the hand from the dots in the wood.
//
// The one thing the marker's position cannot say is *when* the note was struck: a
// chord held for two bars and a chord re-struck every beat put identical discs on
// identical frets. So an attack blooms a ring out of the marker and fades it, which
// is the only moving part on the board that is about time rather than place.
//
// One finger across several strings at one fret is a barre, and it is one object, so
// it is one path: a capsule instead of a disc, with the finger written once at its
// middle. Two discs labelled 1 say "finger 1 twice", which is not a thing a hand can
// do — the bar is what says they are held by the same finger.

// Marker size follows the space between strings; candidate shapes use the same
// dimensions. Pitch labels sit separately so the finger contacts keep their size.
const markRadius = (mm, scale, s) =>
  (Math.abs(stringOffsetAt(1, mm, s) - stringOffsetAt(0, mm, s)) * 0.9 * scale) / 2;

// A capsule from y0 to y1, and a plain circle when they coincide, out of the same
// two half-arcs: the top half around y0, the bottom half around y1, joined. One
// path serves the disc and the bar, so fill and stroke need no second code path.
function markPath(ctx, x, y0, y1, r) {
  ctx.beginPath();
  ctx.arc(x, y0, r, Math.PI, 0);
  ctx.arc(x, y1, r, 0, Math.PI);
  ctx.closePath();
}

// An open string rings end to end in the grip's colour. Its pitch label is drawn
// separately beside the current grip, without a finger number. Under the marks, because a
// barre at fret 1 sits over the string it is sounding.
//
// Wider than the wire it covers, by a hair: at the top string's real gauge the glow
// would be a 1px line, and 1px of hue on 1px of nickel is not a signal.
function glowString(ctx, s, scale, X, Y, i, hue) {
  const end = fretDistance(s.frets, s.scale) + s.overhang;
  const start = s.capo ? capoLine(s) : 0;    // the sounding length starts at the nut/capo
  ctx.strokeStyle = hue;
  ctx.lineWidth = Math.max(1.5, s.gauges[Math.round(i)] * scale);
  ctx.beginPath();
  ctx.moveTo(X(start), Y(stringOffsetAt(i, Math.max(0, start), s)));
  ctx.lineTo(X(end), Y(stringOffsetAt(i, end, s)));
  ctx.stroke();
}

// The glyph on a filled marker: --on-accent's job, done for a colour the design
// system does not own. The layer's hue is the user's — the palette's six are pale
// and a dark one is a click away — so the digit takes whichever end of the stage's
// own palette can be read on it, at the perceived-brightness midpoint.
function onHue(hex) {
  const v = parseInt(hex.slice(1), 16);
  const lum = ((v >> 16 & 255) * 299 + (v >> 8 & 255) * 587 + (v & 255) * 114) / 1000;
  return lum > 128 ? PAINT.ink : PAINT.paper;
}

// One grip, drawn: the hand's own, or a candidate under the pointer. Filled means the
// hand is holding it; outlined means it is not — travelling, or on offer.
//
// Finger numbers stay inside the contacts. Pitch labels replace those contacts
// in names-only mode and sit beside them in Both. Open labels are centered text.
const fretboardLabels = () => {
  const mode = document.querySelector('input[name="fretboardLabels"]:checked')?.value || "both";
  return mode;
};

function drawGrip(ctx, s, scale, X, Y, marks, hue, filled, { digits = true, time = null, liveStrings = false, labels = null } = {}) {
  const mode = labels ?? (digits ? fretboardLabels() : "none");
  const showFingers = digits && (mode === "fingers" || mode === "both");
  for (const m of marks) if (!(m.fret > 0) && !m.dead && !m.shapeHeld && !liveStrings) {
    ctx.save(); ctx.globalAlpha *= (m.opacity ?? 1) * (m.note?.fx?.ghost ? 0.4 : 1);
    glowString(ctx, s, scale, X, Y, m.string, hue); ctx.restore();
  }
  // EVERY fretted mark carries its finger, a lone note included. It used not to, on
  // the grounds that one fretted note is finger 1 by definition and a mark that never
  // varies states nothing — and the first half of that was simply wrong. It is only
  // true of a fingering derived from one shape in isolation, which is what the board
  // used to read. The hand the voicer actually walks arrives seated somewhere, so a
  // single note at fret 8 is the index if the hand walked up to it and the pinky if it
  // is sitting at 5 holding the phrase. That digit is the difference between a
  // position the engine chose and a stretch it chose, and it varies.
  ctx.font = stageMono(STAGE_ANCHORED, 600);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1.8;
  const contacts = marks.filter(m => (m.fret > 0 || m.dead) && !(mode === "notes" && gripPitchLabel(m)));
  const groups = [true, false].flatMap(held => barreGroups(contacts.filter(m => !!m.shapeHeld === held), filled));
  for (const g of groups) {
    const pts = g.map((m) => ({
      m, x: X(m.x), y: Y(stringOffsetAt(m.string + (m.lift || 0), Math.max(0, m.x), s)),
      r: markRadius(m.x, scale, s),
    }));
    const x = pts[0].x, r = pts[0].r * (g[0].grow ?? 1);
    ctx.save();
    const ghost = !!g[0].note?.fx?.ghost;
    ctx.globalAlpha *= (g[0].opacity ?? 1) * (ghost ? 0.4 : 1);
    const pressed = g[0].pressed ?? filled;
    ctx.font = stageMono(STAGE_ANCHORED, 600);
    const ys = pts.map((p) => p.y), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (g[0].note?.harmonic === "natural") {
      const cy = (y0 + y1) / 2;
      ctx.beginPath(); ctx.arc(x, cy, r * 0.85, 0, Math.PI * 2);
      ctx.strokeStyle = hue; ctx.lineWidth = Math.max(2, r * 0.3); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, cy, r * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = hue; ctx.fill();
      ctx.restore(); continue;
    }
    if (pressed) {
      markPath(ctx, x, y0, y1, r);
      ctx.fillStyle = hue;
      ctx.fill();
      if (g.some((p) => p.note?.fx?.accent)) {
        ctx.fillStyle = hexA(PAINT.paper, 0.3); ctx.fill();
        markPath(ctx, x, y0, y1, r + 2);
        ctx.strokeStyle = PAINT.paper; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.fillStyle = onHue(hue);
    } else {
      // 1.8 is the app's icon stroke, in CSS px: the marker annotates the board
      // rather than sitting on it, so it is sized like the fret numbers and not
      // in millimetres like the wire and the strings.
      markPath(ctx, x, y0, y1, Math.max(1, r - 0.9));
      ctx.strokeStyle = hue;
      ctx.stroke();
      ctx.fillStyle = hue;
    }
    // What the marker says, in the notation the tab already writes (rule 25): the
    // effect's own glyph for a dead note, otherwise the finger. Written once per body,
    // at its middle, and dropped when the body is narrower than the glyph, as the
    // stage drops a note label too wide for its note.
    let glyph = !digits ? "" : g[0].dead ? FX_GLYPHS.dead : g[0].note?.harmonic === "pinch" ? "✦"
      : showFingers ? fingerLabel(g[0].finger, "") : "";
    if (ghost && glyph && !g[0].dead) {
      glyph = `(${glyph})`;
      ctx.font = stageMono(STAGE_ANCHORED * 0.8, 600);
    }
    if (glyph && r >= STAGE_ANCHORED / 2) ctx.fillText(glyph, x, (y0 + y1) / 2 + 0.5);
    ctx.restore();
  }
  if (mode === "notes" || mode === "both") drawGripNoteNames(ctx, s, scale, X, Y, marks, hue, true, mode === "notes");
}

// The real instrument, cropped after fret 12; its physical taper stays unchanged.
export function drawFretboardSettingsPreview(time = 0) {
  const canvas = $("fretboardSettingsPreview");
  if (!canvas) return;
  const lane = currentLane() || { instrument: "electric", capo: 2, color: PAINT.ok };
  const s = laneSpec(lane), tuning = currentLane() ? laneTuning(lane) : [64, 59, 55, 50, 45, 40];
  const width = Math.max(260, canvas.clientWidth || 420), height = canvas.clientHeight || 164, dp = dpr();
  canvas.width = Math.round(width * dp); canvas.height = Math.round(height * dp);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dp, 0, 0, dp, 0, 0);
  ctx.fillStyle = PAINT.ground; ctx.fillRect(0, 0, width, height);
  const lastFret = Math.min(12, s.frets);
  const projection = boardProjection(ctx, s, width, height, tuning, lastFret);
  if (!projection) return;
  const { scale, X, Y, strung, tunePx } = projection;
  const animate = $("fretboardAnimations").checked;
  const { columns, duration } = fretboardPreviewPhrase(tuning, s.capo || 0, lastFret);
  const t = ((time % duration) + duration) % duration;
  const found = { columns, playableColumns: columns };
  const now = { found, t, moving: animate, at: handAt(columns, t, animate ? .25 : 0, s, animate),
    ringing: [], releases: [], preparations: [] };
  const seat = columns[gripIndex(columns, t)]?.seat || 0;
  paintFretboardNeck(ctx, s, scale, X, Y, { lane, now, seat, strung, tunePx, lastFret });
  drawHand(ctx, s, scale, X, Y, lane, now, null, { onion: true });
}

// A quiet, borderless pitch label beside each contact. Open strings follow the
// lowest fretted contact rather than leaving their names behind at the nut.
function gripPitchLabel(mark) {
  const writtenPitch = mark.pitch ?? mark.note?.pitch;
  const pitch = writtenPitch + (mark.graceTarget ? mark.fret - mark.graceTarget.fret : 0);
  return Number.isFinite(pitch) && !mark.dead && !mark.releasing && mark.noteLabel !== false ? noteName(pitch) : "";
}

function drawGripNoteNames(ctx, s, scale, X, Y, marks, hue, followOpen = true, replaceContact = false) {
  ctx.save();
  ctx.font = stageMono(STAGE_ANCHORED, 400);
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const contacts = marks.filter(mark => mark.fret > 0 && gripPitchLabel(mark));
  const openX = contacts.length ? Math.min(...contacts.map(mark => mark.x)) : fretCentre(1, s);
  for (const mark of marks) {
    const text = gripPitchLabel(mark);
    if (!text) continue;
    const mm = mark.fret > 0 || !followOpen ? mark.x : openX;
    const x = X(mm), y = Y(stringOffsetAt(mark.string + (mark.lift || 0), Math.max(0, mm), s));
    const radius = markRadius(mm, scale, s);
    const width = ctx.measureText(text).width + 8;
    const height = Math.max(STAGE_ANCHORED + 1, Math.min(STAGE_ANCHORED + 4, 2 * radius));
    const open = !(mark.fret > 0), filled = replaceContact && !open;
    let left = replaceContact || open ? x - width / 2 : x + radius + 3;
    if (!replaceContact && !open && left + width > ctx.canvas.width / dpr() - 4) left = x - radius - 3 - width;
    ctx.save();
    ctx.globalAlpha *= (mark.opacity ?? 1) * (mark.note?.fx?.ghost ? 0.4 : 1);
    if (filled) {
      ctx.beginPath(); ctx.roundRect(left, y - height / 2, width, height, 3);
      ctx.fillStyle = hue; ctx.fill();
    } else {
      // Clear the string immediately behind the letters without a label box.
      ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.strokeStyle = PAINT.chrome;
      ctx.strokeText(text, left + width / 2, y + 0.5);
    }
    ctx.fillStyle = filled ? onHue(hue) : PAINT.text;
    ctx.fillText(text, left + width / 2, y + 0.5);
    ctx.restore();
  }
  ctx.restore();
}

// Where a set of marks is, ignoring which finger goes there and in what order —
// handColumns computes the same string for the same reason, and for a candidate it is
// what says "this is the grip you already have".
const placeKey = (positions) =>
  positions.map((p) => `${p.string}:${p.fret}`).sort().join(" ");

// Filter and rank all candidates, but expose only the selected box to painting
// and hit testing. Browsing never mutates the current fingering.
function drawAlternatives(ctx, s, scale, X, Y, lane, held) {
  const note = focusNote(lane);
  const found = note && altsFor(note);
  if (!found || found.lane !== lane || found.tuning.length !== s.strings) return null;
  // The shape the hand is already in is not another position. The worker enumerates
  // it like any other (nothing tells it what is current — see columnAlternatives), so
  // it is dropped here, against the grip the board is actually drawing: one box
  // fewer, and no box around the filled marks, which is what separates where you are
  // from what you are being offered.
  const heldKey = held ? placeKey(held.marks) : "";
  const boxes = [];
  const limits = limitsFor(lane, found.notes?.[0]);
  const shared = selectedPositions(lane).multiple;
  const choices = [...(found.ranked || [])];
  if (shared) {
    const voiced = gripsFor(lane)?.voiced;
    const shape = new Map(found.notes.flatMap(n => voiced?.get(n) ? [[n, voiced.get(n)]] : []));
    if (shape.size === found.notes.length && !choices.some(c => placeKey([...c.shape.values()]) === placeKey([...shape.values()])))
      choices.unshift({ notes: found.notes, shape, seat: anchorFret(lane) });
  }
  for (const choice of choices) {
    const positions = [...choice.shape.values()];
    if (!shared && placeKey(positions) === heldKey) continue;
    if (shared) {
      const shape = new Map(found.notes.map((note, k) => [note, choice.shape.get(choice.notes[k])]));
      if (!sharedShapeAllowed(lane, found.notes, shape)) continue;
    }
    if (!shared && choice.notes.some((voice, k) => {
      const p = choice.shape.get(voice), note = found.notes[k];
      return p && note && placementFault(limits?.get(note), note.pitch, p.string, found.tuning, s.frets);
    })) continue;
    const b = gripBox(positions, scale, s, X, Y);
    if (b) boxes.push({ choice, ...b });
  }
  const box = selectAlternative(`chord:${lane.id}:${found.note?.id}:${found.rev}:${sharedSelection.key}`, boxes);
  // Clicking the area around the chord opens every alternative as a box (as in
  // 0.3.0): hover previews one, click takes it. Painted by drawChordBoxes.
  const area = held && gripBox(held.marks, scale, s, X, Y);
  found.boxes = boxes;
  found.hover = alternativeIndex;
  if (!box) return null;
  const shape = new Map(found.notes.map((n, k) => [n, box.choice.shape.get(box.choice.notes[k])]));
  const preview = previewAlternative ? previewPosition(lane, found.notes, shape, "chord") : null;
  return { box, tuning: found.tuning, preview, hand: preview?.hand || null };

}

// A grip's area on screen, padded by a marker so the border holds the shape.
function gripBox(positions, scale, s, X, Y) {
  const mm = shapeBox(positions, s);
  if (!mm) return null;
  const pad = markRadius(mm.x1, scale, s) + 3;
  return { x0: X(mm.x0) - pad, x1: X(mm.x1) + pad,
    y0: Math.min(Y(mm.off0), Y(mm.off1)) - pad, y1: Math.max(Y(mm.off0), Y(mm.off1)) + pad };
}

// The bar's Name field: the chord's name as text, and Auto when it is not the
// automatic one. A lone note has no name to give, so the field is not there.
function updateChordField(lane, disabled) {
  const chord = chordAtBoard(lane), input = $("fretboardChordInput");
  chordShown = chord;
  $("fretboardChordField").hidden = !chord;
  if (document.activeElement !== input) input.value = chord?.name || "";
  input.placeholder = chordLabel(chord) || "Name";
  input.disabled = disabled || !chord;
  $("fretboardChordAuto").hidden = !chord?.own || !chord.auto;
}

function drawChordBoxes(ctx, lane) {
  ctx.lineWidth = 1.8;
  (alts?.boxes || []).forEach((b, i) => {
    ctx.strokeStyle = i === alternativeIndex ? (lane.color || PAINT.accent) : PAINT.hint;
    ctx.beginPath();
    ctx.roundRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 8);
    ctx.stroke();
  });
}

// The selected alternative is filled in the layer's hue over the dim original.
function drawOffer(ctx, s, scale, X, Y, hovered, lane) {
  const { choice } = hovered.box;
  if (!hovered.hand) return;
  const marks = choice.notes.flatMap((n) => {
    const p = choice.shape.get(n);
    return p ? [{
      string: p.string, fret: p.fret,
      pitch: n.pitch,
      finger: hovered.hand.byString.get(p.string) ?? NO_FINGER,
      dead: !!n.dead, x: fretCentre(p.fret, s), note: n,
      slideSpan: slideSpan({ note: n, fret: p.fret, string: p.string }, null, undefined, s),
    }] : [];
  });
  const hue = lane.color || PAINT.accent;
  drawPreviewGrip(ctx, s, scale, X, Y, marks, hue, true);
}

// The grip the working views are all talking about: the frozen column, as marks that
// carry their own notes. One place, because four readers want it and each was doing
// its own gripsFor + frozenAt + handAt.
function focusGrip(lane, s) {
  const found = lane && gripsFor(lane);
  if (!found || found.strings !== s.strings) return null;
  // Frozen while a choice is being made, and the playhead otherwise: the strip has to
  // know whether this column is a chord before any working view is switched on, and
  // that question is about the grip you are looking at either way.
  return handAt(found.columns, frozenAt(lane) ?? boardTime(), 0, s);
}

// A circle's box, for drawing and for the pointer in one step.
function spotBox(p, scale, s, X, Y) {
  const r = markRadius(p.mm, scale, s);
  const cx = X(p.mm), cy = Y(stringOffsetAt(p.string, Math.max(0, p.mm), s));
  return { ...p, r, x0: cx - r, x1: cx + r, y0: cy - r, y1: cy + r };
}

// ---- every position, one note at a time ----
// A ring on every string the note could be played on, at the fret that sounds it.
// The pointer picks a ring and the note goes there; everything else in the grip
// stays exactly where it was, which is what makes this the boxes' opposite — a box
// is all of a shape or none of it, and this is one note without disturbing the rest.
//
// Strings a SIBLING is already holding are left out, because two notes cannot share
// one, and so is the note's own current place, which the hand is already drawing
// filled, and so is anywhere the note's technique rules out (allowedAt) — no open
// string under a slide, no string a slide's target cannot follow onto. What is left
// is exactly the set of legal single-note moves, so a ring is never an offer that
// lapses. A hammer destination moves its connected notes with it; slide targets
// retain the source's string unless that source is moved.
// Limitation: a swap (two notes trading strings) is two clicks, not one gesture.
function notePlaces(lane, s, at) {
  const tuning = lane && laneFretTuning(lane);
  if (!at || !tuning || tuning.length !== s.strings) return null;
  const multiple = selectedPositions(lane).multiple;
  const positions = notePlacements(at.marks, tuning, laneFretCount(lane));
  // The focused note's current position can still be a change for the other
  // selected occurrences, so it must be available as a batch destination.
  if (multiple) positions.unshift(...at.marks.map(m => ({ note: m.note, string: m.string, fret: m.fret })));
  return { at, out: positions
    .filter(p => {
      if (!selectedPositions(lane).multiple) return allowedAt(lane, tuning, s)(p);
      const notes = at.marks.map(m => m.note);
      const shape = new Map(at.marks.map(m => [m.note, m.note === p.note
        ? { string: p.string, fret: p.fret } : { string: m.string, fret: m.fret }]));
      return sharedShapeAllowed(lane, notes, shape);
    })
    .map((p) => ({ ...p, mm: fretCentre(p.fret, s) })) };
}

// Single notes use the same navigator, with one possible position at a time.
function drawNotePlaces(ctx, s, scale, X, Y, lane, at) {
  selectedPositions(lane);
  const got = notePlaces(lane, s, at);
  if (!got) return null;
  const list = got.out.map((p) => spotBox(p, scale, s, X, Y));
  const hovered = selectAlternative(`note:${lane.id}:${got.at.marks[0]?.note?.id}:${S.voicingRevision}:${sharedSelection.key}`, list);
  // Every other position is a ring (as in 0.3.0), once the note is clicked: hover
  // previews it, click moves the note there. Painted by drawNoteRings.
  spots = list;
  if (!hovered) return null;
  const shape = new Map(got.at.marks.map(mark => [mark.note, mark.note === hovered.note
    ? { string: hovered.string, fret: hovered.fret } : { string: mark.string, fret: mark.fret }]));
  const preview = previewAlternative ? previewPosition(lane, got.at.marks.map(m => m.note), shape, "note") : null;
  return { hovered, at: got.at, preview, hand: preview?.hand || null };
}

function drawNoteRings(ctx, lane) {
  const hovered = spots?.[alternativeIndex];
  ctx.lineWidth = 1.8;
  // A sliding note's ring says where its slide runs: a dashed tail from the far end.
  const geo = board?.lane === lane ? board : null;
  for (const p of geo ? spots || [] : []) {
    const span = slideSpan(p, null, undefined, geo.s);
    if (!span) continue;
    const far = span.from.fret === p.fret ? span.to : span.from;
    ctx.save();
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1.2;
    ctx.strokeStyle = p === hovered ? (lane.color || PAINT.accent) : PAINT.hint;
    ctx.beginPath();
    ctx.moveTo(geo.X(far.x), geo.Y(stringOffsetAt(p.string, far.x, geo.s)));
    const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2, dx = geo.X(far.x) - cx;
    ctx.lineTo(cx + Math.sign(dx) * p.r, cy);
    ctx.stroke();
    ctx.restore();
  }
  for (const p of spots || []) {
    ctx.strokeStyle = p === hovered ? (lane.color || PAINT.accent) : PAINT.hint;
    ctx.beginPath();
    ctx.arc((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, Math.max(1, p.r - 0.9), 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Re-finger the preview after moving a single note, without changing the song.
function drawNoteOffer(ctx, s, scale, X, Y, lane, { hovered, at, hand }) {
  if (!hand) return;
  // The moved note's slide is worked out again from its new fret.
  const moved = m => {
    const pos = hand.positions?.get(m.note) || (m.note === hovered.note ? hovered : null);
    return pos ? { ...m, string: pos.string, fret: pos.fret, x: fretCentre(pos.fret, s),
      slideSpan: slideSpan({ note: m.note, fret: pos.fret, string: pos.string }, null, undefined, s) } : m;
  };
  const marks = at.marks.map(moved);
  drawPreviewGrip(ctx, s, scale, X, Y,
    marks.map((m) => ({ ...m, finger: hand.fingers.get(m.note) ?? NO_FINGER })),
    lane.color || PAINT.accent, true);
  drawHammerConnections(ctx, s, scale, X, Y, lane, marks,
    n => hand.positions?.get(n) || gripsFor(lane)?.voiced.get(n), n => hand.fingers.get(n));
}

// The grip before and the grip after, ghosted. Filled rather than outlined so a ghost
// cannot be mistaken for a candidate's ring, and fretted notes only — a ghost of an
// open string lighting the whole neck would drown the thing it is a hint about.
//
// The alpha is the user's (Editor options). It started at `WASH`, on the grounds that
// rule 15's three transparencies are chosen by what is underneath and a ghost is "data
// you still have to read through" — true, but 0.14 of a pale hue on dark wood is a
// smudge, and how much of a hint you want while re-shaping a phrase is taste, not a
// fact about the board. So this is the one see-through-ness the app hands over, and
// its default is 0.35: present at a glance, still plainly behind the grip.
//
// P and N mark which side a ghost is on, always: two ghosts a fret apart are the case
// the feature exists for, and that is exactly the case where "which one is that" has
// no other answer. They are the note-anchored 9 rule 6 grants the canvas, in the selected UI font
// because a side is not a measurement, and they fade with the ghost they belong to —
// the whole mark is one strength, which is the thing the slider sets.
function drawOnion(ctx, s, scale, X, Y, columns, i, hue) {
  ctx.font = stageUi(STAGE_ANCHORED, 600);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [n, mark, a] of [[i - 1, "P", onionAlpha("prev")], [i + 1, "N", onionAlpha("next")]]) {
    if (a <= 0) continue;
    for (const f of columns[n]?.fingers || []) {
      if (!(f.fret > 0)) continue;
      const x = fretCentre(f.fret, s), r = markRadius(x, scale, s);
      const px = X(x), py = Y(stringOffsetAt(f.string, x, s));
      ctx.fillStyle = hexA(hue, a);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      if (r < STAGE_ANCHORED / 2) continue;
      ctx.fillStyle = hexA(PAINT.text, a);
      ctx.fillText(mark, px, py + 0.5);
    }
  }
}

// Draws the hand.
//
// `quiet` is the hand while something else is on offer, and it never changes what the
// hand LOOKS like — only how firmly it is there:
//
//   "fade"   an offer or the reset preview is under the pointer. The grip stays the
//            filled marks it was and drops in opacity, which says "this stops
//            applying if you click". It used to become a plain outline, and a plain
//            outline is exactly what every OTHER position on the neck is drawn as —
//            so where you are and what you were being offered were the same picture.
//   "ghost"  a shape is being built by hand. There the filled marks are the notes
//            already placed, so the old grip steps right back to an outline.
// Which fret the hand is anchored on right now — the same column drawHand draws, so
// the band and the grip can never disagree about which moment they are showing.
function anchorFret(lane) {
  if (!lane?.notes?.length) return 0;
  const found = gripsFor(lane);
  if (!found) return 0;
  const i = gripIndex(found.columns, frozenAt(lane) ?? boardTime());
  return i >= 0 ? Number(found.columns[i].seat) || 0 : 0;
}

// Where the hand WOULD stand for what is under the pointer, or 0 when nothing is: the
// shape in a hovered box, or the lane with the override reset. The boxes are last
// frame's, which is the frame the pointer was resolved against, and a moved pointer
// redraws anyway.
function offeredSeat(lane) {
  if (!lane?.notes?.length) return 0;
  if (suggestionVisible()) return suggestion.preview.seat || 0;
  if (handPeek != null) return handPeek;
  if (shaping?.preview?.hand) return Number(shaping.preview.hand.seat) || 0;
  if (altsOn && activeAlternative?.hand) return Number(activeAlternative.hand.seat) || 0;
  return 0;
}

const FADED = 0.4;   // the grip in the hand while another one is being considered

// The hand at this frame: what drawHand draws and what the strings bend under.
function handNow(lane, s, previewTime = null) {
  // A 6-string board cannot honestly show a bass. Until the bass neck exists,
  // a lane with another string count gets the instrument and no fingers.
  if (!lane || !lane.notes?.length) return null;
  let found = gripsFor(lane);
  if (!found || found.strings !== s.strings) return null;
  if (shownAnyway?.key === handKey(lane) && found.blockedStarts) {
    if (revealedHand?.source !== found || revealedHand.reveal !== shownAnyway) {
      const playableColumns = found.columns.filter(column => !found.blockedStarts.has(column.start)
        || shapeRevealed(lane, `${lane.id}:${column.start}`));
      const fingers = playableColumns.flatMap(column => column.fingers);
      revealedHand = { source: found, reveal: shownAnyway, value: { ...found, playableColumns,
        ringFingers: fingers.filter(f => f.note.fx?.letRing),
        releaseFingers: [...fingers].reverse(),
        popFingers: fingers.filter(f => f.note.slap === "pop") } };
    }
    found = revealedHand.value;
  }
  // While the positions are on screen the hand holds the column being decided instead
  // of following the playhead: the boxes are a comparison, and a comparison against a
  // moving target is not one. A grip's own onset asks for it pressed and still — the
  // travel window is zero, so nothing can be mid-slide at the moment it starts.
  const frozen = previewTime ?? frozenAt(lane);
  const t = frozen ?? boardTime();
  // THE HAND ONLY TRAVELS WHILE THE SONG DOES. Stopped, the board answers "what is
  // held here", and a finger drawn part-way to the next grip — which is where the
  // end of every note is — is a position nobody plays.
  const animate = $("fretboardAnimations")?.checked !== false;
  const moving = animate && frozen == null && transportPlaying();
  const pose = handAt(found.playableColumns || found.columns, t, moving ? travelSeconds() : 0, s, animate);
  const shapes = (found.shapes || []).filter(frame => !found.blockedStarts?.has(frame.start)
    || shapeRevealed(lane, `${lane.id}:${frame.start}`));
  const at = shapeHandAt(shapes, t, pose, s, animate);
  return { found, t, moving, at,
    ringing: moving ? ringingMarksAt(found.ringFingers || [], t, s) : [],
    releases: moving ? releasedStringsAt(found.releaseFingers || [], t, s) : [],
    preparations: moving ? (found.popFingers || []).filter((f) => Math.abs(popPreparation(f.note, t)) > 0.001) : [] };
}

function drawHand(ctx, s, scale, X, Y, lane, now, quiet, { onion = editing } = {}) {
  if (!now) return;
  const { found, t, moving, at } = now;
  const hue = lane.color || PAINT.accent;
  if (onion && $("fretboardOnionEnabled").checked) {
    const columns = found.playableColumns || found.columns;
    drawOnion(ctx, s, scale, X, Y, columns, gripIndex(columns, t), hue);
  }
  if (!at) return;
  if (quiet) {
    ctx.save();
    ctx.globalAlpha = FADED;
    drawGrip(ctx, s, scale, X, Y, at.gripMarks || at.marks, hue, true);
    ctx.restore();
    return;
  }

  paintHandImpacts(ctx, s, scale, X, Y, { at, t, moving, hue });
  const marks = handDisplayMarks(at, moving);
  drawGrip(ctx, s, scale, X, Y, at.gripMarks || marks, hue, at.pressed, { time: $("fretboardAnimations")?.checked === false ? null : t, liveStrings: moving });
  paintHeldHandContacts(ctx, s, scale, X, Y, at);
  if (!moving) for (const m of at.marks) if (m.slideSpan) drawSlideArrow(ctx, s, scale, X, Y, m);
  if (!moving) drawHammerConnections(ctx, s, scale, X, Y, lane, at.marks,
    n => found.voiced.get(n), n => found.fingers?.get(n));
}

function drawHammerConnections(ctx, s, scale, X, Y, lane, marks, positionOf, fingerOf) {
  const links = hammerPositionPreview(lane.notes, marks.map(m => m.note).filter(Boolean), positionOf);
  const current = new Set(marks.map(m => m.note)), shown = new Set();
  const hue = lane.color || PAINT.accent;
  for (const link of links) {
    for (const p of [link.from, link.to]) if (!current.has(p.note) && !shown.has(p.note)) {
      shown.add(p.note);
      drawGrip(ctx, s, scale, X, Y, [{ ...p, pitch: p.note.pitch, x: fretCentre(p.fret, s),
        finger: fingerOf(p.note) ?? NO_FINGER, pressed: false, opacity: .6, lift: 0 }], hue, false);
    }
    const from = { ...link.from, x: fretCentre(link.from.fret, s) }, to = { ...link.to, x: fretCentre(link.to.fret, s) };
    const x0 = X(from.x), x1 = X(to.x), middle = (x0 + x1) / 2;
    const y0 = Y(stringOffsetAt(from.string, from.x, s)), y1 = Y(stringOffsetAt(to.string, to.x, s));
    const top = Math.min(y0, y1) - Math.max(markRadius(from.x, scale, s), markRadius(to.x, scale, s)) * 1.8;
    ctx.save(); ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(x0, y0 - 4);
    ctx.quadraticCurveTo(middle, top, x1, y1 - 4);
    ctx.lineWidth = 4; ctx.strokeStyle = PAINT.ground; ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = hue; ctx.stroke();
    ctx.font = stageUi(11, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3; ctx.strokeStyle = PAINT.ground; ctx.strokeText(link.kind, middle, top);
    ctx.fillStyle = PAINT.text; ctx.fillText(link.kind, middle, top); ctx.restore();
  }
}

// Stopped on a slide: where it starts, pressed, and a ghost where it lands.
function slideEnds(m) {
  const { from, to } = m.slideSpan, pitch = m.pitch ?? m.note?.pitch;
  return [{ ...m, ...from, pitch: pitch + from.fret - m.fret },
    { ...m, ...to, pitch: pitch + to.fret - m.fret, lift: 0, pressed: false, opacity: 0.55 }];
}

// A preview grip (an offer, a suggestion): its slides drawn the way the hand's are,
// start and landing with the arrow between them.
function drawPreviewGrip(ctx, s, scale, X, Y, marks, hue, pressed) {
  drawGrip(ctx, s, scale, X, Y, marks.flatMap((m) => m.slideSpan ? slideEnds(m) : [m]), hue, pressed);
  ctx.save(); ctx.setLineDash([]);
  for (const m of marks) if (m.slideSpan) drawSlideArrow(ctx, s, scale, X, Y, m);
  ctx.restore();
}

// Start to target along the string, between the two marks.
function drawSlideArrow(ctx, s, scale, X, Y, m) {
  const { from, to } = m.slideSpan, dir = Math.sign(to.x - from.x);
  const xa = from.x + dir * markRadius(from.x, scale, s) / scale * 1.2;
  const xb = to.x - dir * markRadius(to.x, scale, s) / scale * 1.2;
  if ((xb - xa) * dir <= 0) return;
  const at = (x) => [X(x), Y(stringOffsetAt(m.string, x, s))];
  const [x0, y0] = at(xa), [x1, y1] = at(xb), angle = Math.atan2(y1 - y0, x1 - x0), head = 7;
  ctx.save();
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
  ctx.moveTo(x1 - head * Math.cos(angle - 0.5), y1 - head * Math.sin(angle - 0.5)); ctx.lineTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(angle + 0.5), y1 - head * Math.sin(angle + 0.5));
  ctx.lineWidth = 4; ctx.strokeStyle = PAINT.ground; ctx.stroke();
  ctx.lineWidth = 2; ctx.strokeStyle = PAINT.text; ctx.stroke();
  ctx.restore();
}

// ---- putting the hand somewhere ----
// The board is the control. A click on bare wood says "the hand stands here", which
// is one number where choosing a shape is six, and it is the number the voicer
// actually decides with — everything else on the neck follows from it.

// WHICH BEAT the hand is being put on. A beat and not a subdivision: the grid can be
// as fine as a 32nd, and a hand that moves four times inside one beat is not a hand.
// Measured from the bar it falls in, so a tempo or meter change cannot drift it.
//
// THE PLAYHEAD'S BEAT, and deliberately not the drawn column's. A hold belongs to a
// place in the bar, not to whichever note happens to be under the hand there: it used
// to take the frozen column's ONSET, so a chord ringing across three beats put every
// hold on the first of them, and a traced onset a few milliseconds the wrong side of
// a beat line put it on the beat before. Where you park the playhead is where the
// shift goes.
//
// THE BEAT THE PLAYHEAD IS IN, so this floors and does not round. Rounding asks which
// beat line the playhead is NEAREST, which is a different question and answers "the
// next one" for the whole second half of every beat — park on a note past the middle
// of its beat, and the shift silently landed a beat late, on the note after the one
// you were looking at (holdsByColumn attaches a hold to the first column at or after
// its time, so one beat of drift is one note of drift). Flooring cannot overshoot: the
// hold starts at the beginning of the beat you are standing in, which is what "the
// hand moves here" means, and the first note of that beat is the first to take it.
function beatUnderBoard() {
  const t = playbackTime();
  const beat = segBeatSec(gridAt(t));
  if (!(beat > 0)) return t;
  const bars = songBarStarts();
  let base = 0;
  for (const x of bars) { if (x > t + 1e-6) break; base = x; }
  // The epsilon is for a playhead parked exactly on the line: floating-point seconds
  // land a hair under it about half the time, and without it the shift goes to the
  // beat before the one the playhead is visibly on.
  return base + Math.floor((t - base) / beat + 1e-6) * beat;
}


// THE NOTE OR CHORD THE HAND BUTTONS ACT ON: the column the board shows, the onset
// of the one before it (a hand placed between the two belongs to this one, as
// holdsByColumn reads it), and the hands that can play it. Remembered per column
// object, because the board asks every frame and a new answer comes with a new walk.
const handChoicesOf = new WeakMap();
function handColumnHere(lane) {
  const found = lane?.notes?.length ? gripsFor(lane) : null;
  if (!found) return pendingHandColumn && pendingHandColumn.lane === lane && pendingHandColumn.notes === lane?.notes
    && pendingHandColumn.focus === focusNote(lane) && pendingHandColumn.revision === S.voicingRevision
    ? pendingHandColumn.at : null;
  if (pendingHandColumn?.lane === lane) pendingHandColumn = null;
  let i = gripIndex(found.columns, frozenAt(lane) ?? boardTime());
  if (i < 0) return null;
  // A slide's landing is fretted by the finger that slid there, so its hand is
  // the slide start's: step back to the column the slide (chain) began on.
  while (i > 0 && slidLanding(found.columns[i - 1], found.columns[i])) i--;
  const column = found.columns[i];
  if (!handChoicesOf.has(column)) {
    const shape = new Map(column.fingers.map((f) => [f.note, { string: f.string, fret: f.fret }]));
    handChoicesOf.set(column, handChoices(shape, handProfileForTuning(laneFretTuning(lane)),
      Math.max(1, laneFretCount(lane) - 3)));
  }
  return { column, after: i > 0 ? found.columns[i - 1].start : -Infinity, choices: handChoicesOf.get(column),
    shift: slideInShift(column) };
}

// The layer's chord at the column the board shows, if that column is a chord.
function chordAtBoard(lane) {
  const at = handColumnHere(lane);
  return at ? laneChords(lane).find((c) => Math.abs(c.t0 - at.column.start) < 1e-6) || null : null;
}

// The hand the player put on this note or chord, if any, so the band can say so.
function holdHere(lane) {
  const at = handColumnHere(lane);
  if (!at) return null;
  return (lane?.handHolds || []).find((h) => Number(h.t) > at.after + 1e-6 && Number(h.t) <= at.column.start + 1e-6) || null;
}

// Where a hand for this note or chord is stored: on the one already there, else on its onset.
function handTimeHere(lane) {
  return holdHere(lane)?.t ?? handColumnHere(lane)?.column.start ?? beatUnderBoard();
}

// Which box the pointer is in, or -1. The boxes are the ones the last frame drew, so
// this needs no geometry of its own and cannot disagree with what is on screen.
// The ring the pointer is in, or null. Same reading and the same picker as the
// boxes: pickBox takes the SMALLEST box under the pointer, which for overlapping
// rings on a crowded neck is the one you were aiming at.
function spotUnder(e) {
  if (!spots?.length) return null;
  const r = fretboardEl.getBoundingClientRect();
  const i = pickBox(spots, e.clientX - r.left, e.clientY - r.top);
  return i >= 0 ? spots[i] : null;
}

// Whether the pointer is on what the hand is holding: one of the grip's marks (with a
// little slack — a mark on the top strings is a small target), the fret the hand is
// anchored on, or the capo (the nut, without one). This is the whole clickable surface
// of the board outside edit mode.

// ---- moving and adding notes on the board ----
// Drag a note to another string or fret and its pitch follows; double-click a string
// to add a note there. Both read last frame's board, so they match what is on screen.
let board = null;      // { lane, s, scale, X, Y, marks }
let noteDrag = null;   // { note, from: { string, fret }, to }
let dragged = false;   // swallows the click that ends a drag
let boardHover = null; // { mark, place } under the pointer
let gripsShown = localStorage.getItem("cw.fretboardGrips") !== "0";

const boardEditable = () => !!board && editing && !transportPlaying() && !shaping
  && !fretboardPanel.hasAttribute("data-edit-blocked") && canEditLane(board.lane);

function pointerOnBoard(e) {
  const r = fretboardEl.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

// The string and fret under the pointer (fret 0 = open, behind the nut or capo).
function placeUnder(e) {
  if (!board || board.s.strings < 2) return null;
  const { s, scale, X, Y, lane } = board, [px, py] = pointerOnBoard(e);
  const mm = (px - X(0)) / scale;
  return placeAt(mm, py, (i) => Y(stringOffsetAt(i, Math.max(0, mm), s)), s, laneFretCount(lane));
}

function markUnder(e) {
  if (!board?.marks.length) return null;
  const { s, scale, X, Y } = board, [x, y] = pointerOnBoard(e);
  const boxes = board.marks.map((m) => spotBox({ mm: m.x, string: m.string, mark: m }, scale, s, X, Y));
  const i = pickBox(boxes, x, y);
  return i >= 0 ? boxes[i].mark : null;
}

// A place on the board: filled for where a dragged note lands, dashed for where a
// double-click would add one, struck through where it cannot go.
function drawPlace(ctx, s, scale, X, Y, lane, { string, fret }, { filled, blocked }) {
  const hue = lane.color || PAINT.accent;
  const b = spotBox({ mm: fretCentre(fret, s), string }, scale, s, X, Y);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, r = Math.max(1, b.r - 0.9);
  const line = blocked ? PAINT.error : hue;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  if (filled) { ctx.fillStyle = hexA(line, blocked ? 0.25 : 0.55); ctx.fill(); }
  if (!filled) ctx.setLineDash([3, 2]);
  ctx.strokeStyle = line; ctx.lineWidth = 1.8; ctx.stroke();
  ctx.setLineDash([]);
  if (blocked) {
    ctx.beginPath(); ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
    ctx.lineWidth = 2.2; ctx.stroke();
  }
  ctx.font = stageMono(11); ctx.fillStyle = blocked ? PAINT.error : PAINT.text;
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.fillText(noteName(laneFretTuning(lane)[string] + fret), cx, b.y0 - 2);
  ctx.restore();
}

// Whether `string` is taken by another note sounding here.
const stringTaken = (string, except = null) => board.marks.some((m) => m.note !== except && m.string === string);

function drawDragTarget(ctx, s, scale, X, Y, lane) {
  drawPlace(ctx, s, scale, X, Y, lane, noteDrag.to, { filled: true, blocked: stringTaken(noteDrag.to.string, noteDrag.note) });
}

// Hovering a note lights it; hovering a free place outlines where a note would go.
function drawBoardHover(ctx, s, scale, X, Y, lane) {
  const { mark, place } = boardHover;
  if (mark) {
    const hue = lane.color || PAINT.accent;
    const b = spotBox({ mm: mark.x, string: mark.string }, scale, s, X, Y);
    ctx.save();
    ctx.shadowColor = hue; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.arc((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.r + 2, 0, Math.PI * 2);
    ctx.fillStyle = hexA(hue, 0.3); ctx.fill();
    ctx.strokeStyle = PAINT.text; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  } else if (place) drawPlace(ctx, s, scale, X, Y, lane, place, { filled: false, blocked: stringTaken(place.string) });
}

// A new note joins the note or chord the board shows, with its start and length;
// on a bare board it starts at the playhead with the length last drawn on the stage.
function addNoteHere(e) {
  if (!boardEditable() || markUnder(e)) return;
  const place = placeUnder(e), lane = board.lane;
  if (!place) return;
  if (board.marks.some((m) => m.string === place.string)) { toast("That string is already playing here"); return; }
  const focus = focusNote(lane), col = focus ? columnOf(focus)?.col.notes || [focus] : null;
  let start, end;
  if (col) { start = Math.min(...col.map((n) => n.start)); end = Math.max(...col.map((n) => n.end)); }
  else {
    const step = minDur();
    start = Math.max(0, Math.min(snap(playbackTime()), S.state.duration - step));
    end = snapNote(start, Math.min(S.state.duration, Math.max(start + step, noteLength.end(S.state, start, gridSegments())))).end;
  }
  addNoteOnBoard(lane, place.string, place.fret, start, end);
}

function boxUnder(e) {
  if (!gripsShown || !altsOn || !alts?.boxes?.length) return -1;
  // clientX against the canvas's own rect, not offsetX: the same reading
  // interaction.js takes for the stage, and the only one a synthetic event carries.
  const r = fretboardEl.getBoundingClientRect();
  return pickBox(alts.boxes, e.clientX - r.left, e.clientY - r.top);
}

export function init_fretboard() {
  fretboardPanel.addEventListener("mouseenter", () => {
    if (!visible) { fretboardPanel.classList.add("is-peeking"); drawFretboard(); }
  });
  fretboardPanel.addEventListener("mouseleave", () => fretboardPanel.classList.remove("is-peeking"));
  fretboardPanel.addEventListener("click", (event) => {
    if (!visible && !event.target.closest('[data-panel-toggle="fretboard"]'))
      setFretboardVisible(true);
  });
  wireMenu("menuFretboard", () => setFretboardVisible(!visible));
  // The handle between the stage and the neck: drag for height, past the threshold to
  // fold the panel away, back out to open it — the same gesture as the sidebar's.
  splitter($("fretboardResize"), {
    axis: "y",
    start: () => fretboardPanel.getBoundingClientRect().height,
    move: (dy, startH) => {
      const raw = startH - dy;
      if (raw < COLLAPSE_AT) { if (visible) setFretboardVisible(false); return; }
      userHeight = Math.round(Math.max(HEIGHT_MIN, raw));
      if (visible) layoutFretboard(); else setFretboardVisible(true);
    },
    end: () => { if (visible && userHeight) rememberPref(LS_HEIGHT, userHeight); },
    toggle: () => setFretboardVisible(!visible),
  });
  for (const button of panelControls("fretboard")) button.addEventListener("click", () => setFretboardVisible(!visible));
  fretboardAuto.addEventListener("click", () => {
    const lane = currentLane();
    if (!lane) return;
    hideSuggestion();
    previewAlternative = false;
    clearOverrideAt(lane, pinnedColumn(lane)?.notes || null, handTimeHere(lane));
    fretboardAuto.blur();
    drawFretboard();
  });
  fretboardEl.addEventListener("pointerdown", (e) => {
    dragged = false;
    if (e.button !== 0 || !boardEditable()) return;
    const mark = markUnder(e);
    if (!mark) return;
    noteDrag = { note: mark.note, from: { string: mark.string, fret: mark.fret }, to: null };
    fretboardEl.setPointerCapture(e.pointerId);
  });
  fretboardEl.addEventListener("pointermove", (e) => {
    if (!noteDrag) return;
    const to = placeUnder(e), { from } = noteDrag;
    noteDrag.to = to && (to.string !== from.string || to.fret !== from.fret) ? to : null;
    fretboardEl.style.cursor = "grabbing";
    drawFretboard();
  });
  fretboardEl.addEventListener("pointerup", () => {
    if (!noteDrag) return;
    const { note, to } = noteDrag;
    noteDrag = null; fretboardEl.style.cursor = "";
    if (to) dragged = true;
    if (to && !stringTaken(to.string, note)) moveNoteOnBoard(note, to.string, to.fret);
    drawFretboard();
  });
  fretboardEl.addEventListener("pointercancel", () => { noteDrag = null; drawFretboard(); });
  fretboardEl.addEventListener("dblclick", addNoteHere);
  fretboardEl.addEventListener("mousemove", e => {
    if (noteDrag || !editing || transportPlaying() || fretboardPanel.hasAttribute("data-edit-blocked")) return;
    const spot = spots ? spots.indexOf(spotUnder(e)) : -1;
    const i = spot >= 0 || shaping ? -1 : boxUnder(e);
    // Hovering a ring or box browses to it; leaving them returns to the original.
    const over = alternativeKey.startsWith("note:") ? spot : alternativeKey.startsWith("chord:") ? i : -1;
    if (!shaping && over !== hoverAt) {
      if (over >= 0) { alternativeIndex = over; previewAlternative = true; hoverPicked = true; }
      else if (hoverPicked) { alternativeIndex = -1; previewAlternative = false; hoverPicked = false; }
    }
    hoverAt = over;
    spotHover = spot;
    const mark = boardEditable() ? markUnder(e) : null;
    boardHover = boardEditable() ? { mark, place: mark ? null : placeUnder(e) } : null;
    fretboardEl.style.cursor = spot >= 0 || i >= 0 ? "pointer" : mark ? "grab" : "";
    drawFretboard();
  });
  fretboardEl.addEventListener("mouseleave", () => {
    fretboardEl.style.cursor = ""; spotHover = -1; hoverAt = -1; boardHover = null;
    if (hoverPicked) { alternativeIndex = -1; previewAlternative = false; hoverPicked = false; }
    if (editing) drawFretboard();
  });
  $("fretboardVoiceUp").addEventListener("click", () => stepVoiceFocus(1));
  $("fretboardVoiceDown").addEventListener("click", () => stepVoiceFocus(-1));
  $("fretboardShapePrev").addEventListener("click", () => stepShapeNote(-1));
  $("fretboardShapeNext").addEventListener("click", () => stepShapeNote(1));
  window.addEventListener("keydown", e => {
    typeFinger(e);
  }, true);
  // The board is a control only while the mode says so. Anywhere on the wood, not
  // only off a candidate box: a box is a drawing of a place the notes could go, and
  // wanting the hand there is the commonest reason to be pointing at one.
  fretboardEl.addEventListener("click", (e) => {
    if (dragged) { dragged = false; return; }
    if (e.detail > 1) return;   // the second click of a double-click adds a note
    if (!editing || transportPlaying() || fretboardPanel.hasAttribute("data-edit-blocked")) return;
    const lane = currentLane();
    if (!lane) return;
    // While a shape is being built the board is only that: a circle places the note
    // being placed, a placed mark takes it back off, and bare wood does nothing — the
    // hand is not what you are deciding.
    if (shaping) {
      const pick = spotUnder(e);
      if (!pick) return;
      if (pick.placed) shaping.index = shaping.notes.indexOf(pick.note);
      else {
        shaping.preview = null;
        shaping.picked.set(pick.note, { string: pick.string, fret: pick.fret });
        const next = shaping.notes.findIndex((note, i) => i > shaping.index && !shaping.picked.has(note));
        if (next >= 0) shaping.index = next;
      }
      spotHover = -1;
      layoutFretboard();          // Apply arrives or leaves with the last note
      return;
    }
    // Rings place one note and candidate boxes a whole shape; the smaller ring wins
    // when they overlap. The hand is set from the fret-number row.
    // A ring is a complete single-note move; it needs no finished preview.
    const spot = spotUnder(e);
    if (spot) { previewAlternative = false; hoverPicked = false; setNotePosition(spot.note, spot.string, spot.fret); return; }
    const pick = alts?.boxes?.[boxUnder(e)];
    if (pick?.choice) { previewAlternative = false; hoverPicked = false; applyColumnAlternative(alts.notes, pick.choice, alts.influence); return; }
    drawFretboard();
  });
  // The chord name field: Enter or leaving commits, Escape puts the name back.
  const chordInput = $("fretboardChordInput");
  const commitChordName = () => {
    const chord = chordShown, text = chordInput.value.trim();
    if (!chord || text === (chord.name || "")) return;
    renameChord(chord, text || chord.auto || "");
  };
  chordInput.addEventListener("change", commitChordName);
  chordInput.addEventListener("keydown", (e) => {
    e.stopPropagation();   // typing a name is not a shortcut
    if (e.key === "Enter") chordInput.blur();
    if (e.key === "Escape") { chordInput.value = chordShown?.name || ""; chordInput.blur(); }
  });
  $("fretboardChordAuto").addEventListener("click", () => {
    if (chordShown?.auto) renameChord(chordShown, chordShown.auto);
    $("fretboardChordAuto").blur();
  });
  const gripsButton = $("fretboardGripsShown");
  gripsButton.checked = gripsShown;
  gripsButton.addEventListener("change", () => {
    gripsShown = gripsButton.checked;
    rememberPref("cw.fretboardGrips", gripsShown ? "1" : "0");
    gripsButton.blur();
    drawFretboard();
  });
  initHandPositions();
  $("fretboardSuggestion").addEventListener("change", () => {
    previewAlternative = false; hoverPicked = false;
    $("fretboardSuggestion").blur();
    drawFretboard();
  });
  window.addEventListener("cw-transport", event => {
    if (event.detail === "play" || event.detail === "pause") setFretboardEdit(!transportPlaying());
    if (event.detail === "seek") {
      alts = null; altsJob = null; alternativeKey = "";
      alternativeIndex = -1; previewAlternative = false;
    }
    if (shaping && (event.detail === "seek" || event.detail === "play")) setFretboardShape(false);
  });
  fretboardShowAnyway.addEventListener("click", () => {
    const lane = currentLane(), column = fretboardShowAnyway.dataset.key;
    shownAnyway = lane && column ? { key: handKey(lane), column } : null;
    revealedHand = null;
    fretboardShowAnyway.blur();
    draw();
  });
  $("fretboardFingerReset").addEventListener("click", () => {
    $("fretboardFingerReset").blur();
    resetGripFingers();
  });
  fretboardShape.addEventListener("click", () => {
    fretboardShape.blur();
    if (!editing) setFretboardEdit(true);
    setFretboardShape(!shaping);
  });
  // The one place on this panel where work is staged rather than applied as you go, so
  // it is the one place with a primary (rule 20 names the work). Done becomes
  // enabled when every note has a position; navigating notes keeps that draft.
  fretboardApply.addEventListener("click", () => {
    fretboardApply.blur();
    const col = shaping && columnOf(shaping.notes[0])?.col;
    if (fretboardApply.disabled || !col || shaping.picked.size !== shaping.notes.length
      || !previewIsCurrent(shaping, currentLane())) return;
    const lane = currentLane();
    const wrong = setColumnShape(col.notes, shaping.picked, limitsFor(lane, col.notes[0]), laneFretCount(lane));
    if (wrong) { toast(wrong); return; }
    setFretboardShape(false);
  });
  // Escape leaves the walk with nothing written, which is what the staging promised.
  // Transient depth: it is canvas state, above the selection and below every window.
  registerEscapeLayer(ESC_DEPTH.transient, () => {
    if (shaping) setFretboardShape(false);
    else return false;
    return true;
  });
  $("fretNumbering")?.addEventListener("input", () => drawFretboard());
  $("fretboardOnionEnabled").addEventListener("change", () =>
    drawFretboard());
  // Watch #editor, not the panel: this writes the panel's own height, and an
  // observer on it would feed itself. #editor is flex-sized by the window and
  // the sidebars, and nothing here mutates it.
  new ResizeObserver(() => layoutFretboard()).observe(editorEl);
  new ResizeObserver(() => layoutFretboard()).observe($("fretboardControls"));
  // The markup ships collapsed so the first paint has nothing to animate; this is
  // what puts the menu's check, the pull's label and `visible` in step with it.
  setFretboardVisible(visible);
  setFretboardEdit(!transportPlaying());
}
