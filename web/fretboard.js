import { overrideResetPreview } from './override-reset.js';
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

import { boardHalfWidthAt, boardLength, boardWidth, chordLabel, dotCentre, fretCentre, fretDistance, fretboardFor, gripIndex, handAt, handColumns, notePlacements, pickBox, shapeBox, stringOffsetAt } from "./fretboard-core.js";
import { $, editorEl, fretboardContext, fretboardApply, fretboardAuto, fretboardBusy, fretboardBusyLabel, fretboardEdit, fretboardEl, fretboardName, fretboardPanel, fretboardPin, fretboardReach, fretboardReachNext, fretboardReachPrev, fretboardShape, fretboardSide, fretboardStage } from "./dom.js";
import { HALO, UI_PAINT as PAINT, WASH } from "./stage-paint.js";
import { STAGE_ANCHORED, instrKey, stageMono, stageUi } from "./constants.js";
import { dpr, hexA, noteName } from "./util.js";
import { draw } from "./repaint.js";
import { editLanes } from "./lanes.js";
import { songBarStarts } from "./song-bars.js";
import { gridAt, gridBpm, segBeatSec } from "./grid.js";
import { playbackTime, transportPlaying } from "./playback.js";
import { selectedTablatureLane } from "./layer-role.js";
import { S } from "./store.js";
import { FX_GLYPHS } from "./note-effects.js";
import { laneFingering, laneTuning } from "./tablature.js";
import { assignFingers, chordColumns, handProfileForTuning, overrideInfluence } from "./voicing-core.js";
import { columnAlternatives } from "./voicing.js";
import { applyColumnAlternative, clearOverrideAt, columnOf, setColumnInfluence, setColumnShape, setHandHold, setNotePosition } from "./edit.js";
import { wireMenu } from "./ui.js";
import { ESC_DEPTH, registerEscapeLayer } from "./escape-stack.js";
import { toast } from "./notify.js";

// = --s-group. A canvas cannot read a token, which is the same concession rule 15
// already makes for the stage's colours and constants.js makes for its fonts.
const PAD = 16;

// Off at launch: the neck is a second view of the song, and the editor opens on the
// song. A session toggle either way — like the marker lanes, and like zoom.
let visible = false;

// Which neck. The lane's instrument decides it — an acoustic lane gets a
// dreadnought, a bass lane a Jazz Bass — and the lane's *tuning* still decides
// whether a hand can be drawn on it, because a grip needs as many strings as the
// board has. The panel's height depends on this too, so `laidOut` remembers which
// neck it was measured for and drawFretboard bounces once through the layout when
// the answer changes.
const laneSpec = (lane) => fretboardFor(instrKey(lane?.instrument));
const currentLane = () => (S.state ? selectedTablatureLane(editLanes()) : null);
let laidOut = null;
let laidOutStrip = 0;

// The selected tablature lane's fingering, as a timeline of grips. Voicing a whole
// lane runs in a worker, so this is filled in asynchronously and the board draws
// bare until it lands. Keyed the way draw.js keys its own voicing caches — the
// revision plus the notes array's identity — with the inputs that change a
// fingering without changing a note (the tuning).
let hand = null;      // { key, columns, strings }
let handJob = "";     // the key currently being voiced, so one lane is asked once

function handKey(lane) {
  return `${lane.id}:${S.voicingRevision}:${lane.notes.length}:${lane.tuning}:${
    lane.fingeringMode || ""}`;
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
  const columns = [];
  for (const col of chordColumns(notes)) {
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
        string: pos.string, fret: pos.fret, start: note.start,
        finger: fingers.get(note) || 0, dead: !!note.fx?.dead,
        // Carried so the grip can name itself. Not derivable from the mark, whose
        // fret and string are mid-slide while the hand travels.
        pitch: note.pitch,
      })),
    });
  }
  return handColumns(columns, tuning.length);
}

function gripsFor(lane) {
  const key = handKey(lane);
  if (hand && hand.key === key) return hand;
  if (handJob !== key) {
    handJob = key;
    laneFingering(lane).then((fingering) => {
      if (handJob !== key) return;    // a later edit already asked for a newer one
      hand = { key, strings: fingering.tuning.length, columns: gripsFrom(fingering) };
      draw();
    // A failure is an *answer*, and it is stored as one: an empty timeline under the
    // same key. Leaving `hand` alone would re-ask sixty times a second, and leaving it
    // null makes "no answer yet" indistinguishable from "no answer", which is the
    // difference the spinner below is drawing. The one failure that actually happens
    // is an imported lane missing an authored position — a property of the lane, not
    // a hiccup, so it is not retried until an edit changes the key.
    }).catch(() => { hand = { key, strings: 0, columns: [] }; draw(); });
  }
  return hand && hand.key === key ? hand : null;
}

// How long a shift takes: one beat. A hand moves in musical time, not in the
// interface's 90ms — and taking it from the grid means a slow song shows the
// travel and a fast one snaps, which is what actually happens.
const travelSeconds = () => 60 / (gridBpm() || 120);

// And how long a strike takes to fade: half a beat, for the same reason. It has to
// be shorter than the gap between two attacks or a run of eighth notes is one
// continuous flare instead of a rhythm — half a beat is the longest value that
// still clears every subdivision the grid offers.
const glowSeconds = () => 30 / (gridBpm() || 120);

// ---- other positions ----
// The list the deleted Tab preview sidebar held as cards, drawn on the neck those
// cards were each a small diagram of. A card has to redraw the instrument at 22px a
// fret to say "fret 9 instead of fret 4"; the board is already saying it at full
// size, and six shapes on one neck compare in a glance in a way six diagrams in a
// grid never did — which is why the sidebar is gone.
//
// It is a mode, because the boxes are only legible while nothing else is moving: the
// hand freezes on the column being decided rather than following the playhead. That
// is also the honest reading of the button — you are looking at one chord.
let altsOn = false;
let alts = null;      // { note, rev, t0, notes, influence, ranked, boxes, hover }
// READING THE NECK, OR WORKING ON IT. Off by default, and off is most of the time: a
// neck is read far more often than it is edited. The mode owns three things at once —
// whether a click moves the hand, whether the other positions are drawn, and whether
// onion skin is offered — because all three are the same question ("what else could
// this be, and what would it do to its neighbours") and none of them is worth the
// panel's width while you are only watching the song go past.
let editing = false;
let altsJob = null;   // the note a request is out for, so one column is asked once

// EVERY PLACE EACH NOTE COULD GO, one note at a time, drawn by the SAME toggle. It
// was a second switch beside the boxes and the pair could not be told apart: "show
// other positions" and "show every position" are the same sentence, and a user facing
// two of them has to discover the difference by trying both. They are one question at
// two grains — which grips could this be, and where could each note go — so they are
// one view, and the grain is said by the SHAPE of the mark instead of by a mode: a
// rounded BOX is a whole grip (hover it to see it played), a CIRCLE is one note's
// other home (click it to move that note there). Two marks, two meanings, one switch.
let spots = null;     // last frame's targets: { note, string, fret, x0, x1, y0, y1 }
let spotHover = -1;

// A SHAPE THE ENGINE NEVER OFFERED, stated outright. The candidates are the grips it
// can build and rank; a player who wants one it never enumerated has to be able to say
// so directly @@ a string and a fret per note, and nothing else.
//
// Chords only, and that is not a restriction: a single note's every position is already
// on the board as circles you click, so there is nothing left to build. What a chord
// has that a note has not is the COMBINATION, which is the thing the enumerator prunes.
//
// It walks the notes low to high, one at a time, because sixteen unlabelled circles on
// one neck cannot say which of them belongs to which note. The heading names the note
// being placed, which is the whole instruction (rule 24: state, never prose).
let shaping = null;   // { notes, picked: Map(note -> { string, fret }) }

// The column being decided: the selection's if there is one, and otherwise **the one
// under the playhead**, which is the column the neck is already drawing. Requiring a
// selection first was a step that bought nothing — the board shows you the grip, and
// asking for another position for the grip in front of you needs no ceremony.
//
// It follows the playhead while the song plays too. It used to hold whatever it last
// was, so that a list of alternatives could not be re-asked for sixty times a second
// — but the working views now stand down during playback entirely (see frozenAt), so
// nothing is asking, and a focus that lags the song is a focus that hands the strip a
// column that has already gone past.
function focusNote(lane) {
  for (const n of S.selection) if (Number.isFinite(n.pitch)) return n;
  const found = lane && gripsFor(lane);
  const i = found ? gripIndex(found.columns, playbackTime()) : -1;
  return i >= 0 ? found.columns[i].note || null : null;
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
  if (alts?.rev === S.voicingRevision && alts.lane === lane) return alts.t0;
  if (!altsOn) return null;
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

// A candidate box represents a complete playable shape. Hover previews it;
// clicking applies the whole shape. A ring still changes only one note.

// The mode. Turning it on brings up the working views; turning it off puts them all
// away, so leaving edit mode cannot leave a stray ghost or a field of boxes behind.
export function setFretboardEdit(on) {
  editing = !!on && visible;
  fretboardEdit.setAttribute("aria-pressed", String(editing));
  fretboardPanel.toggleAttribute("data-editing", editing);
  drawFretboard();
  fretboardContext.hidden = !editing;
  setFretboardAlts(editing);
  if (!editing) { setFretboardShape(false); }
  fretboardEl.style.cursor = "";
  hoverFret = 0;
  if (!editing) { endResetPreview(); fretboardAuto.hidden = true; }
  // Context controls can wrap the toolbar and change the remaining canvas height.
  layoutFretboard();
}

function setFretboardAlts(on) {
  altsOn = !!on && visible;
  if (!altsOn) {
    alts = null; altsJob = null; spots = null; spotHover = -1;
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
    ? { notes: notes.slice().sort((a, b) => a.pitch - b.pitch), picked: new Map() } : null;
  spots = null; spotHover = -1;
  fretboardShape.setAttribute("aria-pressed", String(!!shaping));
  // Context controls change width when shape-building replaces the toggles.
  layoutFretboard();
}

// The walk, drawn: what is placed, filled in the layer's hue, and where the note being
// placed could go, as the same quiet circles the rest of the panel offers. Nothing
// else — no boxes, no other note's options — because sixteen unlabelled circles on one
// neck cannot say which belongs to which note, and this is the one view where that
// question has to have an answer.
//
// A placed mark is a target too: clicking it takes that note back off the board and
// makes it the one being placed, which is the only way back that needs no control.
//
// Returns the note still to be placed, or null when the shape is complete.
function drawShaping(ctx, s, scale, X, Y, lane) {
  const tuning = lane && laneTuning(lane);
  if (!tuning || tuning.length !== s.strings) return null;
  const hue = lane.color || PAINT.accent;
  const placed = [...shaping.picked].map(([note, p]) => ({
    note, pitch: note.pitch, string: p.string, fret: p.fret,
    x: fretCentre(p.fret, s), mm: fretCentre(p.fret, s), placed: true,
    finger: 0, dead: !!note.fx?.dead,
  }));
  const cur = shaping.notes.find((n) => !shaping.picked.has(n)) || null;
  // The note being placed is handed in on string -1, which is no string at all: it
  // spends none of the ones already taken and it has no home to be excluded from.
  const asking = cur ? [{ note: cur, pitch: cur.pitch, string: -1 }] : [];
  const opts = cur
    ? notePlacements([...placed, ...asking], tuning, s.frets, asking)
      .map((p) => spotBox({ ...p, mm: fretCentre(p.fret, s) }, scale, s, X, Y))
    : [];
  spots = [...opts, ...placed.map((m) => spotBox(m, scale, s, X, Y))];
  ctx.lineWidth = 1.8;
  for (let i = 0; i < opts.length; i++) {
    const p = opts[i];
    ctx.strokeStyle = i === spotHover ? hue : PAINT.hint;
    ctx.beginPath();
    ctx.arc((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, Math.max(1, p.r - 0.9), 0, Math.PI * 2);
    ctx.stroke();
  }
  drawGrip(ctx, s, scale, X, Y, placed, hue, true, { digits: false });
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
  Math.round(boardWidth(s) * ((w - 2 * PAD) / boardLength(s)) + 2 * PAD);

// THE PANEL IS AS TALL AS THE TALLER OF ITS TWO HALVES. It used to be the board's own
// height alone, which is a number the strip beside it has no say in — and the strip is
// content: three groups while editing, five on an overridden column, against a bass
// board that comes out around 140px. The panel clips (it has to, so the collapse can
// slide over it), so the overflow landed as a chord name with its top and bottom cut
// off. Growing instead costs the song a few pixels while the neck is being worked on
// and gives them straight back; the stylesheet's 50% cap still has the last word.
//
// The board does not stretch into the extra room: both mm to px scales are bound by
// whichever axis is tighter, so a height-rich panel simply centres the neck in it.
const preferredHeight = (w, s) => Math.max(boardHeight(w, s), stripHeight());

// = --s-group, the strip's own padding. A second name for 16 because it is a second
// reason for it: PAD above is the canvas's inset.
const STRIP_PAD = 16;

// How tall the strip's content is, measured off the children rather than read from
// scrollHeight — which drops the bottom padding often enough that the panel would come
// out one inset short exactly when the strip is what is binding.
function stripHeight() {
  const kids = [...fretboardSide.children].filter((el) => !el.hidden && getComputedStyle(el).position !== "absolute");
  if (!kids.length) return 0;
  const top = kids[0].getBoundingClientRect().top;
  const bottom = kids[kids.length - 1].getBoundingClientRect().bottom;
  return Math.round(bottom - top) + 2 * STRIP_PAD;
}

// Two ways in — the View menu item and the panel's own chevron — so both go
// through here and the check, the chevron and the panel cannot disagree.
// The collapsed panel retains a read-only neck preview and its reopen chevron.
export function setFretboardVisible(on) {
  fretboardPanel.style.transition = "";
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
  // Closing the panel leaves the mode behind with it: reopening on a neck that is
  // still armed to edit is how a stray click becomes a shift nobody asked for.
  if (!visible) {
    fretboardBusy.hidden = true;
    endResetPreview();
    fretboardAuto.hidden = true;
    editing = false;
    fretboardPanel.removeAttribute("data-editing");
    fretboardEdit.setAttribute("aria-pressed", "false");
    fretboardContext.hidden = true;
    altsOn = false; alts = null; altsJob = null;
    spots = null; spotHover = -1; hoverFret = 0; shaping = null;
    fretboardShape.hidden = true;
    fretboardApply.hidden = true;
  }
  $("menuFretboardCheck").hidden = !visible;
  const label = visible ? "Hide fretboard" : "Show fretboard";
  syncPanelControls("fretboard", visible, label);
  layoutFretboard(true);      // this one IS the gesture
}

// Only opening/closing animates. Size changes from window resizing or instrument
// changes settle immediately. The neck is measured at its destination size, then
// revealed by the panel's clip, so it never stretches during the transition.
function layoutFretboard(slide = false) {
  const cssW = fretboardStage.clientWidth;
  if (cssW < 2 * PAD) return;
  const spec = laneSpec(currentLane());
  const height = Math.min(preferredHeight(cssW, spec), editorEl.clientHeight / 2);
  // Resize observers also fire while adjacent panels move. Repainting the same
  // destination must not cancel a reveal that is already running.
  const snap = visible && !slide && fretboardPanel.style.height !== height + "px";
  if (snap) fretboardPanel.style.transition = "none";
  laidOut = spec;
  fretboardPanel.style.height = visible ? height + "px" : "";
  // The board's box is pinned to the height the panel has *open*, so that closing the
  // panel slides it out of view instead of squashing it: the flex row would otherwise
  // stretch a neck into the collapsed bar while closing.
  fretboardStage.style.height = Math.max(0, height - parseFloat(getComputedStyle(fretboardPanel).borderTopWidth)) + "px";
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
  const x0 = fretDistance(n - 1, s.scale), x1 = fretDistance(n, s.scale);
  const h0 = boardHalfWidthAt(x0, s), h1 = boardHalfWidthAt(x1, s);
  ctx.beginPath();
  ctx.moveTo(X(x0), Y(-h0)); ctx.lineTo(X(x1), Y(-h1));
  ctx.lineTo(X(x1), Y(h1)); ctx.lineTo(X(x0), Y(h0));
  ctx.closePath();
}

export function drawFretboard() {
  if (editorEl.hidden || !S.state) return;
  const ctx = fretboardEl.getContext("2d");
  const dp = dpr(), w = fretboardEl.width / dp, h = fretboardEl.height / dp;
  ctx.setTransform(dp, 0, 0, dp, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // The lane whose hand this is, and its open strings. A lane whose tuning has
  // another string count than its instrument's neck gets the instrument and nothing
  // else, so its tuning is not drawn either.
  const lane = currentLane();
  // Whether the player put the hand on this beat. Hoisted because holdHere walks
  // songBarStarts(), which rebuilds the bar list on every call, and this runs per frame.
  const held = holdHere(lane);
  const s = laneSpec(lane);
  // A different instrument is a different board shape, so the panel is the wrong
  // height until the layout has seen it. One bounce: layoutFretboard draws again.
  if (s !== laidOut) { layoutFretboard(); return; }
  const last = fretDistance(s.frets, s.scale);
  const tuning = lane ? laneTuning(lane) : null;
  // How much room a name beside a string has, measured off the scale the board would
  // take with no gutter — within a few percent of the real one, which is circular,
  // and this only has to choose between three sizes. A string at the nut is a pitch
  // row, so it gets rule 6's anchored 9 when 11 will not fit, and nothing when 9
  // will not either: the same "drop the label too wide for its note" the stage does.
  const rowPx = (s.spreadAtNut / (s.strings - 1))
    * Math.min((w - 2 * PAD) / boardLength(s), (h - 2 * PAD) / boardWidth(s));
  const tunePx = rowPx >= 11 ? 11 : rowPx >= STAGE_ANCHORED ? STAGE_ANCHORED : 0;
  const strung = tuning && tuning.length === s.strings && tunePx ? tuning : null;
  // The tuning's own gutter, left of the nut. Its width follows the widest name it
  // has to hold (rule 13) rather than a chosen number, so a drop tuning cannot run
  // out under the nut; 8 is the gap from the name to the board.
  ctx.font = stageMono(tunePx || 11);
  const gutter = strung
    ? Math.max(...strung.map((p) => ctx.measureText(noteName(p)).width)) + 8 : 0;
  // One scale for both axes — the whole point. Whichever dimension binds, binds.
  const scale = Math.min((w - 2 * PAD - gutter) / boardLength(s), (h - 2 * PAD) / boardWidth(s));
  if (!(scale > 0)) return;
  const originX = PAD + gutter + (w - 2 * PAD - gutter - boardLength(s) * scale) / 2
    + s.nutDepth * scale;
  const X = (mm) => originX + mm * scale;              // mm from the nut
  const Y = (off) => h / 2 + off * scale;              // mm from the centreline
  // Kept for the pointer, exactly as `alts.boxes` is: hit-testing against the frame
  // the pointer was resolved in cannot disagree with what is on screen, and a board
  // that has not been drawn yet has nothing to click.
  view = { originX, scale, mid: h / 2, s };
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

  // IN EDIT MODE THE WOOD IS A CONTROL, so it answers the pointer the way every other
  // control does (rule 9). The fill is the one rule 15 already names for something that
  // sits on the stage and cannot take --control: --stage-chrome-hover, one step off the
  // board's own --stage-chrome. Painted straight onto the slab and UNDER the inlays,
  // because what lights up is the board itself and not a mark laid on it — which is
  // also what keeps it from being read as a second anchor band.
  if (hoverFret > 0 && hoverFret <= s.frets) {
    ctx.fillStyle = PAINT.chromeHover;
    fretSpace(ctx, hoverFret, s, X, Y);
    ctx.fill();
  }

  // Inlays, cut into the board, so they sit under the strings and the frets.
  ctx.fillStyle = hexA(PAINT.label, 0.45);
  for (const n of s.dots) {
    const cx = dotCentre(n, s), r = (s.dotDiameter * scale) / 2;
    const half = boardHalfWidthAt(cx, s);
    // A pair splits the board, one dot centred in each half.
    for (const off of s.doubleDots.includes(n) ? [-half / 2, half / 2] : [0]) {
      ctx.beginPath();
      ctx.arc(X(cx), Y(off), r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

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
  const seat = anchorFret(lane);
  if (seat > 0 && seat <= s.frets) {
    ctx.fillStyle = hexA(lane?.color || PAINT.accent, WASH);
    fretSpace(ctx, seat, s, X, Y);
    ctx.fill();
  }

  // Frets: nickel, and the brightest thing after the nut because they are what
  // the eye measures the board by.
  ctx.fillStyle = hexA(PAINT.label, 0.6);
  for (let n = 1; n <= s.frets; n++) {
    const d = fretDistance(n, s.scale), half = boardHalfWidthAt(d, s);
    ctx.fillRect(X(d) - (s.fretCrown * scale) / 2, Y(-half),
      Math.max(1, s.fretCrown * scale), half * 2 * scale);
  }

  // The nut is bone: lighter than the wire, and the only part of this that is
  // not metal.
  ctx.fillStyle = PAINT.text;
  ctx.fillRect(X(-s.nutDepth), Y(-nutHalf), s.nutDepth * scale, nutHalf * 2 * scale);

  // Strings, at their real gauges — the low E is four times the high E and looks
  // it. Straight from the nut slot to the bridge, which is why they fan out.
  ctx.strokeStyle = hexA(PAINT.label, 0.65);
  for (let i = 0; i < s.strings; i++) {
    ctx.lineWidth = Math.max(1, s.gauges[i] * scale);
    ctx.beginPath();
    ctx.moveTo(X(-s.nutDepth), Y(stringOffsetAt(i, 0, s)));
    ctx.lineTo(X(last + s.overhang), Y(stringOffsetAt(i, last + s.overhang, s)));
    ctx.stroke();
  }

  // Fret numbers below the board, on the dotted frets only — a number under
  // every fret is 22 numbers nobody reads. Mono, because a fret number is a
  // value you compare (rule 6).
  ctx.fillStyle = PAINT.label;
  ctx.font = stageMono(11);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const n of s.dots) {
    const cx = dotCentre(n, s);
    ctx.fillText(String(n), X(cx), Y(boardHalfWidthAt(cx, s)) + 4);
  }

  // The tuning, at the nut, where a player looks for it — it is the one thing the
  // drawn instrument cannot state, and without it fret 5 on the top string names no
  // pitch at all. Right-aligned against the nut, and mono because a pitch is a
  // value (rule 6), in the same tier as the fret numbers because it does the same
  // job: annotating the board rather than being part of it.
  if (strung) {
    ctx.font = stageMono(tunePx);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i < s.strings; i++)
      ctx.fillText(noteName(strung[i]), X(-s.nutDepth) - 8, Y(stringOffsetAt(i, 0, s)));
  }

  // WHICH GRAIN IS DECIDED BY THE COLUMN, not by a second switch. A lone note has one
  // question — which string — and every answer to it is legal, so it gets circles and
  // no boxes: a box drawn around a single circle says nothing. A chord's question is
  // the COMBINATION, and most combinations are not playable, so it gets the boxes the
  // engine vouched for and no free per-note circles. Building a combination nobody
  // vouched for is what the shape walk is for, and it is a mode you ask for.
  const at = editing ? focusGrip(lane, s) : null;
  const chord = (at?.marks.length || 0) > 1;
  spots = null;
  // And the working views stand down with it. They are offers about one column, so a
  // column arriving sixty times a second makes them noise — and the boxes would ask the
  // worker for a fresh set on every one of them.
  const offering = altsOn && !shaping && !transportPlaying();
  const hovered = offering && chord ? drawAlternatives(ctx, s, scale, X, Y, lane, at) : null;
  const spot = offering && at && !chord ? drawNotePlaces(ctx, s, scale, X, Y, lane, at) : null;
  const placing = shaping ? drawShaping(ctx, s, scale, X, Y, lane) : null;
  const label = drawHand(ctx, s, scale, X, Y, lane, !!hovered || !!spot || !!shaping || resetPeeking);
  drawResetControl(ctx, s, scale, X, Y, lane, held, w, h);
  if (hovered) drawOffer(ctx, s, scale, X, Y, hovered, lane);
  if (spot) drawNoteOffer(ctx, s, scale, X, Y, lane, spot);
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
  const waiting = lane?.notes?.length
    ? !gripsFor(lane) ? "Working out the fingering"
      : offering && chord && !alts ? "Finding other positions" : ""
    : "";
  fretboardBusy.hidden = !waiting;
  if (waiting && fretboardBusyLabel.textContent !== waiting) fretboardBusyLabel.textContent = waiting;
  // What is being held goes in the strip, not on the wood. Over the nut it was mono
  // 11 in the board's own top-left corner — the size of a fret number, in the room the
  // instrument needs, read at an angle nothing else on the panel is read at. In the
  // strip it is the panel's heading and the stylesheet gives it the heading tier.
  // While a shape is being built the heading names the note being placed, which is the
  // one thing you need to know and the reason there is no sentence anywhere saying what
  // to do (rule 24). Complete, it goes back to naming the chord — which is now the
  // shape you built, and the last thing to check before Apply.
  const shown = placing ? noteName(placing.pitch) : label;
  if (fretboardName.textContent !== shown) fretboardName.textContent = shown;
  // WHAT IS BEING HELD IS FOR READING, NOT FOR WORKING ON. Editing, the panel is about
  // where the notes could go instead, and a 24px chord name is the loudest thing in a
  // strip whose other rows are the controls you came for. The walk keeps the slot,
  // because the note it is asking for is not the chord name — it is the one thing you
  // need to know while placing it.
  fretboardName.hidden = false;
  // Chords only: a lone note has every position on the board already.
  fretboardShape.hidden = !editing || (!chord && !shaping);
  fretboardApply.hidden = !shaping || !!placing;
  refreshPinControls(lane, held);
  fretboardContext.hidden = !editing || !visible ||
    (fretboardShape.hidden && fretboardApply.hidden && fretboardPin.hidden);
  // THE STRIP IS CONTENT AND THE PANEL IS AS TALL AS THE STRIP, so anything appearing
  // or going in it — the mode's toggles, the chord name, an override's controls — is a
  // re-layout and not only a repaint. Measured rather than enumerated, so a group
  // added to the strip later needs no second place to remember it exists. Next frame,
  // because this runs inside the draw a layout would call.
  const strip = stripHeight();
  if (strip !== laidOutStrip) {
    laidOutStrip = strip;
    requestAnimationFrame(() => layoutFretboard());
  }
}

// The override's own controls, on the column the board is showing. Absent unless that
// column has an override — a control that never varies states nothing (rule 24), and
// on an automatic column there is neither a reach to set nor anything to return from.
function refreshPinControls(lane, held) {
  // Inside the mode, like the toggles above it and for the same reason: how far an
  // override reaches and how to take it back are questions you have while editing,
  // and outside one they are two rows of controls sitting on the song.
  const col = editing ? pinnedColumn(lane) : null;
  // A hand put on this beat is an override too, and the way back off it is the same
  // button: the panel has one Automatic and it undoes whatever the player put here.
  fretboardPin.hidden = !!shaping || !(!!col || (editing && !!held));
  if (!col) { fretboardReach.hidden = true; return; }
  // A reach lives ON a pin, and a column can be overridden without one: an override
  // that dropped or added notes leaves `written` behind so Automatic can put the
  // original chord back, and the survivors may all be automatic again. There is
  // still a way back to offer there, and nothing to set a reach on.
  const pinned = col.notes.some((n) => n.pos || n.arrangement);
  fretboardReach.hidden = !pinned;
  if (!pinned) return;
  const reach = overrideInfluence(col.notes);
  fretboardReachPrev.setAttribute("aria-pressed", String(!!reach.previous));
  fretboardReachNext.setAttribute("aria-pressed", String(!!reach.next));
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

let resetPeeking = false;
let resetPreview = null;
function endResetPreview() {
  resetPeeking = false;
  if (resetPreview?.pending) { resetPreview.controller.abort(); resetPreview = null; }
  $("fretboardResetStatus").hidden = true;
}

function drawResetControl(ctx, s, scale, X, Y, lane, held, width, height) {
  const column = editing && !shaping ? pinnedColumn(lane) : null;
  const enabled = editing && !shaping && !transportPlaying() && (!!column || !!held);
  fretboardAuto.hidden = !enabled;
  if (!enabled) { endResetPreview(); return; }
  const grip = focusGrip(lane, s);
  const focus = focusNote(lane);
  const mark = grip?.marks.find(m => m.pitch === focus?.pitch) || grip?.marks[0];
  const mx = mark ? X(mark.x) : X(fretCentre(held?.fret || 1, s));
  const my = mark ? Y(stringOffsetAt(mark.string, Math.max(0, mark.x), s)) : height / 2;
  const left = Math.max(4, Math.min(width - 28, mx + 12));
  const top = Math.max(4, Math.min(height - 28, my - 12));
  fretboardAuto.style.left = `${left}px`;
  fretboardAuto.style.top = `${top}px`;
  if (!resetPeeking) return;

  const time = beatUnderBoard();
  const key = `${handKey(lane)}:${column?.t0 ?? focus?.start}:${time}:${songBarStarts().join(',')}`;
  if (resetPreview?.key !== key) {
    resetPreview?.controller.abort();
    const controller = new AbortController();
    const request = { key, controller, pending: true, columns: null };
    resetPreview = request;
    Promise.resolve().then(() => laneFingering(overrideResetPreview(lane, column?.notes, time), controller.signal)).then(fingering => {
      if (resetPreview !== request) return;
      request.columns = gripsFrom(fingering); request.pending = false;
      drawFretboard();
    }).catch(() => {
      if (resetPreview !== request) return;
      request.pending = false;
      drawFretboard();
    });
  }
  const status = $("fretboardResetStatus");
  status.hidden = false;
  const at = resetPreview.columns && handAt(resetPreview.columns, grip?.start ?? focus?.start ?? playbackTime(), 0, s);
  status.textContent = resetPreview.pending ? "Calculating preview" : at ? "Reset preview" : "Preview unavailable";
  if (at) {
    ctx.save();
    ctx.setLineDash([3, 2]);
    drawGrip(ctx, s, scale, X, Y, at.marks, PAINT.accent, false, { digits: false });
    ctx.restore();
  }
}

// The grip, on top of everything. A finger holding a note down is a disc filled in
// **the layer's own colour** — the same hue as its notes on the stage and its dot in
// the sidebar, so all three refer to the object the same way. It was --stage-accent
// first, on the grounds that a pressed string is "checked"; it is not. Nothing
// selected it, and accent said the same thing about every layer, which is the one
// thing a marker on a neck must not do when the sidebar is holding six of them.
// A finger on its way to the next grip is the same disc outlined in that hue, which
// is the button spec's own filled-versus-outlined idiom and not a size change, so
// rule 5 holds: the marker never grows or shrinks and the eye tracks one object.
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

// A marker is as wide as the room between two strings where it sits, so the marks of
// a full chord touch and never overlap. The board sets the size, not taste — and the
// candidate shapes are drawn with the same one, because they are the same object
// offered somewhere else.
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

// An open string rings end to end, so that is how it is drawn: the whole string, in
// the grip's colour, instead of a disc parked on the nut. The disc was the first
// answer and it was a riddle — a circle behind the first fret with a `0` in it, which
// reads as "a finger here" on the one string nothing is holding. Under the marks,
// because a barre at fret 1 sits over the string it is sounding.
//
// Wider than the wire it covers, by a hair: at the top string's real gauge the glow
// would be a 1px line, and 1px of hue on 1px of nickel is not a signal.
function glowString(ctx, s, scale, X, Y, i, hue) {
  const end = fretDistance(s.frets, s.scale) + s.overhang;
  ctx.strokeStyle = hue;
  ctx.lineWidth = Math.max(1.5, s.gauges[Math.round(i)] * scale);
  ctx.beginPath();
  ctx.moveTo(X(-s.nutDepth), Y(stringOffsetAt(i, 0, s)));
  ctx.lineTo(X(end), Y(stringOffsetAt(i, end, s)));
  ctx.stroke();
}

// Marks that one finger holds at one fret, together; everything else alone. A dead
// note and an open string are never barred — neither is a finger pressing a fret.
function barreGroups(marks) {
  const groups = [], byFinger = new Map();
  for (const m of marks) {
    if (!(m.finger > 0) || !(m.fret > 0) || m.dead) { groups.push([m]); continue; }
    const key = `${m.finger}:${m.fret}`;
    const g = byFinger.get(key);
    if (g) g.push(m);
    else { const fresh = [m]; byFinger.set(key, fresh); groups.push(fresh); }
  }
  return groups;
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
// A disc is a finger, and nothing else is: an open alive string is the string itself
// glowing (glowString above), so the only circles on the board are places something is
// pressed. A muted string keeps its disc and its X, at whatever fret it is played,
// because a mute *is* a hand on the string — the tab writes X there and so does this
// (rule 25). A muted open string is therefore the one circle that lands on the nut,
// and it carries the X that says why.
function drawGrip(ctx, s, scale, X, Y, marks, hue, filled, { digits = true } = {}) {
  for (const m of marks) if (!(m.fret > 0) && !m.dead) glowString(ctx, s, scale, X, Y, m.string, hue);
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
  for (const g of barreGroups(marks.filter((m) => m.fret > 0 || m.dead))) {
    const pts = g.map((m) => ({
      m, x: X(m.x), y: Y(stringOffsetAt(m.string, Math.max(0, m.x), s)),
      r: markRadius(m.x, scale, s),
    }));
    const x = pts[0].x, r = pts[0].r;      // one fret, so one x and one radius
    const ys = pts.map((p) => p.y), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (filled) {
      markPath(ctx, x, y0, y1, r);
      ctx.fillStyle = hue;
      ctx.fill();
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
    const glyph = !digits ? "" : g[0].dead ? FX_GLYPHS.dead : g[0].finger > 0 ? String(g[0].finger) : "";
    if (glyph && r >= STAGE_ANCHORED / 2) ctx.fillText(glyph, x, (y0 + y1) / 2 + 0.5);
  }
}

// Where a set of marks is, ignoring which finger goes there and in what order —
// handColumns computes the same string for the same reason, and for a candidate it is
// what says "this is the grip you already have".
const placeKey = (positions) =>
  positions.map((p) => `${p.string}:${p.fret}`).sort().join(" ");

// Every other place the column could be played: one box per candidate, its marks
// outlined inside it, cheapest-first from the same cost model and the same worker
// call the sidebar's cards were ranked by. The box is the target — a shape is all of its notes or none of them,
// so the pointer picks the grip and not a fret.
//
// One tier below the frets in --stage-hint: label is the fret wire, and at the wire's
// own tier six boxes read as more instrument. The ladder that makes this legible is
// the instrument quietest, the offers above it, the hand loudest.
//
// A QUIET CANDIDATE IS ITS BOX AND NOTHING ELSE. It used to draw a ring per fretted
// note as well, and once the per-note targets moved onto the same toggle that made a
// circle mean two things on one neck — "a place this note can go, click it" and "part
// of a grip you can select". The box already says where the shape sits, because it
// is drawn round exactly those frets. So: a rounded box is a grip, a circle is a note.
// The whole placement (fingers, open strings, mutes) belongs to the **one under the
// pointer**, which is why this returns it instead of drawing it: it is drawn last, over
// the hand, by drawOffer.
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
  let hovered = null;
  ctx.lineWidth = 1.8;
  for (const choice of found.ranked) {
    const positions = [...choice.shape.values()];
    if (placeKey(positions) === heldKey) continue;   // the hand is not another position
    const mm = shapeBox(positions, s);
    if (!mm) continue;
    // Padded by a marker, so the border holds the shape instead of cutting it, and
    // rounded like any other container in the app (rule 2).
    const pad = markRadius(mm.x1, scale, s) + 3;
    // The choice rides on its box, so the pointer cannot pick a shape by index and
    // land on a different one: a candidate with no drawable position has no box.
    const box = {
      choice,
      x0: X(mm.x0) - pad, x1: X(mm.x1) + pad,
      y0: Y(mm.off0) - pad, y1: Y(mm.off1) + pad,
    };
    if (boxes.length === found.hover) hovered = box;
    boxes.push(box);
    if (hovered === box) continue;              // drawn last, in full
    ctx.strokeStyle = PAINT.hint;
    boxPath(ctx, box);
    ctx.stroke();
  }
  found.boxes = boxes;
  return hovered && { box: hovered, tuning: found.tuning };
}

// WHAT A POSITION COSTS IS NOT WRITTEN ON IT ANY MORE. Every box carried its
// difference from the grip in the hand — "-4.3", "+1.8" — with the absolute in the
// strip, and the boxes were sorted by it. Both are gone: the question the neck
// answers is WHERE THE HAND GOES, and a number ranking six shapes answers a
// different one, in units (frets of travel, summed) that read as a score.
//
// The price itself stays in the engine and is not dead: it is what drops an offer
// that sits past this instrument's last fret, since the shape enumerator still
// enumerates to fret 24 for every neck. It decides what is shown, not what is said
// about it. The boxes' order is now only their paint order, and pickBox takes the
// smallest box under the pointer rather than the first, so nothing you click
// depends on it.

const boxPath = (ctx, b) => {
  ctx.beginPath();
  ctx.roundRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 8);
};

// The candidate under the pointer, over everything including the hand: the whole grip
// as the hand would hold it — barres, finger numbers, open strings ringing — in the
// colour it will have once it is taken, because hover is a preview of the commit. A
// brighter border alone answered "which one am I on" and not "what would I be
// playing", which is the question a neck is for.
//
// Fingers are asked of assignFingers, the same function the exported tab asks, so the
// numbers on the offer and the numbers on the hand mean the same thing. Outlined,
// still: filled is what the hand does, and only one grip is being played.
function drawOffer(ctx, s, scale, X, Y, hovered, lane) {
  const { choice } = hovered.box;
  // The fingering the ENGINE would use if this shape were taken, keyed by string and
  // priced by the same solve that produced the number on the box. assignFingers is the
  // fallback for a shape the worker could not price: it reads a fingering off the shape
  // alone, which always makes a lone note the index on its own fret — true of no hand
  // that arrived from somewhere.
  const loose = choice.fingers?.size
    ? null : assignFingers(choice.shape, handProfileForTuning(hovered.tuning));
  const marks = choice.notes.flatMap((n) => {
    const p = choice.shape.get(n);
    return p ? [{
      string: p.string, fret: p.fret,
      finger: (loose ? loose.get(n) : choice.fingers.get(p.string)) || 0,
      dead: !!n.dead, x: fretCentre(p.fret, s),
    }] : [];
  });
  const hue = lane.color || PAINT.accent;
  ctx.strokeStyle = hue;
  ctx.lineWidth = 1.8;
  boxPath(ctx, hovered.box);
  ctx.stroke();
  drawGrip(ctx, s, scale, X, Y, marks, hue, false);
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
  return handAt(found.columns, frozenAt(lane) ?? playbackTime(), 0, s);
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
// filled. What is left is exactly the set of legal single-note moves, so a ring is
// never an offer that lapses.
// Limitation: a swap (two notes trading strings) is two clicks, not one gesture.
function notePlaces(lane, s, at) {
  const tuning = lane && laneTuning(lane);
  if (!at || !tuning || tuning.length !== s.strings) return null;
  return { at, out: notePlacements(at.marks, tuning, s.frets)
    .map((p) => ({ ...p, mm: fretCentre(p.fret, s) })) };
}

// Quiet, a ring says WHERE and nothing else — the same tier and the same stroke the
// candidate boxes use, for the same reason: at the fret wire's own brightness a
// field of them reads as more instrument. What the move would actually play belongs
// to the one under the pointer, which is why this returns it rather than drawing it.
function drawNotePlaces(ctx, s, scale, X, Y, lane, at) {
  const got = notePlaces(lane, s, at);
  if (!got) return null;
  const list = got.out.map((p) => spotBox(p, scale, s, X, Y));
  spots = list;
  const hovered = list[spotHover] || null;
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = PAINT.hint;
  for (const p of list) {
    if (p === hovered) continue;
    ctx.beginPath();
    ctx.arc((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, Math.max(1, p.r - 0.9), 0, Math.PI * 2);
    ctx.stroke();
  }
  return hovered ? { hovered, at: got.at } : null;
}

// And hovering one shows the WHOLE grip it would make, in the layer's hue, outlined
// — barres, finger numbers, open strings ringing. A brighter ring would answer "which
// one am I on"; the question a neck is for is "what would I be playing", and moving
// one note re-fingers the hand around it. The fingers come from assignFingers, the
// same function the exported tab asks, so the numbers mean what the tab will say.
function drawNoteOffer(ctx, s, scale, X, Y, lane, { hovered, at }) {
  const moved = (m) => (m.note === hovered.note
    ? { ...m, string: hovered.string, fret: hovered.fret, x: fretCentre(hovered.fret, s) } : m);
  const marks = at.marks.map(moved);
  const shape = new Map(marks.map((m) => [m.note, { string: m.string, fret: m.fret }]));
  const fingers = assignFingers(shape, handProfileForTuning(laneTuning(lane)));
  drawGrip(ctx, s, scale, X, Y,
    marks.map((m) => ({ ...m, finger: fingers.get(m.note) || 0 })),
    lane.color || PAINT.accent, false);
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

// Draws the hand and returns the name of what it is holding, for the readout.
//
// `quiet` is the hand while a position is being considered: an offer is on the board
// in the layer's colour, and two grips in one colour on one neck is a picture of a
// hand with six fingers. So the current shape drops to the candidates' tier and
// becomes another outline — still there to compare against, no longer the loudest
// thing on the board. It is the same swap the offer makes in reverse.
// Which fret the hand is anchored on right now — the same column drawHand draws, so
// the band and the grip can never disagree about which moment they are showing.
function anchorFret(lane) {
  if (!lane?.notes?.length) return 0;
  // A box under the pointer is a question about where the hand WOULD go, so the band
  // goes with it: the offer is drawn as the hand would hold it, and the anchor is part
  // of holding it. The boxes are last frame's, which is the frame the pointer was
  // resolved against, and a moved pointer redraws anyway.
  if (altsOn && alts?.boxes?.length) {
    const box = alts.boxes[alts.hover];
    if (box?.choice?.seat != null) return Number(box.choice.seat) || 0;
  }
  const found = gripsFor(lane);
  if (!found) return 0;
  const i = gripIndex(found.columns, frozenAt(lane) ?? playbackTime());
  return i >= 0 ? Number(found.columns[i].seat) || 0 : 0;
}

function drawHand(ctx, s, scale, X, Y, lane, quiet) {
  // A 6-string board cannot honestly show a bass. Until the bass neck exists,
  // a lane with another string count gets the instrument and no fingers.
  if (!lane || !lane.notes?.length) return "";
  const found = gripsFor(lane);
  if (!found || found.strings !== s.strings) return "";
  // While the positions are on screen the hand holds the column being decided instead
  // of following the playhead: the boxes are a comparison, and a comparison against a
  // moving target is not one. A grip's own onset asks for it pressed and still — the
  // travel window is zero, so nothing can be mid-slide at the moment it starts.
  const frozen = frozenAt(lane);
  const t = frozen ?? playbackTime();
  const hue = lane.color || PAINT.accent;
  if (editing && $("fretboardOnionEnabled").checked) drawOnion(ctx, s, scale, X, Y, found.columns, gripIndex(found.columns, t), hue);
  const at = handAt(found.columns, t, frozen == null ? travelSeconds() : 0, s);
  if (!at) return "";
  if (quiet) {
    drawGrip(ctx, s, scale, X, Y, at.marks, PAINT.hint, false, { digits: false });
    return chordLabel(at.marks.filter((m) => !m.dead).map((m) => m.pitch));
  }

  // The strike: a ring blooming out of the marker and fading, so a rhythm and the
  // direction of a strum are visible without the marker itself moving or changing
  // size. Per note even inside a barre — the sweep *is* the stroke — and before the
  // grip, so it grows out from behind the body. Only where there is a body: an open
  // string's ring is the string, and a ring blooming off the nut marks nothing.
  if (at.pressed) {
    const decay = glowSeconds();
    ctx.lineWidth = 1.8;
    for (const m of at.marks) {
      const u = (t - m.start) / decay;
      if (!(u >= 0 && u < 1) || (!(m.fret > 0) && !m.dead)) continue;
      const r = markRadius(m.x, scale, s);
      ctx.beginPath();
      ctx.arc(X(m.x), Y(stringOffsetAt(m.string, Math.max(0, m.x), s)), r * (1 + u), 0, Math.PI * 2);
      ctx.strokeStyle = hexA(hue, HALO * (1 - u));
      ctx.stroke();
    }
  }
  drawGrip(ctx, s, scale, X, Y, at.marks, hue, at.pressed);
  // A muted string has no pitch, so it names nothing — a grip that is all mutes has
  // no name, which is the honest answer and not a gap.
  return chordLabel(at.marks.filter((m) => !m.dead).map((m) => m.pitch));
}

// ---- putting the hand somewhere ----
// The board is the control. A click on bare wood says "the hand stands here", which
// is one number where choosing a shape is six, and it is the number the voicer
// actually decides with — everything else on the neck follows from it.

let view = null;      // last frame's mm -> px mapping; see drawFretboard
// Which fret the pointer is in, or 0. Only while the wood is a control: outside edit
// mode the board is a picture, and a picture that lights up under the pointer is
// promising something it will not do.
let hoverFret = 0;

// Which fret space a click landed in: the gap a finger sits in, named for the wire at
// its far end, which is how a player names it. Off the wood in either axis is -1, and
// behind the nut is 0 — there is no hand at the nut, so nothing is placed there.
function fretUnder(e) {
  if (!view) return -1;
  const r = fretboardEl.getBoundingClientRect();
  const mm = (e.clientX - r.left - view.originX) / view.scale;
  const off = Math.abs(e.clientY - r.top - view.mid) / view.scale;
  if (mm < 0 || off > boardHalfWidthAt(Math.max(0, mm), view.s)) return -1;
  for (let n = 1; n <= view.s.frets; n++) if (mm <= fretDistance(n, view.s.scale)) return n;
  return -1;
}

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


// Whether the beat under the board has been put there by hand, so the band can say
// so and a second click on the same fret can take it back.
function holdHere(lane) {
  const t = beatUnderBoard();
  return (lane?.handHolds || []).find((h) => Math.abs(Number(h.t) - t) <= 1e-6) || null;
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

function boxUnder(e) {
  if (!altsOn || !alts?.boxes?.length) return -1;
  // clientX against the canvas's own rect, not offsetX: the same reading
  // interaction.js takes for the stage, and the only one a synthetic event carries.
  const r = fretboardEl.getBoundingClientRect();
  return pickBox(alts.boxes, e.clientX - r.left, e.clientY - r.top);
}

export function init_fretboard() {
  fretboardPanel.addEventListener("mouseenter", () => {
    if (!visible) fretboardPanel.classList.add("is-peeking");
  });
  fretboardPanel.addEventListener("mouseleave", () => fretboardPanel.classList.remove("is-peeking"));
  fretboardPanel.addEventListener("click", (event) => {
    if (!visible && !event.target.closest('[data-panel-toggle="fretboard"]'))
      setFretboardVisible(true);
  });
  wireMenu("menuFretboard", () => setFretboardVisible(!visible));
  for (const button of panelControls("fretboard")) button.addEventListener("click", () => setFretboardVisible(!visible));
  // Both reach toggles act on the column the strip is already naming, and both leave
  // the shape exactly as it is — only the blast radius moves.
  for (const [button, side] of [[fretboardReachPrev, "previous"], [fretboardReachNext, "next"]]) {
    button.addEventListener("click", () => {
      const col = pinnedColumn(currentLane());
      if (!col) return;
      setColumnInfluence(col.notes, side, !overrideInfluence(col.notes)[side]);
      drawFretboard();
    });
  }
  for (const type of ["mouseenter", "focus"]) fretboardAuto.addEventListener(type, () => { resetPeeking = true; drawFretboard(); });
  fretboardAuto.addEventListener("mouseleave", () => { if (document.activeElement !== fretboardAuto) { endResetPreview(); drawFretboard(); } });
  fretboardAuto.addEventListener("blur", () => { endResetPreview(); drawFretboard(); });
  fretboardAuto.addEventListener("click", () => {
    const lane = currentLane();
    if (!lane) return;
    endResetPreview();
    clearOverrideAt(lane, pinnedColumn(lane)?.notes || null, beatUnderBoard());
    fretboardEdit.focus({ preventScroll: true });
    drawFretboard();
  });
  fretboardEl.addEventListener("mousemove", (e) => {
    // A circle wins over the box it sits in. Both are clickable, and the smaller
    // mark selects the single-note move when they overlap.
    const spot = spots ? spots.indexOf(spotUnder(e)) : -1;
    const i = spot >= 0 || shaping ? -1 : boxUnder(e);
    const fret = editing && !shaping && spot < 0 ? Math.max(0, fretUnder(e)) : 0;
    fretboardEl.style.cursor = editing && (spot >= 0 || i >= 0 || fret > 0) ? "pointer" : "";
    const moved = spot !== spotHover || fret !== hoverFret;
    spotHover = spot;
    hoverFret = fret;
    if (!moved && (!alts || i === alts.hover)) return;
    if (alts) alts.hover = i;
    drawFretboard();
  });
  fretboardEl.addEventListener("mouseleave", () => {
    fretboardEl.style.cursor = "";
    const moved = spotHover >= 0 || hoverFret > 0;
    spotHover = -1;
    hoverFret = 0;
    if (!moved && (!alts || alts.hover < 0)) return;
    if (alts) alts.hover = -1;
    drawFretboard();
  });
  // The board is a control only while the mode says so. Anywhere on the wood, not
  // only off a candidate box: a box is a drawing of a place the notes could go, and
  // wanting the hand there is the commonest reason to be pointing at one.
  fretboardEl.addEventListener("click", (e) => {
    if (!editing) return;
    const lane = currentLane();
    if (!lane) return;
    // While a shape is being built the board is only that: a circle places the note
    // being placed, a placed mark takes it back off, and bare wood does nothing — the
    // hand is not what you are deciding.
    if (shaping) {
      const pick = spotUnder(e);
      if (!pick) return;
      if (pick.placed) shaping.picked.delete(pick.note);
      else shaping.picked.set(pick.note, { string: pick.string, fret: pick.fret });
      spotHover = -1;
      layoutFretboard();          // Apply arrives or leaves with the last note
      return;
    }
    // Rings place one note, candidate boxes place a whole shape, and bare wood
    // sets the hand position. The smaller ring wins when the marks overlap.
    const spot = spotUnder(e);
    if (spot) { setNotePosition(spot.note, spot.string, spot.fret); return; }
    const box = alts?.boxes?.[boxUnder(e)];
    if (box?.choice) {
      applyColumnAlternative(alts.notes, box.choice, alts.influence);
      return;
    }
    const fret = fretUnder(e);
    if (fret <= 0) return;
    setHandHold(lane, beatUnderBoard(), fret);
  });
  fretboardEdit.addEventListener("click", () => {
    fretboardEdit.blur();            // or it eats the arrow keys that walk the song
    setFretboardEdit(!editing);
  });
  fretboardShape.addEventListener("click", () => {
    fretboardShape.blur();
    setFretboardShape(!shaping);
  });
  // The one place on this panel where work is staged rather than applied as you go, so
  // it is the one place with a primary (rule 20 names the work). It only appears once
  // every note has somewhere to be, so pressing it can only fail on something the walk
  // could not have prevented — a column that moved under the edit — and that is a
  // sentence, not a silent no-op.
  fretboardApply.addEventListener("click", () => {
    fretboardApply.blur();
    const col = shaping && columnOf(shaping.notes[0])?.col;
    if (!col) return;
    const wrong = setColumnShape(col.notes, shaping.picked);
    if (wrong) { toast(wrong); return; }
    setFretboardShape(false);
  });
  // Escape leaves the walk with nothing written, which is what the staging promised.
  // Transient depth: it is canvas state, above the selection and below every window.
  registerEscapeLayer(ESC_DEPTH.transient, () => {
    if (!shaping) return false;
    setFretboardShape(false);
    return true;
  });
  $("fretboardOnionEnabled").addEventListener("change", () =>
    drawFretboard());
  // Watch #editor, not the panel: this writes the panel's own height, and an
  // observer on it would feed itself. #editor is flex-sized by the window and
  // the sidebars, and nothing here mutates it.
  new ResizeObserver(() => layoutFretboard()).observe(editorEl);
  // The markup ships collapsed so the first paint has nothing to animate; this is
  // what puts the menu's check, the pull's label and `visible` in step with it.
  setFretboardVisible(visible);
  setFretboardEdit(false);
}
