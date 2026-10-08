// The voicing cost engine: pure note→(string,fret) assignment, no DOM. Split from
// voicing.js (which keeps the chord-preview UI and re-exports everything here) so
// the model is importable headless — tests/voicing.test.mjs runs it under node.

import { noteName } from "./util.js";
import { fretboardFor } from "./fretboard-core.js";

// One source of truth for string/fret choice, shared by the chord preview and
// (via buildTabSpec) the Guitar Pro export, so what you see is what you export.
// Notes are grouped into onset columns; each column is voiced as a playable
// shape (one note per string, hand within reach, no dropped notes) by a small
// backtracking search; a DP across columns then picks the sequence of shapes
// that minimizes hand movement.
export const MAX_FRET = 24;

// Fretting fingers, index through little. The thumb is not modeled, and a barre
// is one finger across strings — so this also bounds the number of DISTINCT
// frets any playable shape can hold.
export const MAX_FINGERS = 4;

export const HAND_SPAN = 8;      // generous search guard; physical finger-pair reach decides comfort/feasibility

export const SHAPES_PER_COL = 6; // alternatives shown in the chord preview
export const DP_SHAPES_PER_COL = 18; // final context-aware search set
export const DP_CONTEXT_POOL = 48;   // broader pool inspected before neighbouring context prunes it

// Biomechanical cost model — "Model v2". String/fret shapes remain the public
// format, but the optimizer expands them into explicit finger assignments. See
// docs/voicing-cost-model.md §8. Four ideas drive it:
//   1. Position is NOT a standing tax. Where the hand sits barely matters; what
//      matters is assigned-finger reach in physical millimetres, finger
//      interaction, barres, muting/clearance, and how far the hand must MOVE.
//   2. The hand is a RANGE, not a point: with the index at fret h the fingers cover
//      h..h+COMFORT_REACH, so any next shape reachable from where the hand already
//      sits costs no movement — a 5-6-7-8 run in one position is free, as it should
//      be. Movement is the gap between reach windows (frets) + string distance,
//      scaled by the time available: a big jump between fast notes is dear, the same
//      jump across a rest is cheap.
//   3. Open strings don't involve the fretting hand: an all-open column is
//      TRANSPARENT — the hand neither moves to "fret 0" nor gets pulled anywhere,
//      it just holds its position through the note. Whether to *use* opens at all
//      is decided by the cost model like everything else, not by a preference.
export const COMFORT_REACH = 3;  // index→pinky comfortably covers ~4 frets (span ≤ 3)

export const HIGH_GATE = 12;     // flat one-shot penalty once the hand climbs past fret 12 (Heijink & Meulenbroek: where reaching over the guitar body kicks in)

// Weights are starting values, tuned against the r12 bass phrase; `home`, `stick`
// and the timeFactor bounds are the load-bearing knobs (docs/voicing-cost-model.md §6).
// `home` = gentle pull toward the resting register (auto). `stick` = the stronger
// pull a forward pin exerts over its segment, holding the passage near the pinned
// fret so a manual "play it up here" actually carries into the later notes.
// `slide` = fallback penalty only when source data has no legal connected-slide
// route. Whenever a physical route exists, illegal edges are removed outright.
export const COST_W = {
  finger: 0.26,
  barreString: 0.05,
  mute: 0.52, innerSkip: 0.85, strokeSkip: 1.65,
  openClearance: 0.34, edgeControl: 0.10,
  // `stick` reads as dead in every corpus sweep and is not: it weights the pull
  // toward a PINNED fret (see repeatedFingeringPlan), and no benchmark tab contains
  // a pin. Same blind spot as `unplayable` and `slide` -- a term the corpus cannot
  // reach is untested, not inert.
  // THE NUT PULL, AND IT CARRIES TWICE WHAT IT USED TO because the thing that was
  // quietly doing half its job is gone. While a remembered pitch was a hard constraint
  // (see MEMO_SLACK), the first placement of every pitch in a lane was stamped on all
  // the later ones — and the first bar of a song is usually the lowest, so the memory
  // was an accidental anchor at the nut. Freed, the hand drifted up the neck: Stairway's
  // fingerpicked acoustic moved a passage from frets 0-3 onto the A string at 7, which
  // is not a fingerpicked part any more. At 0.15 that lane comes back and nothing else
  // moves; the corpus is flat from 0.08 to 0.30 (65.1 to 64.1 points of melody
  // agreement) so this is the middle of a plateau, not a peak. It was 0.05.
  high: 2, home: 0.15, stick: 0.35,
  // Three nudges decide WHERE on the neck a passage sits, and until now only two
  // existed — as one axis, not two. For a given pitch, one string thicker is
  // exactly +5 frets, so "toward the nut" and "toward the thick strings" are the
  // same line read from opposite ends: their sum stays linear and only an END of
  // it can ever win. That is why every miss in the melody corpus ran the same
  // direction (want s1f10 got s0f5, want s2f7 got s1f3, want s3f5 got s2f0 —
  // one string thinner, five frets lower, every time). `home` owned the low end
  // and nothing pulled back.
  //
  //   stringSide  per shape, toward the thicker strings
  //   highRamp    per fret above highKnee, back toward the nut
  //   home        the gentle standing pull toward the nut (unchanged)
  //
  // The ramp is what makes an interior answer reachable at all: a cliff at
  // highGate cannot separate candidates that all sit below it, and a bass D#2 on
  // D1 / A6 / E11 is exactly that case. A knee at 7 rising gradually gives the
  // middle option somewhere to win. highGate keeps its own flat charge on top —
  // reaching over the guitar body is a real discontinuity, not a slope.
  // `stringSide` IS GONE — the standing pull toward the thick strings, 0.15 per string
  // for every shape in the app. It was measured while a remembered pitch was a hard
  // constraint (see MEMO_SLACK), which is to say while most notes were not being chosen
  // at all, and freed of that it is worth -0.8 points of melody agreement, -0.8 of
  // chord and +0.8 points of leap rate: deleting it is better on every figure the
  // corpus reports. What it was for survives as stringSideMono below, which is the
  // same pull scoped to the register where a player actually makes that choice.
  highRamp: 0.05, highKnee: 5,
  // A single note and a chord want opposite things from the two rules above, so
  // each gets its own. A chord keeps the shared settings; a single note gets:
  //
  //   gateMono 15   the fret the high-fret charge fires at, not 12. 12 was one
  //                 fret under where a lead line actually sits, so the charge
  //                 was shoving whole solos off the neck for no gain anywhere
  //                 else: it cost the corpus's lead lane 10 points on its own.
  //                 It stays 12 for chords, where nothing wanted it moved and
  //                 where it is what keeps an unreachable grip priced above a
  //                 merely hard one (tests/voicing.test.mjs).
  //   stringSideMono / sidePitchGate
  //                 the thick-string pull, but only above B4. Below that it is
  //                 the shared 0.15. Applied to every single note it destroys a
  //                 fingerpicked part — an arpeggio in open position is single
  //                 notes too, and dragging those onto wound strings cost the
  //                 acoustic lane 32 points. Register is the axis that separates
  //                 them, not chord-vs-note. Above B4 the note exists on the top
  //                 two or three strings only, and the choice is exactly the one
  //                 a player makes by feel: the B string up the neck rather than
  //                 the top E in the middle of it, because the thicker string
  //                 gives a bend something to push against. Under B4 the same
  //                 pull reaches the wound strings and stops being that choice.
  //
  // Every number here is the corpus optimum with no lane regressing: the lead
  // lane gains 15.6 points, and the acoustic, the bass and all 3269 chord-corpus
  // fingerings do not move at all.
  // AND IT IS EXACTLY FIVE TIMES `home`, which is not a fit — it is the one value that
  // makes the axis balance. One string thicker is the same pitch five frets up, so a
  // pull of 5 x home per string is precisely the nut pull cancelled: above B4 the
  // engine is indifferent between the thick string up the neck and the thin string in
  // the middle of it, and the choice falls to the transition and the grip, which is
  // where a lead player leaves it. Swept independently the corpus peaks at 0.75-1.0
  // and falls away either side, so the derived value sits inside the measured plateau
  // rather than being argued into it. It was 0.5, from before `home` doubled.
  stringSideMono: 0.75,
  sidePitchGate: 71,
  // THE CLIMB. For one pitch the neighbouring thicker string is the same note
  // five frets up, and a player takes it — while it lands somewhere comfortable.
  // Measured off the corpus, counting only notes where both options existed:
  //
  //   thinner option sits at   open   1-2    3-4    5-7    8-11    12+
  //   bass took the thicker     88%   57%     0%     0%      -       -
  //   lead took the thicker     95%  100%    75%    27%     67%     15%
  //
  // So it is not a standing preference for thick strings — stringSide already
  // is one, and being linear it can only ever pick an end (see above). It is a
  // bonus that switches off once the destination climbs past climbFret, which
  // is what gives the axis an interior answer instead of two extremes.
  //
  // climbStep is what stops it wrecking a fingerpicked part. The acoustic lane
  // takes the thicker string 13% of the time at the very bottom of the neck
  // where the other two take it 88-95%, because its single notes are not a line
  // at all — they are one chord shape picked apart, 85% of its intervals being
  // leaps of a third or more against a median of 2 semitones on the other two.
  // The string of an arpeggiated note is set by the shape the hand is holding,
  // so nothing should be bidding on it per note. Requiring a semitone neighbour
  // is a narrow test for "this is a melody", and a narrow one is what is wanted:
  // ungated, the climb cost the acoustic 13.6 points; at a whole tone, 2.7; at a
  // semitone, one note.
  //
  // climbBonus is capped by the hand, not by the corpus: 0.2 and 0.3 score the
  // same here, but at 0.3 the credit outgrows what it costs to move, and a
  // chromatic run sitting comfortably at frets 5-8 breaks off mid-run for the
  // same notes lower down (tests/voicing.test.mjs, the run-in-one-position
  // case). The climb decides between placements of a note the hand is free to
  // put anywhere; it must never outbid staying where the hand already is.
  // mstring was fitted while a crossing was a flat COUNT of strings; measured, the
  // same 0.35 became 0.45 on a bass and cost that lane 0.8 points. Refitted it lands
  // at 0.30 and every lane returns to the number it had, which is what a units fix
  // should do: the model stops depending on the instrument by accident, and nothing
  // on screen moves. The corpus is flat from 0.25 to 0.30 and falls above it, so this
  // is the dear end of the range the evidence allows.
  mfret: 1, mstring: 0.30, fingerMove: 0.48,
  // What ONE FINGER moving sideways costs against the same finger sliding the same
  // distance along the neck. It lived inline in transitionResult as a bare 0.65 and
  // is a weight, not a ratio of millimetres: 7mm across the strings is nothing like
  // 7mm along them, so it does not become 0.19 just because that is the geometry.
  // What it now multiplies IS measured — see stringTravelUnits.
  fingerSide: 0.65,
  place: 0.12, pivot: 0.30, slide: 8,
  glide: 0.45,
  // What arm travel costs when the grip rides along unchanged, as a fraction
  // of the same distance travelled while also re-forming the hand. See the
  // glide term in transitionResult.
  // Relearning an exact repeated motif is real player effort. Keep this finite
  // so pins, sustains, and a materially safer route can still override it.
  repeat: 1.5,
  // THE SPIKE IS DELETED. `spike * (scaled - 3.5)^2` used to say that one brutal
  // jump is worse than several modest shifts. Two things were wrong with it.
  // It is a quadratic on DISTANCE, and distance is the cheap part of a shift:
  // sliding the arm eight frets along one string is a single practised gesture,
  // not eight times a one-fret move. And it is measured on 2565 corpus notes to
  // do nothing whatever — zeroing it left every lane's agreement, both gates and
  // all 28 tests byte-identical — while charging 6.75 on the one case it did
  // reach, a bass line dropping from fret 11 to fret 3 on the E string to take
  // a low G that exists nowhere else on the instrument.
  // It was also a landmine under every other movement weight: because it is
  // convex on the SUM, raising any travel cost pushed ordinary chord changes
  // over the gate and detonated it — a 1.5x string-crossing multiplier, harmless
  // on its own, took chord agreement from 92.4% to 41.9% with the spike still in.
  // What is genuinely worth pricing is repetition, not magnitude: jump, then
  // jump again, then again. That was built too (cost proportional to this shift
  // times the previous one, carried on the DP node beside `lastTime`) and it is
  // NOT here either — it helps chords by 1.8 points and moves the bass the wrong
  // way, because the bass already shifts less than the transcriber does
  // (148 against 201) and charging repeated shifts widens that gap.
  // REACH — how far a finger sits from the hand's own seat, beyond the span a
  // relaxed hand already covers. Measured in millimetres against real fret
  // positions, so the same fret count costs more on a long-scale bass and more
  // near the nut, where the frets are physically wider.
  //
  // This is the only term that prices a LONE note. The pose model cannot: with
  // one finger down it can always pick a seat and tilt that put that finger
  // exactly on its slot, so every fingering of a single note scored an identical
  // 0.410 and the choice fell entirely to movement — which always prefers not
  // moving. That is why a bass line would park the hand at fret 5 and take fret
  // 8 with the pinky four times running instead of shifting and using the index.
  //
  // `fingerPitchMm` is the relaxed spacing between adjacent fingertips along the
  // neck. It is the one number separating an instrument that wants to stretch
  // from one that wants to shift: lower favours stretching (guitar), higher
  // favours shifting (bass).
  reach: 0.6, fingerPitchMm: 28,
  // TWO TERMS, because what used to be one called `weakFinger` was two things
  // wearing one name — and the name was the wrong one of the two. See gripParts.
  //
  //   seatIdle  per fret the INDEX idles behind the note. This is PLACEMENT, and
  //             for a lone note it is the only thing saying the hand should sit
  //             under what it is playing: seat = fret - (finger - 1), so
  //             `finger - 1` IS `fret - seat`. It reads as finger strength only
  //             by coincidence, and reading it that way is a trap — the corpus
  //             surface here is a staircase, and softening this ramp because the
  //             ring finger is not really weak takes the fingerpicked acoustic
  //             lane from 84.9% agreement to 21.9%. It needs to be steep, and
  //             what it is holding up is open position, not the ring finger.
  //   pinky     what the FOURTH finger costs on top, and nothing else does. This
  //             is the physiology the name used to claim: the pinky is short and
  //             shares an extensor with the ring, the middle and ring are not
  //             meaningfully weaker than the index, and a linear ramp said all
  //             three were weak in equal steps.
  //
  // Unlike every other knob in this neighbourhood, `pinky` HAS NO CLIFF: flat from
  // 0.15 to 2.0 on all four corpus lanes. That flatness is the evidence for it, and
  // the agreement number is NOT: mono goes 77.0 -> 78.2 and the melody gate's floor
  // is cleared for the first time, but every one of those 15 notes is the 16-note
  // 12-string lane flipping wholesale from 0% to 100%, the acoustic and the bass do
  // not move at all, and the lead loses one note. Read it as "costs nothing", not as
  // "is better". What it costs is 0.05 frets/column of extra hand travel and 0.1
  // point of repeat consistency, because a dear pinky shifts instead of reaching —
  // which is the trade it exists to make.
  seatIdle: 0.25, pinky: 0.35,
  // Per fret a column's hand sits away from THE BAR'S OWN PLANNED SEAT (planSeats).
  // The one number that makes the walk answerable to something longer than the four
  // columns it can see. Deliberately small: the plan says where the bar wants the
  // hand, not which grip to hold, and a pull heavy enough to overrule a sustain or a
  // slide leg would be the plan deciding notes it never looked at.
  plan: 0.18,
  // Reversing finger order at a shared fret, per string the reversal spans.
  stringOrder: 0.9,
  // Charged once per column that has no playable fingering at all (bad import,
  // full-mix transcription). Far above any real grip so such a column is never
  // preferred, but finite so it cannot delete the whole passage.
  unplayable: 100,
};

// The furthest a hand reaches from its own seat to its outermost fingertip. A
// hard limit, and NOT scaled by instrument: a hand is the same hand on a bass.
// The pairwise model published 110mm as the comfortable index-to-pinky maximum;
// past ~115 the grip stops existing rather than getting dearer. Needed once
// finger slots became millimetres — the relaxed hand then covers 84mm, and a
// quadratic on top of that let an 8-fret span high on the neck (124mm at frets
// 12-20, where the frets are narrow) read as merely expensive.
const MAX_HAND_SPAN_MM = 115;
const MAX_BARRE_SPAN_BY_FINGER = { 1: Infinity, 2: 3, 3: 3, 4: 3 };

export const GUITAR_HAND_PROFILE = Object.freeze({
  id: "guitar6", stringCount: 6, scaleLengthMm: 648, stringSpacingMm: 7,
  highGate: HIGH_GATE,
});

export const BASS_HAND_PROFILE = Object.freeze({
  id: "bass4", stringCount: 4, scaleLengthMm: 864, stringSpacingMm: 9,
  highGate: HIGH_GATE,
});

const PROFILE_CACHE = new Map();
export function handProfileForTuning(tuning) {
  const base = tuning?.length <= 5 ? BASS_HAND_PROFILE : GUITAR_HAND_PROFILE;
  const key = `${base.id}:${tuning?.length ?? base.stringCount}`;
  let profile = PROFILE_CACHE.get(key);
  if (!profile) {
    profile = !tuning || tuning.length === base.stringCount ? base
      : { ...base, id: `${base.id}:${tuning.length}`, stringCount: tuning.length };
    PROFILE_CACHE.set(key, profile);
  }
  return profile;
}

const fretXmm = (fret, profile) => fret <= 0 ? 0
  : profile.scaleLengthMm * (1 - 2 ** (-(fret - 0.5) / 12));
const GUITAR_FRET_UNIT_MM = GUITAR_HAND_PROFILE.scaleLengthMm * (1 - 2 ** (-1 / 12));
const fretTravelUnits = (a, b, profile) => Math.abs(fretXmm(a, profile) - fretXmm(b, profile)) / GUITAR_FRET_UNIT_MM;
// ACROSS the strings, measured the way the line above measures ALONG the neck: in
// the reference instrument's own units, scaled by what the real one measures. A bass
// string sits 9mm from its neighbour against a guitar's 7, so crossing one is 29%
// further. Until this existed a crossing was a flat count of strings while a fret was
// already real millimetres — so on a bass, where the frets are 33% wider, moving the
// hand got dearer and crossing a string did not, and the model quietly learned that a
// bassist would rather reach across the neck than shift along it. Both weights keep
// their guitar values, which is the point: only an instrument the guitar is not moves.
const stringTravelUnits = (strings, profile) =>
  strings * profile.stringSpacingMm / GUITAR_HAND_PROFILE.stringSpacingMm;
// Where one fingertip sits relative to its own hand, in the same units. Signed: a
// finger behind the seat reads negative, so differencing two of these is how far the
// finger moved WITHIN the hand while the hand moved too.
const seatOffsetUnits = (fret, seat, profile) =>
  (fretXmm(fret, profile) - fretXmm(seat, profile)) / GUITAR_FRET_UNIT_MM;


// ============================================================================
// COLUMNS
// Notes grouped by onset. A column is one chord or one melodic step, and it is
// the unit everything below plans over.
// ============================================================================

export const CHORD_GAP = 0.06;   // s; onset spread that still counts as one chord


export function chordColumns(notes, cap = Infinity) {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const cols = [];
  for (const n of sorted) {
    const last = cols[cols.length - 1];
    if (last && n.start - last.t0 <= CHORD_GAP) last.notes.push(n);
    else if (cols.length < cap) cols.push({ t0: n.start, notes: [n] });
  }
  return cols;
}

// Techniques that need a finger on the string — a slide slides a fretting finger,
// a bend pushes a fretted note, a harmonic needs a touch/node position, fretting-
// hand vibrato needs a fretted note (whammy-bar wobble is the separate `whammy`
// effect, which works open): none can be executed on a bare open string. Read
// straight off the note's effect fields so the preview and the export agree.
// Manual pins still win (an explicit open pin is honoured even if it contradicts
// the effect — the user asked for it).
export const needsFret = (note) => !!(note.slide || note.bend || note.harmonic || (note.fx && note.fx.vibrato));

// A shift/legato slide connects to the NEXT note along ONE string. A picked
// shift may release into an open target on that string; a legato slide must land
// fretted because the left hand sounds its target. Neither can change strings.
// Only these two kinds link to a following note ("in"/"out" slides do not).
export const SLIDE_TO_NEXT = new Set(["shift", "legato"]);


// Finite fallback cost for source data with no physically satisfiable edge.
// Whenever any legal edge exists, dpSegment removes illegal edges entirely
// before costs are compared, so this value can no longer override physics.
function slideBreakCost(prev, cur) {
  let broken = 0;
  for (const [note, source] of prev) {
    if (!SLIDE_TO_NEXT.has(note.slide)) continue;
    const target = [...cur.values()].find((position) => position.string === source.string);
    if (source.fret <= 0 || !target || (note.slide === "legato" && target.fret <= 0)) broken++;
  }
  return broken * COST_W.slide;
}

// A picked shift that releases into an open note is performed as a downward
// slide-out followed by a fresh attack on the open string. Keep the editor's
// semantic `shift` untouched and derive this notation only for preview/export.
// `positionOf` supports both editor `{ pos }` notes and flattened export notes.
export function representPickedOpenSlides(notes, positionOf = (note) => note?.pos) {
  const replacements = new Map();
  const columns = chordColumns(notes, Infinity);
  for (let index = 0; index + 1 < columns.length; index++) {
    const targets = columns[index + 1].notes
      .map((note) => positionOf(note))
      .filter((position) => position && Number.isFinite(Number(position.string))
        && Number.isFinite(Number(position.fret)));
    for (const note of columns[index].notes) {
      if (note.slide !== "shift") continue;
      const source = positionOf(note);
      if (!source || Number(source.fret) <= 0) continue;
      const target = targets.find((position) =>
        Number(position.string) === Number(source.string) && Number(position.fret) === 0);
      if (target) replacements.set(note, { ...note, slide: "outDown" });
    }
  }
  return notes.map((note) => replacements.get(note) || note);
}

// Every reachable (string, fret) placement for a note, lowest fret first.
// `s` is the tuning index (0 = highest string). A note carrying a fret-only
// effect drops its open-string placement — unless it can ONLY be played open
// (e.g. the lowest open string), where there's no fretted alternative to prefer.
function fretOptions(note, tuning) {
  const options = [];
  tuning.forEach((open, s) => {
    const fret = note.pitch - open;
    if (fret >= 0 && fret <= MAX_FRET) options.push({ s, fret });
  });
  options.sort((a, b) => a.fret - b.fret || b.s - a.s);
  if (needsFret(note)) {
    const fretted = options.filter((o) => o.fret > 0);
    if (fretted.length) return fretted;
  }
  return options;
}

// A finger may cover several strings at one fret (a barre), but only when that
// barre does not cross a sounding open string or a note fretted LOWER than the
// barre. Higher frets are fine: another finger can press them in front of a
// lower barre. With at most six strings, a tiny bitmask search enumerates every
// physically valid barre/separate-fingertip partition rather than assuming that
// every equal-fret note must share one finger.
const noteIsDead = (note) => !!note?.fx?.dead;

function groupsAtEachFret(shape) {
  const entries = [...shape.entries()].map(([note, p]) => ({ note, ...p })).filter((e) => !noteIsDead(e.note));
  const byFret = new Map();
  for (const e of entries) {
    if (e.fret <= 0) continue;
    if (!byFret.has(e.fret)) byFret.set(e.fret, []);
    byFret.get(e.fret).push(e);
  }
  const choices = [];
  for (const fret of [...byFret.keys()].sort((a, b) => a - b)) {
    const same = byFret.get(fret).sort((a, b) => a.string - b.string);
    const full = (1 << same.length) - 1;
    const valid = [];
    for (let mask = 1; mask <= full; mask++) {
      const members = same.filter((_, i) => mask & (1 << i));
      const loS = Math.min(...members.map((e) => e.string));
      const hiS = Math.max(...members.map((e) => e.string));
      const blocked = entries.some((e) => e.string >= loS && e.string <= hiS && e.fret < fret);
      if (!blocked) valid.push({ mask, members });
    }
    // Enumerate every honest partition, not only the smallest one. Three notes
    // at one fret may be one barre or three separate fingertips; those grips do
    // not have the same ergonomics even though the string/fret shape is equal.
    const partitions = [];
    const solve = (mask, out) => {
      if (!mask) { partitions.push(out); return; }
      const first = mask & -mask;
      for (const g of valid) {
        if (!(g.mask & first) || (g.mask & mask) !== g.mask) continue;
        solve(mask ^ g.mask, [...out, { fret, members: g.members }]);
      }
    };
    solve(full, []);
    choices.push(partitions);
  }
  return choices;
}

const GROUPING_CACHE = new WeakMap();

// All contact groupings with at most four fretting fingers. The total chord has
// at most six notes, so this exhaustive search stays tiny and explainable.
function fingerGroupings(shape) {
  if (GROUPING_CACHE.has(shape)) return GROUPING_CACHE.get(shape);
  const perFret = groupsAtEachFret(shape);
  let combined = [[]];
  for (const choices of perFret) {
    const next = [];
    for (const prefix of combined) for (const suffix of choices) {
      if (prefix.length + suffix.length <= 4) next.push([...prefix, ...suffix]);
    }
    combined = next;
  }
  if (!perFret.length) combined = [[]];
  GROUPING_CACHE.set(shape, combined);
  return combined;
}

// Compatibility helper: callers that only ask for groups receive the smallest
// valid grouping, while the v2 scorer considers every grouping and fingering.
function fingerGroups(shape) {
  const choices = fingerGroupings(shape);
  if (!choices.length) return groupsAtEachFret(shape).flatMap((x) => x[0] || []);
  return choices.reduce((best, x) => !best || x.length < best.length ? x : best, null) || [];
}


// Explicit state for every string. MIDI cannot tell us whether an unused string
// was skipped or muted, so the model records its cheapest plausible method and
// exposes that approximation in the cost breakdown.
// ============================================================================
// GRIP COST — what one shape costs the hand, in isolation
// A shape is a Map of note -> {string, fret}. Costing it means choosing a
// fingering for it (fingeringOptions), measuring the hand pose that fingering
// implies (postureParts), and taking the cheapest. Everything
// here is per-shape; nothing knows about neighbours yet.
// ============================================================================

export function stringStates(shape, fingering, profile = GUITAR_HAND_PROFILE) {
  const entries = [...shape].map(([note, p]) => ({ note, ...p, finger: fingering?.fingers.get(note) || 0 }));
  const byString = new Map(entries.map((e) => [e.string, e]));
  const sounding = entries.filter((e) => !noteIsDead(e.note));
  const soundingStrings = sounding.map((e) => e.string);
  const lo = soundingStrings.length ? Math.min(...soundingStrings) : 0;
  const hi = soundingStrings.length ? Math.max(...soundingStrings) : -1;
  const explicitStroke = entries.some((e) => !!e.note?.stroke);
  const states = [];
  for (let string = 0; string < profile.stringCount; string++) {
    const entry = byString.get(string);
    if (entry) {
      if (noteIsDead(entry.note)) states.push({ string, state: "mute-left", method: "dead-note", finger: entry.finger });
      else states.push({ string, state: entry.fret === 0 ? "open" : "fretted", finger: entry.finger });
      continue;
    }
    const internal = string > lo && string < hi;
    const muter = internal ? entries.find((e) => e.fret > 0 && e.finger > 0 && Math.abs(e.string - string) === 1) : null;
    if (muter) states.push({ string, state: "mute-left", method: "finger-overhang", finger: muter.finger });
    else states.push({ string, state: "skip-right", method: internal ? (explicitStroke ? "selective-strum" : "selective-pick") : "outside-attack" });
  }
  return states;
}

function gripParts(shape, fingering, profile) {
  const groups = fingering.groups;
  const parts = {
    // No flat pinky surcharge: POSE_W already has an opinion about which finger
    // belongs where, so charging one on top would double-count.
    fingers: groups.length * COST_W.finger,
    stringOrder: 0, reach: 0, seatIdle: 0, pinky: 0,
    stretch: 0, curl: 0, rotation: 0,
    barre: 0, muting: 0, rightHand: 0, clearance: 0, high: 0, open: 0,
  };
  for (const g of groups) {
    g.string = g.members.reduce((sum, e) => sum + e.string, 0) / g.members.length;
    g.barreSpan = g.members.length > 1
      ? Math.max(...g.members.map((e) => e.string)) - Math.min(...g.members.map((e) => e.string)) + 1 : 1;
    // Barring with anything but the index means holding that finger flat while
    // the others stay arched over it. Possible, and players do it, but dear:
    // priced gently, a ring barre beat an ordinary three-finger ladder.
    // Charged once here; nothing scales it afterwards
    // instead, because these grips are cached per shape and a preference baked
    // into the cache would not take effect until the cache was dropped.
    if (g.members.length > 1) parts.barre += POSE_W.barre
      + stringTravelUnits(Math.max(0, g.barreSpan - 1), profile) * COST_W.barreString
      + Math.max(0, g.finger - 1) * POSE_W.barreFinger;
  }
  // Two rules are anatomical order rather than posture: fingers cannot cross
  // along the neck, and two fingers sharing a fret always lie treble-side in
  // finger order however the hand is turned. Posture prices where the hand can
  // be; these price what the hand is.
  const pose = postureParts(groups, profile);
  if (!pose) return null;
  parts.stretch = pose.stretch; parts.curl = pose.curl; parts.rotation = pose.rotation;
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    const a = groups[i], b = groups[j];
    // Fingers do not pass each other along the neck: the middle cannot press a
    // fret behind the index while both are down. Priced as merely expensive it
    // kept surfacing in the alternatives list, where a cheap transition can
    // outrank any grip cost. Every finger assignment of a shape is enumerated
    // and sorting the fingers by fret always yields a legal one, so rejecting
    // this never costs a shape — only the assignment no hand can make.
    if ((a.fret - b.fret) * (a.finger - b.finger) < 0) return null;
    if (a.fret === b.fret && (a.finger - b.finger) * (a.string - b.string) > 0)
      parts.stringOrder += COST_W.stringOrder * stringTravelUnits(Math.abs(a.string - b.string), profile);
  }
  // Charged against the seat the DP itself uses, so comfort and movement agree on
  // where the hand is — and ONLY for a shape with one finger down, which is
  // exactly where postureParts is blind. With two fingers the seat is a median of
  // their implied anchors, so a higher-numbered finger drags it nutward and makes
  // its own reach read as free: applied to every group this term started
  // preferring the pinky, fingering two notes at fret 9 as ring + pinky instead of
  // index + middle. Multi-finger spans are priced by the pose below, in the same
  // millimetres.
  if (groups.length === 1 && groups[0].fret > 0 && Number.isFinite(fingering.seat)) {
    const g = groups[0];
    // WHICH FINGER DOES THE WORK. Index free, then one step per finger. For a lone
    // note `seat = fret - (finger - 1)`, so `finger - 1` IS `fret - seat`: the same
    // number reads as "how weak a finger you are using" and as "how many frets the
    // index is idling behind the note", and one term buys both readings.
    //
    // Without it the four fingerings of a single note differ ONLY by how far the
    // hand has to travel to seat them, and travel always prefers not moving — so a
    // phrase whose every note is at fret 8 was played with the ring from a hand
    // parked at 6, with the index on a fret nothing uses. `reach` cannot fix that:
    // it prices a fingertip stretched PAST its relaxed slot, and at these positions
    // it runs 0.088 for the ring against 0.13 for the pinky — flat, because it is a
    // square of a small overage. It sees a stretched hand; it cannot see a weak
    // finger.
    //
    // Charged PER NOTE while a shift is paid once, which is the whole economics: at
    // 0.12 a single note is worth 0.24 against ~1.84 to move two frets, so the hand
    // does not chase one note, and a bar's worth of them is worth moving for. No bar
    // detection needed for that — the existing window already sees far enough.
    //
    // One finger down only, and that scope is the code's own: postureParts has an
    // opinion about which finger belongs where in a GRIP, so charging this on a
    // chord would double-count. It is blind with one finger down, which is exactly
    // the hole. Chords are untouched, and chord-corpus is the control that says so.
    parts.seatIdle = COST_W.seatIdle * (g.finger - 1);
    if (g.finger === 4) parts.pinky = COST_W.pinky;
    const over = (fretXmm(g.fret, profile) - fretXmm(Math.max(1, fingering.seat), profile))
      - (g.finger - 1) * COST_W.fingerPitchMm;
    if (over > 0) parts.reach += COST_W.reach * (over / COST_W.fingerPitchMm) ** 2;
  }
  const fretted = [...shape.values()].filter((p) => p.fret > 0);
  if (fretted.length) {
    const lowest = Math.min(...fretted.map((p) => p.fret));
    parts.high = Math.max(0, lowest - COST_W.highKnee) * COST_W.highRamp
      + (shape.size === 1 ? 0 : (lowest > profile.highGate ? COST_W.high : 0));
  }
  const states = stringStates(shape, fingering, profile);
  const explicitStroke = [...shape.keys()].some((note) => !!note?.stroke);
  for (const state of states) {
    if (state.state === "mute-left") parts.muting += COST_W.mute;
    else if (state.state === "skip-right" && state.method !== "outside-attack") parts.rightHand += explicitStroke ? COST_W.strokeSkip : COST_W.innerSkip;
    else if (state.state === "skip-right" && explicitStroke) parts.rightHand += COST_W.edgeControl;
  }
  const entries = [...shape.values()];
  for (const open of entries.filter((p) => p.fret === 0)) {
    if (entries.some((p) => p.fret > 0 && Math.abs(p.string - open.string) === 1)) parts.clearance += COST_W.openClearance;
  }
  return parts;
}

// A finger physically cannot cover more strings than it is long. True whichever
// cost model is scoring the grip.
const barreSpansFit = (groups) => groups.every((group) => group.members.length < 2
  || Math.max(...group.members.map((e) => e.string)) - Math.min(...group.members.map((e) => e.string)) + 1
    <= (MAX_BARRE_SPAN_BY_FINGER[group.finger] ?? 1));

// ── The hand pose ─────────────────────────────────────────────────────────
//
// This replaced a model that scored a grip as a web of pairwise fingertip
// distances. That web had no notion of how the hand is HELD, so it could not tell
// "index at 8, pinky at 11" — a relaxed hand, one finger per fret — from "index
// at 8, ring at 11", the same hand with the ring stretched past its slot. Both
// fall inside their comfortable millimetre range, so both score zero and the
// choice comes down to whichever incidental weight breaks the tie.
//
// This model gives the hand two variables instead: where it sits (`seat`) and
// how far it is slanted along the neck (`tilt`). At tilt 1 the fingers lie one
// per fret, the relaxed posture; at tilt 0 the wrist is rotated square and all
// four land on a single fret. Finger k is expected at seat + (k-1)·tilt, and the
// grip costs what it takes to hold the fingers away from those slots:
//
//   stretch   a finger reaching PAST its slot, toward the bridge. Expensive, and
//             past MAX_STRETCH_MM no hand does it at all.
//   curl      a finger drawn back toward the nut. Ordinary; nearly free.
//   rotation  squaring the hand is what lets several fingers share one fret, but
//             it swings the short fingers toward the treble side. A square hand
//             asking a high finger to reach the bass strings is charged; the same
//             grip on a slanted hand is not.
//
// Distances are millimetres against real fret positions, so one set of constants
// describes a short-scale guitar and a long-scale bass, and a stretch near the
// nut costs more than the same fret count up at the twelfth.
// Swept against all 3269 fingered positions of chords-db (tests/chord-corpus.test.mjs).
// `barre` and `barreFinger` are what a barre costs: at the old flat 0.22,
// barring was cheaper than using separate fingers and A major came out as a
// one-finger barre.
//
// `curl` sits ABOVE `stretch` on purpose: drawing a finger back toward the nut
// costs more than reaching past its slot. That reads backwards until you notice
// the hand's resting posture is fingers extended along the neck, not curled — so
// pulling one behind where the hand has placed it is the less natural of the two.
// The corpus agrees, and keeps agreeing past curl 6, but everything above 3 buys
// rank-1 agreement while top-3 and mean rank stay flat and the hand-verified
// grips start slipping. That is reshuffling near-ties, not understanding, so 3 is
// where it stops.
export const POSE_W = {
  stretch: 1.4, curl: 3, rotation: 0.05,
  barre: 0.6, barreFinger: 1.4, maxStretchMm: 46, maxCurlMm: 46,
};
const POSE_TILTS = [0, 0.25, 0.5, 0.75, 1];

const NO_POSE = Object.freeze({ total: 0, stretch: 0, curl: 0, rotation: 0, tilt: 1, seat: null });

function postureParts(groups, profile) {
  // An all-open shape has no groups to seat. The fretting hand is not involved,
  // so there is no pose to charge — and returning nothing here would have made
  // every open string unplayable.
  if (!groups.length) return NO_POSE;
  const limit = POSE_W.maxStretchMm;
  // Curl is priced as ordinary but it was not BOUNDED, and only bounded terms
  // reject. So a grip the hand cannot form — index at 12, ring at 18, pinky at
  // 20 — escaped by seating the hand up at the pinky and calling the index a
  // deep curl: quadratic, uncapped, and cheaper than the impossible stretch it
  // stood in for. A finger drawn this far behind its slot is no more a hand than
  // one reaching that far past it.
  const curlLimit = POSE_W.maxCurlMm;
  // Lean: a higher-numbered finger reaching to the BASS side of a lower one
  // (string 0 is the treble e, so bass is the larger index). Slanting the hand
  // buys some of this — the middle finger taking the low E behind the index is
  // ordinary G major — but how much it buys depends entirely on WHICH pair, and
  // that single fact carries the model.
  //
  // Anchored on the index the hand rolls freely: open C puts the ring three
  // strings bass-ward of the index at two frets' remove and is the first chord
  // anyone learns. Anchored on the ring nothing rolls, because the ring and
  // pinky share a flexor tendon — and a grip with those same three strings and
  // two frets between ring and pinky is one no player can form. Identical
  // geometry, opposite verdicts, so no measure blind to finger identity can
  // separate them. Hence both the amount (lower finger squared) and the relief
  // slanting grants (tilt / lower finger) key off the anchoring finger.
  const leans = [];
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    const lower = groups[i].finger < groups[j].finger ? groups[i] : groups[j];
    const higher = lower === groups[i] ? groups[j] : groups[i];
    const across = Math.max(0, higher.string - lower.string);
    if (across > 0) leans.push({
      amount: across * (higher.finger - lower.finger) * lower.finger ** 2,
      anchor: lower.finger,
    });
  }
  let best = null;
  for (const tilt of POSE_TILTS) {
    const rotation = POSE_W.rotation
      * leans.reduce((sum, l) => sum + l.amount * (1 - tilt / l.anchor), 0);
    if (best && rotation >= best.total) continue;
    // The seat that minimises a sum of convex per-finger costs sits at one of the
    // frets the fingers themselves imply, so only those need testing.
    for (const group of groups) {
      const seat = group.fret - (group.finger - 1) * tilt;
      if (seat < 0.5) continue;
      let stretch = 0, curl = 0, over = false;
      for (const g of groups) {
        // The relaxed hand is a fixed span of KNUCKLES, not a fixed number of
        // frets. Computing the slot in fret space and only then converting to
        // millimetres made one-finger-per-fret free on a 34" bass and a 25.5"
        // guitar alike, cancelling the one physical difference between them —
        // the same 3-fret span is 79mm on a guitar and 106mm on a bass.
        const d = fretXmm(g.fret, profile)
          - (fretXmm(seat, profile) + (g.finger - 1) * tilt * COST_W.fingerPitchMm);
        if (d > limit || d < -curlLimit) { over = true; break; }
        if (fretXmm(g.fret, profile) - fretXmm(seat, profile) > MAX_HAND_SPAN_MM) { over = true; break; }
        if (d > 0) stretch += POSE_W.stretch * (d / limit) ** 2;
        else curl += POSE_W.curl * (-d / limit) ** 2;
      }
      if (over) continue;
      const total = stretch + curl + rotation;
      if (!best || total < best.total) best = { total, stretch, curl, rotation, tilt, seat };
    }
  }
  return best;
}

const FINGERING_CACHE = new WeakMap();
const MAX_FINGERINGS_PER_SHAPE = 12;

export function fingeringOptions(shape, profile = GUITAR_HAND_PROFILE) {
  let byProfile = FINGERING_CACHE.get(shape);
  if (!byProfile) { byProfile = new Map(); FINGERING_CACHE.set(shape, byProfile); }
  let base = byProfile.get(profile.id);
  if (!base) {
    const openFingers = new Map([...shape].filter(([, p]) => p.fret === 0).map(([note]) => [note, 0]));
    const candidates = [];
    for (const grouping of fingerGroupings(shape)) {
      const used = new Set(), assigned = [];
      (function assign(i) {
        if (i === grouping.length) {
          const fingers = new Map(openFingers);
          const groups = grouping.map((g, k) => ({ ...g, finger: assigned[k], members: g.members.map((e) => ({ ...e })) }));
          for (const g of groups) for (const e of g.members) fingers.set(e.note, g.finger);
          if (!barreSpansFit(groups)) return;
          const bases = groups.map((g) => g.fret - (g.finger - 1)).sort((a, b) => a - b);
          const rawSeat = bases.length ? Math.round(bases[(bases.length - 1) >> 1]) : null;
          // A player anchors a position shift with the index, so a LONE note is
          // taken by the index unless the hand is already seated for something
          // else. Fret 1 with the pinky implies the index two frets behind the
          // nut, which is not a cheap grip — it is not a grip. Clamping it to
          // seat 1 said the opposite: below fret 4 every finger reported the same
          // seat, so swapping fingers there cost no hand movement and the same
          // string crossing came out 0.590 at fret 1 against 0.662 everywhere
          // else. A flat 12% discount on the first three frets, and for a
          // monophonic line — where every grip costs an identical 0.260 whatever
          // the position — that artifact was most of what decided where the hand
          // went.
          //
          // Only when one finger is down. With several the hand is already
          // seated and the fingers bunch (tilt < 1), so the rigid fret-(finger-1)
          // spacing this seat is derived from stops describing the shape: applied
          // to chords as well it drops chords-db "offered at all" from 98.5% to
          // 92.4%. Scoped to a single group it leaves every corpus figure
          // untouched to the decimal.
          if (rawSeat !== null && rawSeat < 1 && groups.length === 1) return;
          const seat = rawSeat === null ? null : Math.max(1, rawSeat);
          const fingering = { fingers, groups, seat };
          const parts = gripParts(shape, fingering, profile);
          if (!parts) return;
          const total = Object.values(parts).reduce((sum, x) => sum + x, 0);
          candidates.push({ ...fingering, parts, cost: total });
          return;
        }
        for (let finger = 1; finger <= 4; finger++) {
          if (used.has(finger)) continue;
          used.add(finger); assigned.push(finger); assign(i + 1); assigned.pop(); used.delete(finger);
        }
      })(0);
    }
    candidates.sort((a, b) => a.cost - b.cost);
    const diverse = [], seats = new Set();
    for (const candidate of candidates) if (!seats.has(candidate.seat)) {
      seats.add(candidate.seat); diverse.push(candidate);
      if (diverse.length === MAX_FINGERINGS_PER_SHAPE) break;
    }
    for (const candidate of candidates) {
      if (diverse.includes(candidate)) continue;
      diverse.push(candidate);
      if (diverse.length === MAX_FINGERINGS_PER_SHAPE) break;
    }
    base = diverse;
    byProfile.set(profile.id, base);
  }
  // Returned straight from the cache. This used to map every entry to add an
  // open-string charge and a barre scale from the user's preferences; with those
  // gone the map was the identity, and the grip cost a shape has is now the one
  // gripParts computed for it.
  return base;
}

export function gripCostBreakdown(shape, profile = GUITAR_HAND_PROFILE) {
  const best = fingeringOptions(shape, profile)[0];
  return best ? { total: best.cost, parts: best.parts, fingering: best } : { total: Infinity, parts: {}, fingering: null };
}

export const hasPlayableFingering = (shape, profile = GUITAR_HAND_PROFILE) => fingeringOptions(shape, profile).length > 0;

// Intrinsic difficulty of a single shape (lower = easier to fret): choose the
// cheapest feasible concrete fingering, then sum named ergonomic, string-control,
// register, and open-preference contributions. Raw fret span is only a coarse
// enumeration guard; it is no longer charged as comfort by itself.
export function shapeCost(shape, profile = GUITAR_HAND_PROFILE) {
  return gripCostBreakdown(shape, profile).total;
}

// Where along the neck the hand can sit to fret this shape. An isolated fretted
// note is flexible: any finger may take it, so with the index at h the fingers
// cover h..h+COMFORT_REACH and h ∈ [fret−COMFORT_REACH, fret]. A shape with
// two or more fretted notes is different: its lowest fret is the index/barre
// anchor used by assignFingers, so the hand is seated at that fret. Treating a
// fret-3 barre as though the hand might still be in first position badly
// underprices a later shift to a fret-7 barre. Open strings do not constrain
// this test; a chord with only one fretted note retains single-note flexibility.
// null for an all-open shape — the hand isn't involved and the DP carries its
// previous position straight through (a transparent column).
export function handRange(shape) {
  const fretted = [...shape.values()].map((v) => v.fret).filter((f) => f > 0);
  if (!fretted.length) return null;
  const lo = Math.min(...fretted), hi = Math.max(...fretted);
  if (fretted.length >= 2) return { lo, hi: lo };
  return { lo: Math.max(1, Math.min(lo, hi - COMFORT_REACH)), hi: lo };
}


// Index-finger position = the fret the hand is anchored at (0 if all open).
// Used to read a pinned shape's position (the fret its segment is pulled toward).
function handAnchor(shape) {
  const fretted = [...shape.values()].map((v) => v.fret).filter((f) => f > 0);
  return fretted.length ? Math.min(...fretted) : 0;
}

// The string the hand is centred on = the string carrying the anchor (lowest
// fretted) note; the lowest string used if the shape is all open. Lets the move
// cost count crossing the neck, not just sliding along it.
export function handString(shape) {
  const vals = [...shape.values()];
  const fretted = vals.filter((v) => v.fret > 0);
  if (!fretted.length) return vals.length ? Math.min(...vals.map((v) => v.string)) : 0;
  if (fretted.length === 1) return fretted[0].string;
  // A chord occupies an area of the neck rather than whichever note happened
  // to be inserted first. The mean is stable under note ordering and lets both
  // outer strings contribute to cross-neck movement.
  return fretted.reduce((sum, v) => sum + v.string, 0) / fretted.length;
}


// Notes held on the exact same string+fret across two shapes — a pivot finger
// the player keeps down, which makes the transition easier (rewarded below).
// How much a move is amplified/discounted by the time available for it: fast
// notes (short inter-onset Δt) make a reposition dear, a rest makes it cheap.
// Neutral (1) when timing is unknown. Clamped so it never vanishes or explodes.
// ============================================================================
// TRANSITION COST — what it costs to get from one shape to the next
// Hand travel, shared contacts, string crossing, and how much time there is to
// do it in. Distinct from grip cost: a hard shape reached without moving can be
// cheaper than an easy one across the neck.
// ============================================================================

// The irreducible half, swept on the corpus: byte-identical at 0.45 and 0.35,
// -0.4 points at 0.25 and -7.5 at 0.15, where landing gets so cheap the hand
// starts wandering on every held note. 0.35 is the far end of the flat range.
const TF_LAND = 0.35, TF_KNEE = 0.5;
function timeFactor(dt, refIoi) {
  if (!(dt > 0) || !(refIoi > 0)) return 1;   // unknown/NaN timing → time-neutral
  const ratio = refIoi / dt;
  if (ratio >= TF_KNEE) return Math.min(ratio, 3);
  // MORE TIME THAN THE MOVE NEEDS. This used to be a flat clamp at TF_KNEE, which
  // did not make a shift too dear — it made every unhurried shift cost the SAME.
  // A hand with a whole bar to move and a hand with two beats were priced
  // identically, so the engine had no reason to move at the moment that was free
  // and would put the shift wherever else it landed. On the reported bass line it
  // sat at fret 5 through a run it then left anyway, having declined to leave
  // during the 0.83s note that was sitting right in front of it.
  //
  // The fix is not a lower floor: dropping the clamp to 0.35 costs the corpus 10.4
  // points of monophonic agreement, because with cheap shifts everywhere the hand
  // wanders off on every long note. It is that a shift costs two things and only
  // one of them is time — getting there, which more time buys, and LANDING it,
  // which it does not. So the floor becomes an asymptote: everything at or above
  // the knee is byte-identical to before, and below it the price keeps falling
  // toward TF_LAND instead of stopping dead.
  return TF_LAND + (TF_KNEE - TF_LAND) * (ratio / TF_KNEE);
}

// Transition geometry is immutable for the lifetime of a concrete fingering.
// Cache its compact representation once instead of rebuilding Maps/Sets in the
// DP's O(previous states * current states) inner loop.
const FINGERING_TRANSITION_CACHE = new WeakMap();
const SHAPE_PAIR_CACHE = new WeakMap();

function fingeringTransitionData(fingering) {
  let data = FINGERING_TRANSITION_CACHE.get(fingering);
  if (data) return data;
  const groups = new Array(5).fill(null);
  let mask = 0;
  for (const group of fingering?.groups || []) {
    const contacts = new Set(group.members.map((x) => `${x.string}:${x.fret}`));
    groups[group.finger] = { ...group, contacts };
    mask |= 1 << group.finger;
  }
  data = { groups, mask };
  if (fingering) FINGERING_TRANSITION_CACHE.set(fingering, data);
  return data;
}

function shapePairData(prevShape, curShape) {
  let byCurrent = SHAPE_PAIR_CACHE.get(prevShape);
  if (!byCurrent) { byCurrent = new WeakMap(); SHAPE_PAIR_CACHE.set(prevShape, byCurrent); }
  let data = byCurrent.get(curShape);
  if (!data) {
    data = {
      stringDistance: Math.abs(handString(prevShape) - handString(curShape)),
      slide: slideBreakCost(prevShape, curShape),
    };
    byCurrent.set(curShape, data);
  }
  return data;
}

const sharedContactCount = (a, b) => {
  const smaller = a.contacts.size <= b.contacts.size ? a : b;
  const larger = smaller === a ? b : a;
  let count = 0;
  for (const contact of smaller.contacts) if (larger.contacts.has(contact)) count++;
  return count;
};

function transitionResult(prevShape, prevFingering, curShape, curFingering,
  profile, dt, refIoi, explain) {
  const pair = shapePairData(prevShape, curShape);
  if (!prevFingering?.seat || !curFingering?.seat) {
    return explain
      ? { total: pair.slide, parts: { hand: 0, fingers: 0, placement: 0, retained: 0, slide: pair.slide } }
      : pair.slide;
  }
  const prev = fingeringTransitionData(prevFingering), cur = fingeringTransitionData(curFingering);
  let fingers = 0, common = 0, retainedCount = 0;
  for (let finger = 1; finger <= 4; finger++) {
    const a = prev.groups[finger], b = cur.groups[finger];
    if (!a || !b) continue;
    common++;
    const relativeFret = Math.abs(seatOffsetUnits(a.fret, prevFingering.seat, profile)
      - seatOffsetUnits(b.fret, curFingering.seat, profile));
    const stringMove = stringTravelUnits(Math.abs(a.string - b.string), profile);
    fingers += relativeFret + stringMove * COST_W.fingerSide;
    retainedCount += sharedContactCount(a, b);
  }
  // Per-finger reshaping, measured relative to each shape's own seat: 0 means
  // the grip was carried along the neck unchanged.
  const formChange = common ? fingers / common : Infinity;
  if (common) fingers = formChange * COST_W.fingerMove;
  // Sliding a formed grip is the cheap kind of neck travel. A power chord or
  // barre moved up keeps every finger where it already sits relative to the
  // others, so the arm does the work and the hand arrives ready to play
  // instead of re-forming on landing — frequently easier than staying put and
  // refingering, which a flat distance charge can never express. Requires a
  // real multi-finger form held by the same fingers (a lone finger has no
  // shape to retain, and a run of single notes must not read as gliding), and
  // fades out as the grip actually changes.
  const glide = common >= 2 && prev.mask === cur.mask
    ? 1 - (1 - COST_W.glide) * Math.max(0, 1 - formChange)
    : 1;
  const hand = (fretTravelUnits(prevFingering.seat, curFingering.seat, profile) * COST_W.mfret
    + stringTravelUnits(pair.stringDistance, profile) * COST_W.mstring) * glide;
  let changed = 0, changedMask = prev.mask ^ cur.mask;
  while (changedMask) { changed += changedMask & 1; changedMask >>>= 1; }
  const placement = changed * COST_W.place;
  const tf = timeFactor(dt, refIoi);
  const scaled = (hand + fingers + placement) * tf;
  const retained = retainedCount * COST_W.pivot;
  const total = scaled - retained + pair.slide;
  return explain
    ? { total, parts: { hand: hand * tf, fingers: fingers * tf, placement: placement * tf, retained: -retained, slide: pair.slide } }
    : total;
}

// Explainable movement between two concrete fingerings. The arm/hand shift is
// measured in physical neck distance; finger reshaping measures motion relative
// to that moving hand, so a clean position shift is not charged twice.
export function transitionCostBreakdown(prevShape, prevFingering, curShape, curFingering,
  profile = GUITAR_HAND_PROFILE, dt, refIoi) {
  return transitionResult(prevShape, prevFingering, curShape, curFingering, profile, dt, refIoi, true);
}


// Left-hand fingers (1=index … 4=pinky, 0=open) for a shape. Same-fret notes
// share a number only when fingerGroups proves that a real barre can connect
// them without overriding an open/lower note on an intervening string.
export function assignFingers(shape, profile = GUITAR_HAND_PROFILE) {
  const best = fingeringOptions(shape, profile)[0];
  if (best) return new Map(best.fingers);
  // Imported/manual impossible shapes still render without inventing a fifth
  // finger. This fallback mirrors the old deterministic labelling.
  const fingers = new Map([...shape].filter(([, p]) => p.fret === 0).map(([note]) => [note, 0]));
  fingerGroups(shape).forEach((group, i) => {
    for (const e of group.members) fingers.set(e.note, i < 4 ? i + 1 : 0);
  });
  return fingers;
}

// A column is "locked" to an explicit voicing when EVERY note in it carries a
// manual `pos` override that is in range, sounds the note's pitch, and sits on
// its own string. Returns that pinned shape (Map note -> {string, fret}) or
// null to fall back to automatic voicing — so a pin left stale by a later pitch
// edit simply lapses instead of corrupting the tab.
export function lockedShape(notes, tuning) {
  const shape = new Map();
  const usedStrings = new Set();
  for (const n of notes) {
    const p = n.pos;
    if (!p || !Number.isInteger(p.string) || !Number.isInteger(p.fret)) return null;
    if (p.string < 0 || p.string >= tuning.length || p.fret < 0 || p.fret > MAX_FRET) return null;
    if (tuning[p.string] + p.fret !== n.pitch) return null;   // no longer this pitch
    if (usedStrings.has(p.string)) return null;               // two notes, one string
    usedStrings.add(p.string);
    shape.set(n, { string: p.string, fret: p.fret });
  }
  return shape.size ? shape : null;
}

// IS A SHAPE THE PLAYER BUILT BY HAND A REAL ONE? The same three things lockedShape
// asks of a stored pin, asked BEFORE it is written — because the neck's custom-shape
// walk is the one path where a shape did not come out of the enumerator, so nothing
// upstream has vouched for it, and a pin that fails these lapses silently.
//
// Playability is deliberately not among them. A shape the engine would never offer is
// the whole point of the walk, and whether a hand can hold it is the player's
// judgement, not the model's to veto.
//
// Returns null when the shape is sound, or the sentence saying what is wrong with it.
export function shapeFault(notes, tuning, shape) {
  const used = new Set();
  for (const n of notes) {
    const p = shape.get(n);
    if (!p) return `${noteName(n.pitch)} has no position yet`;
    if (!Number.isInteger(p.string) || p.string < 0 || p.string >= tuning.length)
      return "That string is not on this instrument";
    if (used.has(p.string)) return "Two notes cannot share one string";
    used.add(p.string);
    if (tuning[p.string] + p.fret !== n.pitch)
      return `${noteName(n.pitch)} does not sound at fret ${p.fret} on that string`;
  }
  return null;
}

// Enumerate every playable shape for one column: assign each note to a distinct
// string with all fretted notes inside HAND_SPAN. Falls back to a lowest-fret
// greedy (collapsing string collisions) when nothing fits.
// ============================================================================
// CANDIDATES — which shapes are worth considering for a column
// Enumerate every playable placement, then narrow: rank by isolated cost,
// keep a diverse spread rather than six variations of one grip, and let the
// neighbouring columns prune further.
// ============================================================================

export function enumerateShapes(notes, tuning) {
  const profile = handProfileForTuning(tuning);
  const cand = notes.map((n) => ({ note: n, options: fretOptions(n, tuning) }));
  const order = [...cand.keys()].sort((a, b) => cand[a].options.length - cand[b].options.length);
  const shapes = [];
  const used = new Map();   // string index -> { note, fret }
  (function recurse(k) {
    if (shapes.length > 600) return;                 // safety cap on the search
    if (k === order.length) {
      const shape = new Map([...used].map(([s, v]) => [v.note, { string: s, fret: v.fret }]));
      if (hasPlayableFingering(shape, profile)) shapes.push(shape);
      return;
    }
    const { note, options } = cand[order[k]];
    if (!options.length) { recurse(k + 1); return; } // unplaceable (out of range) — skip
    const fretted = [...used.values()].map((v) => v.fret).filter((f) => f > 0);
    for (const o of options) {
      if (used.has(o.s)) continue;
      if (o.fret > 0 && fretted.length) {
        const lo = Math.min(o.fret, ...fretted), hi = Math.max(o.fret, ...fretted);
        if (hi - lo > HAND_SPAN) continue;
      }
      used.set(o.s, { note, fret: o.fret });
      recurse(k + 1);
      used.delete(o.s);
    }
  })(0);
  if (!shapes.length) shapes.push(greedyShape(notes, tuning));
  return shapes;
}

// The pitches a tuning can actually produce: lowest open string up to the
// highest string's last fret. A note outside it gets no position anywhere, so
// it drops out of every shape silently — the caller has to say so.
export const outOfFretboardRange = (pitch, tuning) =>
  pitch < Math.min(...tuning) || pitch > Math.max(...tuning) + MAX_FRET;

// enumerateShapes always returns something — a greedy last resort with no
// playable fingering — so "these notes cannot be played together" is otherwise
// invisible to callers and reaches the UI as a shape smeared across the neck.
// This is the explicit test for it.
export const unplayableColumn = (notes, tuning) => {
  const profile = handProfileForTuning(tuning);
  return !enumerateShapes(notes, tuning).some((shape) => hasPlayableFingering(shape, profile));
};

// Canonical key for a shape (string+fret set), so duplicate voicings dedupe and
// a pinned shape can be matched against the enumerated alternatives.
// A note out of the instrument's range gets no position at all (enumerateShapes
// skips it), so a shape may be missing entries — keying is not the place to
// discover that.
export const shapeKey = (shape) =>
  [...shape.values()].filter(Boolean).map((p) => `${p.string}:${p.fret}`).sort().join(",");

function rankShapes(shapes, profile = GUITAR_HAND_PROFILE) {
  const seen = new Set();
  const out = [];
  for (const { sh } of shapes.map((s) => ({ sh: s, c: shapeCost(s, profile) })).sort((a, b) => a.c - b.c)) {
    const k = shapeKey(sh);
    if (!seen.has(k)) { seen.add(k); out.push(sh); }
  }
  return out;
}

// Keep easy candidates without erasing whole regions of the neck before the
// sequence search has seen its neighbours. One cheapest representative from
// every hand-position bucket is admitted first, then the remaining slots are
// filled by intrinsic cost. This is deliberately generic: no pitch/fret cases.
export function diverseShapes(shapes, cap = DP_SHAPES_PER_COL, profile = GUITAR_HAND_PROFILE) {
  const ranked = rankShapes(shapes, profile);
  if (!Number.isFinite(cap) || ranked.length <= cap) return ranked;
  const chosen = [], used = new Set(), buckets = new Set();
  for (const sh of ranked) {
    const r = handRange(sh);
    const bucket = r ? Math.floor(handAnchor(sh) / 3) : "open";
    if (buckets.has(bucket)) continue;
    buckets.add(bucket); used.add(shapeKey(sh)); chosen.push(sh);
    if (chosen.length === cap) return chosen;
  }
  for (const sh of ranked) {
    if (used.has(shapeKey(sh))) continue;
    chosen.push(sh);
    if (chosen.length === cap) break;
  }
  return chosen;
}

// Cheap lower bound used only for candidate retention. It deliberately mirrors
// the real DP's fret/string/pivot geometry without pretending to know the exact
// hand seat or timing yet. A shape that is unremarkable alone can consequently
// survive when it is an excellent bridge between its neighbours.
function shapeTransitionEstimate(a, b, profile = GUITAR_HAND_PROFILE) {
  const af = fingeringOptions(a, profile), bf = fingeringOptions(b, profile);
  if (!af.length || !bf.length || !af[0].seat || !bf[0].seat) return 0;
  let best = Infinity;
  for (const x of af) for (const y of bf) {
    best = Math.min(best, transitionCostBreakdown(a, x, b, y, profile).total);
  }
  return best;
}

const stringSetKey = (shape) => [...shape.values()].map((p) => p.string).sort((a, b) => a - b).join("");
const neckBucket = (shape) => {
  const r = handRange(shape);
  return r ? Math.floor(handAnchor(shape) / 3) : "open";
};

// Reduce a broad per-column pool only after looking one column in both
// directions. Preserve the best candidate for every neck region and every
// string set before filling by contextual score; this prevents a numerically
// dominant family of near-identical low-position shapes from erasing useful
// bridge shapes elsewhere on the instrument.
export function contextShapes(pool, previous = [], next = [], cap = DP_SHAPES_PER_COL, profile = GUITAR_HAND_PROFILE) {
  if (!Number.isFinite(cap) || pool.length <= cap) return pool;
  const neighbourCost = (shape, neighbours, reverse = false) => {
    if (!neighbours.length) return 0;
    return Math.min(...neighbours.map((other) => reverse
      ? shapeTransitionEstimate(shape, other, profile)
      : shapeTransitionEstimate(other, shape, profile)));
  };
  const scored = pool.map((shape) => ({
    shape,
    score: shapeCost(shape, profile) + neighbourCost(shape, previous) + neighbourCost(shape, next, true),
  })).sort((a, b) => a.score - b.score || shapeCost(a.shape, profile) - shapeCost(b.shape, profile));

  const chosen = [], used = new Set(), necks = new Set(), strings = new Set();
  const take = (item) => {
    const key = shapeKey(item.shape);
    if (used.has(key) || chosen.length >= cap) return;
    used.add(key); chosen.push(item.shape);
  };
  for (const item of scored) {
    const key = neckBucket(item.shape);
    if (!necks.has(key)) { necks.add(key); take(item); }
  }
  for (const item of scored) {
    const key = stringSetKey(item.shape);
    if (!strings.has(key)) { strings.add(key); take(item); }
  }
  for (const item of scored) take(item);
  return chosen;
}

// Build broad, diverse pools first, then let immediate musical context choose
// the smaller state set consumed by the exact sequence DP.
export function contextualCandidateSets(columns, tuning, cap = DP_SHAPES_PER_COL, influences = null) {
  const profile = handProfileForTuning(tuning);
  // Pins must participate in the neighbouring shortlist as well as the final
  // DP. Otherwise a good approach/exit shape could be pruned before the fixed
  // state is introduced below.
  const locked = columns.map((c) => lockedShape(c.notes, tuning));
  const automatic = columns.map((c, i) => locked[i] ? null :
    diverseShapes(enumerateShapes(c.notes, tuning), DP_CONTEXT_POOL, profile));
  const automaticPool = (i) => {
    if (i < 0 || i >= columns.length) return [];
    if (!automatic[i])
      automatic[i] = diverseShapes(enumerateShapes(columns[i].notes, tuning), DP_CONTEXT_POOL, profile);
    return automatic[i];
  };
  const pools = automatic.map((pool, i) => locked[i] ? [locked[i]] : pool);
  return pools.map((pool, i) => {
    const previous = locked[i - 1] && influences?.[i - 1]?.next === false ? automaticPool(i - 1) : pools[i - 1];
    const next = locked[i + 1] && influences?.[i + 1]?.previous === false ? automaticPool(i + 1) : pools[i + 1];
    return contextShapes(pool, previous, next, cap, profile);
  });
}


export function normalizeOverrideInfluence(value = null) {
  return {
    previous: value?.previous !== false && value?.influencePrevious !== false,
    next: value?.next !== false && value?.influenceNext !== false,
  };
}

// New overrides store two independent booleans. Legacy "local" pins already
// participated in the full passage DP, so they map to both directions; legacy
// "forward" pins keep their original next-only behavior.
export function overrideInfluence(notes) {
  const arrangement = (notes || []).find((note) => note.arrangement)?.arrangement;
  const position = (notes || []).find((note) => note.pos)?.pos;
  const source = arrangement || position;
  if (typeof source?.influencePrevious === "boolean" || typeof source?.influenceNext === "boolean")
    return normalizeOverrideInfluence(source);
  if (position?.scope === "forward") return { previous: false, next: true };
  // AN OVERRIDE IS LOCAL UNTIL IT IS TOLD NOT TO BE. It used to reach both ways by
  // default, which made pinning one chord quietly re-finger the bars either side of
  // it — the two most common complaints about a pin were both that, and neither
  // reported it as reach, because nothing on screen said the pin had any. Reaching is
  // the useful-but-surprising half, so it is the half that gets asked for: the note
  // menu carries a toggle per side on any column that has an override.
  return { previous: false, next: false };
}


// The ranked alternative shapes offered to the user for a column, ignoring any
// current pin (so they can always cycle back through the automatic options).
export function columnShapeChoices(notes, tuning, cap = SHAPES_PER_COL) {
  return rankShapes(enumerateShapes(notes, tuning), handProfileForTuning(tuning)).slice(0, cap);
}

// Build playable guitar realizations of a chord formula rather than preserving
// the source pitches. Used by the non-destructive "playable alternative" UI:
// every pitch class must occur at least once; extra strings duplicate tones.
export function chordArrangementChoices(pcs, root, count, tuning, sourcePitches = [], cap = SHAPES_PER_COL) {
  const profile = handProfileForTuning(tuning);
  const wanted = new Set(pcs.map((p) => ((p % 12) + 12) % 12));
  if (!wanted.size || count < wanted.size || count > tuning.length) return [];
  const options = tuning.map((open) => {
    const out = [null];
    for (let fret = 0; fret <= MAX_FRET; fret++) if (wanted.has((open + fret) % 12)) out.push({ fret, pitch: open + fret });
    return out;
  });
  const found = [];
  (function walk(string, picked, seen, frets) {
    if (found.length >= 5000) return;
    if (picked.length > count || picked.length + tuning.length - string < count) return;
    if (string === tuning.length) {
      if (picked.length !== count || seen.size !== wanted.size) return;
      const notes = picked.map((p) => ({ pitch: p.pitch, arranged: true }));
      const shape = new Map(notes.map((n, i) => [n, { string: picked[i].string, fret: picked[i].fret }]));
      if (hasPlayableFingering(shape, profile)) found.push({ notes, shape });
      return;
    }
    for (const o of options[string]) {
      if (!o) { walk(string + 1, picked, seen, frets); continue; }
      // A finger stands on exactly one fret, and a barre is still one finger, so
      // no assignment can hold five distinct fretted frets however the notes are
      // shared out. hasPlayableFingering would reject it at the leaf anyway;
      // rejecting it here is what keeps the 5- and 6-voice sizes affordable.
      const fresh = o.fret > 0 && !frets.has(o.fret);
      if (fresh && frets.size >= MAX_FINGERS) continue;
      const next = new Set(seen); next.add(o.pitch % 12);
      walk(string + 1, [...picked, { ...o, string }], next, fresh ? new Set(frets).add(o.fret) : frets);
    }
  })(0, [], new Set(), new Set());
  const distance = (pitch) => sourcePitches.length ? Math.min(...sourcePitches.map((p) => Math.abs(p - pitch))) : 0;
  const preferenceCost = (x) => {
      const pitches = x.notes.map((n) => n.pitch), bass = Math.min(...pitches) % 12;
      return (bass === root ? 0 : 2.5) + pitches.reduce((s, p) => s + distance(p), 0) * 0.035;
  };
  found.forEach((x) => { x.preferenceCost = preferenceCost(x); });
  found.sort((a, b) => shapeCost(a.shape, profile) + a.preferenceCost - shapeCost(b.shape, profile) - b.preferenceCost);
  const seen = new Set(), out = [];
  for (const x of found) {
    const key = shapeKey(x.shape);
    if (seen.has(key)) continue;
    seen.add(key); out.push(x);
    if (out.length === cap) break;
  }
  return out;
}


// Match a candidate's voices against the notes already written in the column.
// Pairing is a pitch multiset, so a shape that keeps one of two unisons keeps a
// note that is already there rather than deleting one and writing another.
//
// A voice the instrument cannot place keeps its note but loses the pin (there is
// no string/fret to pin it to) and is never newly written — an out-of-range pitch
// is a transcription problem, not something to add to the lane.
function columnRewritePlan(columnNotes, choice, flow) {
  const pin = (p) => ({
    string: p.string, fret: p.fret, scope: "local",
    influencePrevious: flow.previous, influenceNext: flow.next,
  });
  const spare = new Map();
  for (const note of columnNotes) {
    if (!spare.has(note.pitch)) spare.set(note.pitch, []);
    spare.get(note.pitch).push(note);
  }
  const keep = [], add = [];
  for (const voice of choice.notes) {
    const place = choice.shape.get(voice);
    const taken = spare.get(voice.pitch)?.shift();
    if (taken) keep.push({ note: taken, pos: place ? pin(place) : null });
    else if (place) add.push({ pitch: voice.pitch, pos: pin(place) });
  }
  return { keep, add, drop: [...spare.values()].flat() };
}

// The column exactly as transcribed, carried on every note of an overridden
// column (the same trick `arrangement` used, so it survives sorting and copying).
// A rewrite deletes and creates notes, so returning to automatic has to put those
// notes back, not merely drop the pins. Taken ONCE, at the first override, so it
// always names the written chord rather than whichever alternative came before.
function writtenColumnForm(columnNotes) {
  const saved = columnNotes.find((n) => n.written)?.written;
  if (saved) return saved;
  return columnNotes.map(({ pos, arrangement, written, ...rest }) => rest);
}

// Apply `choice` to one column of `laneNotes`, which means rewriting the column
// to what the shape actually plays: voices it drops leave the lane, pitches it
// adds arrive as real notes, and every survivor is pinned to its string/fret.
// A null choice restores the written chord and voices it automatically again.
//
// Returns { notes, column } — the lane's new note array and the column's new
// notes. Pure: no undo, no redraw, no selection, nothing outside the notes.
// `mintId` comes from the caller because note ids are drawn from app state, which
// this module deliberately cannot see; a preview copy needs none.
export function writeColumnOverride(laneNotes, columnNotes, choice, flow, mintId = null) {
  const gone = new Set(columnNotes);
  const without = () => laneNotes.filter((n) => !gone.has(n));
  if (!choice) {
    const saved = columnNotes.find((n) => n.written)?.written;
    if (!saved) {
      for (const n of columnNotes) { delete n.pos; delete n.arrangement; }
      return { notes: laneNotes, column: columnNotes };
    }
    // Clones, so the snapshot itself stays untouched and can be restored again.
    const column = saved.map((n) => ({ ...n }));
    return { notes: [...without(), ...column], column };
  }
  const written = writtenColumnForm(columnNotes);
  const { keep, add, drop } = columnRewritePlan(columnNotes, choice, flow);
  for (const { note, pos } of keep) {
    if (pos) note.pos = pos; else delete note.pos;
    delete note.arrangement;   // a legacy arrangement on this column is now spelled out in notes
    note.written = written;
  }
  if (!add.length && !drop.length) return { notes: laneNotes, column: keep.map((k) => k.note) };
  // Added notes take the column's own extent — the same bar the hover preview
  // ghosts, so what you previewed is what lands.
  const start = Math.min(...columnNotes.map((n) => n.start));
  const end = Math.max(...columnNotes.map((n) => n.end));
  const stroke = columnNotes.find((n) => n.stroke)?.stroke;
  const born = add.map(({ pitch, pos }) => ({
    ...(mintId ? { id: mintId() } : {}), start, end, pitch, pos, written,
    ...(stroke ? { stroke } : {}),
  }));
  const dropped = new Set(drop);
  return {
    notes: [...laneNotes.filter((n) => !dropped.has(n)), ...born],
    column: [...keep.map((k) => k.note), ...born].sort((a, b) => a.pitch - b.pitch),
  };
}


// ---- legacy `arrangement` overrides ----
// Limitation: read-only. Applying an alternative now rewrites the column's notes
// (writeColumnOverride), so nothing creates an `arrangement` any more — but
// projects saved before that still carry them, and dropping support would
// silently un-arrange somebody's finished transcription. Delete the three
// functions below, and the `arr` branch in scoreArrangementsInContext, once no
// project in .runs carries the field.

// Materialize persisted arrangement overrides for consumers such as tab and
// score exporters. Source notes remain untouched and continue to drive the
// spectrogram editor/playback.
export function arrangedNotes(notes) {
  const out = [];
  for (const col of chordColumns(notes)) {
    const arr = col.notes.find((n) => n.arrangement)?.arrangement;
    if (!arr || !Array.isArray(arr.notes) || !arr.notes.length) { out.push(...col.notes); continue; }
    const start = Math.min(...col.notes.map((n) => n.start));
    const end = Math.max(...col.notes.map((n) => n.end));
    const influence = normalizeOverrideInfluence(arr);
    for (const a of arr.notes) out.push({
      start, end, pitch: a.pitch,
      pos: {
        string: a.string, fret: a.fret, scope: "local",
        influencePrevious: influence.previous, influenceNext: influence.next,
      },
      arranged: true,
    });
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

// Source-note objects omitted by valid simplified chord arrangements. Matching
// is a pitch multiset because arrangements may retain one of several duplicated
// voices; the original annotations remain untouched for editing and playback.
export function omittedArrangementNotes(notes) {
  const omitted = new Set();
  for (const column of chordColumns(notes || [])) {
    const arrangement = column.notes.find((note) => note.arrangement)?.arrangement;
    if (!arrangement || !Array.isArray(arrangement.notes) || !arrangement.notes.length) continue;
    const retained = new Map();
    for (const note of arrangement.notes)
      retained.set(note.pitch, (retained.get(note.pitch) || 0) + 1);
    for (const note of column.notes) {
      const remaining = retained.get(note.pitch) || 0;
      if (remaining) retained.set(note.pitch, remaining - 1);
      else omitted.add(note);
    }
  }
  return omitted;
}

// The mirror of omittedArrangementNotes: pitches the arrangement plays that no
// source note carries. They have no note object to style, so the spectrogram
// draws them as ghosts — without this it crosses out the note an arrangement
// dropped and says nothing at all about the one that replaced it, and a swap
// reads as a plain deletion.
export function addedArrangementNotes(notes) {
  const added = [];
  for (const column of chordColumns(notes || [])) {
    const arrangement = column.notes.find((note) => note.arrangement)?.arrangement;
    if (!arrangement || !Array.isArray(arrangement.notes) || !arrangement.notes.length) continue;
    const spare = new Map();
    for (const note of column.notes) spare.set(note.pitch, (spare.get(note.pitch) || 0) + 1);
    const start = Math.min(...column.notes.map((n) => n.start));
    const end = Math.max(...column.notes.map((n) => n.end));
    for (const note of arrangement.notes) {
      const remaining = spare.get(note.pitch) || 0;
      if (remaining) spare.set(note.pitch, remaining - 1);
      else added.push({ pitch: note.pitch, start, end });
    }
  }
  return added;
}

// Last-resort placement: lowest fret per note, collisions on a string collapsed
// to the lower fret (mirrors the old export so we always return something).
function greedyShape(notes, tuning) {
  const byString = new Map();
  const placed = new Map();
  for (const n of [...notes].sort((a, b) => fretOptions(a, tuning).length - fretOptions(b, tuning).length)) {
    const opts = fretOptions(n, tuning);
    const free = opts.find((o) => !byString.has(o.s)) || opts[0];
    if (!free) continue;
    byString.set(free.s, true);
    placed.set(n, { string: free.s, fret: free.fret });
  }
  return placed;
}

// Median inter-onset interval of a column-onset list (seconds) — the reference
// tempo timeFactor scales against. 1 (neutral) when timing is missing/degenerate.
function medianIoi(times) {
  const d = [];
  for (let i = 1; i < times.length; i++) { const x = times[i] - times[i - 1]; if (x > 0) d.push(x); }
  if (!d.length) return 1;
  d.sort((a, b) => a - b);
  // Lower median deliberately resists one long rest in a short local window;
  // that rest is what phraseBreaks is trying to detect, not the local tempo.
  return d[(d.length - 1) >> 1];
}

// A rolling reference follows tempo/grid changes and is not distorted by a
// sparse intro or a dense passage elsewhere in the lane.
export function localIois(times, radius = 3) {
  return times.map((_, i) => {
    const lo = Math.max(0, i - radius), hi = Math.min(times.length, i + radius + 1);
    return medianIoi(times.slice(lo, hi));
  });
}

// Both sides of this comparison are durations derived from the same onsets by
// different routes, so an exact tie arrives as a float discrepancy rather than as
// equality: a gap of 5/6 s measured 0.8333333333333339 against a threshold of
// 0.8333333333333321 and became a phrase break by 1.8e-15 seconds. A break
// discards every motif window that crosses it, so that decided the fingering of a
// whole figure. Compare with a relative tolerance — a rest either clears four
// times the local pulse or it does not, and no rest is decided in the last digit.
const BREAK_EPSILON = 1e-9;

export function phraseBreaks(times, refs = localIois(times)) {
  return times.map((t, i) => {
    if (i === 0) return false;
    const limit = 4 * Math.max(refs[i], refs[i - 1]);
    return t - times[i - 1] > limit * (1 + BREAK_EPSILON);
  });
}


// Motif discovery is musical rather than mechanical. A slide, bend, or other
// technique can constrain an occurrence's eventual fingering, but it must not
// make the same pitch phrase disappear from the repetition count. Rhythm is
// likewise evidence for boundaries, not a hard identity: a slightly lengthened
// note remains the same motif.
const musicalRepeatNoteKey = (note) => String(Number(note?.pitch));

// `shift` carries the shape to a target column that is the same figure
// transposed. On a fretted instrument that is the easy case by construction:
// keep every string, add the semitone count to every fret, and the grip arrives
// pre-formed at a new seat — the move transitionResult already prices as a
// glide. An open string is not exempt; it simply becomes fret `shift`.
function cloneRealization(shape, targetColumn, shift = 0) {
  const source = new Map(), target = new Map();
  for (const [note, pos] of shape) {
    const fret = pos.fret + shift;
    if (fret < 0 || fret > MAX_FRET) return null;
    const key = String(Number(note.pitch) + shift);
    if (!source.has(key)) source.set(key, []);
    source.get(key).push({ string: pos.string, fret });
  }
  for (const note of targetColumn.notes) {
    const key = musicalRepeatNoteKey(note);
    if (!target.has(key)) target.set(key, []);
    target.get(key).push(note);
  }
  if (source.size !== target.size) return null;
  const out = new Map();
  for (const [key, notes] of target) {
    const positions = source.get(key);
    if (!positions || positions.length !== notes.length) return null;
    positions.sort((a, b) => a.string - b.string || a.fret - b.fret);
    notes.forEach((note, i) => out.set(note, { ...positions[i] }));
  }
  return out;
}


// ONE ANSWER PER NOTE, PER SONG — and a second opinion on every time it is
// reused. The memo above never reconsiders a grip it has already given out,
// which is the whole point of it, so the reconsidering happens here instead and
// only produces a mark: every candidate for the column is priced through the
// same window the memo's answer was, and the column is flagged when the field
// says the memory has gone stale.
//
// "Significantly better" is two tests, because one number cannot tell the two
// failures apart. Costs here are the engine's own currency, where 1.0 is
// roughly one fret of hand travel (COST_W.mfret), 0.45 a glide and 1.5 a
// re-grip.
//
//   gap      = what the remembered grip costs over the best alternative. Below
//              MARK_GAP the saving is not worth a player's attention: it is
//              less than moving the hand one fret.
//   standout = how far that best alternative sits below the MIDDLE of the
//              field. This is the test that reads a flat pile correctly. Four
//              shapes at 1.1, 1.1, 1.1 and a memory at 1.2 are all the same
//              answer with rounding on top; the same four at 1.1, 1.1, 0.5 are
//              not, and only the second is worth looking at. Without it, any
//              column whose alternatives happen to sit a fret apart marks
//              every time it repeats.
//
// A FIELD OF ONE HAS NO PACK, AND THE STANDOUT TEST MUST THEN ABSTAIN rather
// than answer 0. It reported `pack = best` when there was nothing left after
// the winner, which makes standout exactly 0 and fails the threshold no matter
// how large the saving — so a note with exactly TWO placements could never be
// marked at all. On a four-string bass that is most of the bottom octave: A#1
// is fret 1 of the A string or fret 6 of the E string and nothing else, and
// nineteen of one lane's A#1s were being silently passed over while the memo
// paid four to eight times the best alternative. A lone alternative is the
// whole field; it stands out by definition, and the gap decides on its own.
//
// Both are knobs, deliberately. Nothing derives them — they are where "a
// player would notice" falls on a cost axis, which is a question for a player.
export const MARK_GAP = 1.0;
export const MARK_STANDOUT = 0.5;


// The verdict is measured for every reuse and the threshold is applied here, at
// the point that draws it — pricing the field is the expensive half and it has
// already happened, so filtering earlier would save nothing and would throw away
// the numbers the thresholds are supposed to be chosen against.
export const significantRecall = (verdict, gapMin = MARK_GAP, standoutMin = MARK_STANDOUT) =>
  !!verdict && verdict.gap >= gapMin && (verdict.standout == null || verdict.standout >= standoutMin);


// Voice a list of columns → the chosen shape per column. New overrides carry
// independent previous/next influence flags. Legacy forward pins retain their
// old asymmetric, decaying pull into the following run.
// ============================================================================
// ENTRY POINTS — what the rest of the app calls
// Each one activates the caller's preferences first, then builds columns,
// candidates and a plan. voiceNotes is the one-shot form; voiceColumns is for
// callers that already have columns.
// ============================================================================


// What a note's written technique says about where it can be played. Audited
// against thirteen human transcriptions in a corpus audit, and every rule here
// is one the transcribers themselves keep — the human column of that audit is what
// separates physics from a guess about physics, and it threw out two rules I had
// written before it ran.
//
//   needsFret   a slide, a bend, a harmonic or fretting-hand vibrato cannot happen
//               on a bare open string. Transcribers break it 0.3% of 6,480; the
//               engine broke it 11.4%.
//   tap         a tapped note belongs to the PICKING hand and the fretting window
//               does not apply. The rule started life the other way round — "a
//               tapped note should sit inside the hand" — and the audit killed it:
//               the transcribers put one outside 80.1% of the time, because that
//               is what tapping is for.
//   trill       alternates with a fret one (half) or two (whole) above, and one
//               hand holds both, so the window has to cover the target too.
//   link        a shift slide and a legato slide run along ONE string. Legato
//               additionally lands fretted, because the left hand sounds the
//               target. Engine before: 56% and 43% wrong, now 0.8% and 1.5%.
//
// A HAMMER-ON RUNS ALONG ONE STRING TOO, and it only became safe to say so once
// the import stopped throwing the role away. While isHammerPullOrigin and
// ...Destination both collapsed to `true`, a destination and the NEXT run's origin
// were indistinguishable, so linking adjacent flagged pairs enforced a real rule on
// pairs that were often not pairs: the transcribers "broke" it 4.6% of the time and
// it cost 4.5 points of repeat consistency. With the role kept (guitar-pro-core.js)
// the pair is exact — an origin followed by a destination — and the human violation
// rate falls to 1.8%, which is where the slide rules live.
//
// A note the USER marked as a hammer carries plain `true` and has no role, so it is
// treated as both ends: the editor cannot author a direction and guessing one would
// be inventing data.
//
// WHAT IT STILL COSTS, named rather than hidden: two lanes of Stairway lose repeat
// consistency (95.0% -> 87.3% and 76.6% -> 75.0%; every other tracked lane is
// bit-identical). The cause is not the rule, it is that the marks are uneven — 15 of
// 20 four-note runs that recur in that song are hammered in one place and picked in
// another. Measured over the whole corpus, when a run appears both ways the
// transcriber fingers it identically 80% of the time (504 of 631): a human picks one
// fingering that serves both takes. This engine cannot, because it has no idea a phrase is a
// repeat — it decides each column from its neighbours and nothing else. The upgrade
// is repeat awareness, not dropping the constraint: a hammer-on across two strings is
// unplayable however the tab was marked.
//
// A dead note is deliberately NOT here. It looked like the same kind of exemption
// as a tap — a mute is the hand relaxing where it already is — but the audit says
// the engine already places them better than the transcribers do (0.9% against
// 5.5% outside the neighbouring hand), and code for a problem that is not there is
// how a rule list starts rotting.
//
// The hammer pair is found by looking, because the import cannot say: alphaTab's
// isHammerPullOrigin and isHammerPullDestination both collapse to one `fx.hammer`
// flag, so an origin and the NEXT pair's origin are indistinguishable. Two flagged
// notes in a row within a hand's reach of each other is a pair; the interval test
// is what takes the human violation rate from 7.0% to 4.6%.
function effectRule(note, next) {
  const rule = {};
  if (needsFret(note)) rule.fretted = true;
  if (note.slap === "tap") rule.free = true;
  if (note.trill) rule.reach = note.trill === "whole" ? 2 : 1;
  if (SLIDE_TO_NEXT.has(note.slide)) rule.link = note.slide === "legato" ? "fretted" : "any";
  // "any" and not "fretted": a pull-off onto an open string is ordinary playing.
  else if (hammerOrigin(note) && next.some(hammerDest)) rule.link = "any";
  return Object.keys(rule).length ? rule : null;
}

const hammerOrigin = (n) => n.fx && (n.fx.hammer === "origin" || n.fx.hammer === "both" || n.fx.hammer === true);
const hammerDest = (n) => n.fx && (n.fx.hammer === "dest" || n.fx.hammer === "both" || n.fx.hammer === true);

// Adapt the app's columns to the register engine's shape and back. Two mismatches to
// bridge: the app tunes high string first ([64,59,55,50,45,40]) where the engine indexes
// from the fattest, and the app carries pins on the notes where it takes them as
// a per-column `fixed`.
// WHERE THE PLAYER PUT THE HAND, in seconds, onto the columns that carry it. A hold
// is `{ t, fret }` and belongs to the first column at or after `t` — "the hand is at
// fret 7 from here" — so one placed between two notes takes effect on the next one
// rather than silently on neither. Past the last column it is dropped: a hand on
// music that is not there decides nothing.
//
// Times and not note objects, because a hold outlives the notes under it. Re-tracing
// a passage, nudging an onset or deleting a note all leave the hand where the player
// put it, which a pin hung off a note cannot do.
function holdsByColumn(columns, holds) {
  const out = new Array(columns.length).fill(null);
  for (const h of Array.isArray(holds) ? holds : []) {
    const t = Number(h?.t), fret = Number(h?.fret);
    if (!Number.isFinite(t) || !Number.isFinite(fret) || fret < 0) continue;
    const i = columns.findIndex((c) => Number(c.t0) >= t - 1e-6);
    if (i >= 0 && out[i] == null) out[i] = { fret };
  }
  return out;
}

function registerColumns(columns, tuning, options = {}) {
  const order = tuning.map((_, i) => i).sort((a, b) => tuning[a] - tuning[b]);
  const low = order.map((i) => tuning[i]);
  const seat = new Map(order.map((appIndex, leanIndex) => [appIndex, leanIndex]));

  const holds = holdsByColumn(columns, options.holds);
  const input = columns.map(({ notes, t0 }, i) => {
    const locked = lockedShape(notes, tuning);
    return {
      hold: holds[i],
      pitches: notes.map((n) => n.pitch),
      // Onset and release. Lean decides the register once per bar and charges
      // less to change it across a rest, so it needs both — without them the
      // whole lane collapses to one block, which still works and is just coarser.
      t0,
      end: notes.reduce((t, n) => Math.max(t, Number(n.end) || t0 || 0), t0 || 0),
      // A pin bypasses fitColumn entirely, so it also bypasses the rules below —
      // which is the behaviour the full engine already documents: an explicit pin
      // wins even when it contradicts the note's own technique. The user asked.
      fixed: locked ? notes.map((n) => seat.get(locked.get(n).string)) : null,
      rules: notes.map((n) => effectRule(n, columns[i + 1] ? columns[i + 1].notes : [])),
    };
  });

  // Where the hand stood for each column: the lowest fretted fret in that
  // column's bar. Lean no longer picks a window — it picks a REGISTER per bar and
  // reads every string off that — so the anchor is read back off what was played
  // rather than being the state itself, and it is per bar for the same reason it
  // is not per column. Dropping it here was why a bass line came
  // back with no anchor and an index finger on every note: with no hand from the
  // engine, the board falls back to reading each shape alone, and one note alone is
  // the index by definition.
  // How long the neck is, off the same measurements the fretboard draws — an
  // acoustic has 20 frets and an electric 22, and the engine inventing its own
  // number is how the voicer and the board come to disagree about the instrument
  // they are both describing. An unknown instrument gets the electric, which is
  // what fretboardFor already does for the drawing.
  //
  // And what the fretboard's other positions cost. The engine has no cost model in the
  // full engine's sense, but it has the one number that decided the column — how far
  // each note sits from its bar's register, plus the continuity term — and that is
  // the number the board's boxes have to carry, or they argue with the hand using
  // someone else's arithmetic. Priced inside the same walk, at the register the
  // column is decided in; see priceAssignment.
  //
  // Without it every offer came back unplayable and the worker filtered the whole
  // list away, so `Show other positions` drew nothing on a column with six of them.
  const priceAt = options.priceAt, sink = Array.isArray(options.priced) ? options.priced : null;
  const price = priceAt && sink && columns[priceAt.index] ? {
    index: priceAt.index, out: [],
    // Into the engine's own indexing: a shape is keyed by this column's note objects and
    // names an app string, and `seat` is the map between the two orderings.
    shapes: priceAt.shapes.map((shape) => columns[priceAt.index].notes.map((note) => {
      const pos = shape.get(note);
      return pos ? seat.get(pos.string) ?? -1 : -1;
    })),
  } : null;

  const seats = [];
  const voiced = voiceRegister(low, input, undefined, seats, options.bars,
    fretboardFor(options.instrument).frets, price);
  // One entry per offered shape, in order: that is the contract scoreShapesAsDecided
  // reads back. `fingers` is empty because the engine has none to give — the board falls
  // back to assignFingers, which is the same function the exported tab asks.
  if (price) for (const got of price.out) sink.push({ ...(got || { cost: Infinity, seat: null }), fingers: [] });
  return voiced.map((placed, i) => {
    const shape = new Map();
    const fingers = new Map();
    columns[i].notes.forEach((note, k) => {
      const p = placed[k];
      // -1 is the engine saying the instrument cannot reach this note. Leaving it out of
      // the shape is what the full engine's unplaceable notes already do.
      if (p.string < 0) return;
      shape.set(note, { string: order[p.string], fret: p.fret });
      // The finger the window implies: one per fret, counted from the seat. It is an
      // approximation and it is here so the board cannot contradict itself — an
      // anchor on fret 5 under a marker labelled "1" at fret 8 is a lie, and the
      // digit has to agree with the band it is counted from. Lean has no finger
      // model of its own; giving it one is a separate decision, and this is the
      // cheapest reading that is at least consistent. It gets barres right for free
      // (same fret, same number, so the board's capsule still forms) and gets a
      // reused finger wrong (it never reuses one, it stretches).
      if (p.fret > 0) fingers.set(note, Math.min(4, Math.max(1, p.fret - seats[i] + 1)));
    });
    if (options.hands) options.hands[i] = { seat: seats[i] ?? null, fingers };
    return shape.size ? shape : null;
  });
}

// Every entry point below goes through here, so this is the one place the engine
// is named. `registerColumns` is that engine: a register per bar, and each note on
// the string that lands nearest it. See its section at the foot of this file.
export function voiceColumns(columns, tuning, options = {}) {
  return registerColumns(columns, tuning, options);
}

// Flatten already-grouped columns into Map(note -> { string, fret }).
function voiceColumnsMap(columns, tuning, options = {}) {
  const out = new Map();
  voiceColumns(columns, tuning, options).forEach((sh) => {
    if (!sh) return;                              // a column with no playable position
    for (const [note, pos] of sh) out.set(note, pos);
  });
  return out;
}

// Voice an arbitrary set of notes → Map(note -> { string, fret }). The single
// entry point used by both the preview and the export.
export function voiceNotes(notes, tuning, cap = Infinity, options = {}) {
  return voiceColumnsMap(chordColumns(notes, cap), tuning, options);
}

// WHAT EACH OFFERED SHAPE WOULD COST, on the engine's own terms, and the hand that
// would play it. Index-aligned with `shapes`; `cost` is Infinity for one the column
// cannot be made to hold.
//
// This replaces scoreArrangementsInContext on the fretboard's route, and the reason is
// that there were two numbers. That one scores a candidate across a phrase- or
// section-wide window; the voicer decides the column across a much smaller one — the
// shape it just committed to plus a few notes ahead — so the two disagreed about how
// much better an alternative was, and the board was quietly answering a question the
// engine had never asked. A ranking the app did not use is not an explanation of what
// the app did.
//
// It costs a walk of the lane as far as the column, because a bounded window is
// defined by the hand that arrives at it and there is no way to know that hand without
// walking to it. That is the whole price of the number being the real one.
const UNPLAYED = { cost: Infinity, seat: null, fingers: [] };

export function scoreShapesAsDecided(shapes, columns, focusIdx, tuning, options = {}) {
  const column = columns[focusIdx];
  if (!column || !shapes.length) return shapes.map(() => UNPLAYED);
  // The offered shapes are keyed to their own note objects; the walk needs them keyed
  // to this column's. A shape that will not map onto it is not on offer here.
  const mapped = shapes.map((shape) => cloneRealization(shape, column));
  const priced = [];
  voiceColumns(columns, tuning, {
    ...options, priceAt: { index: focusIdx, shapes: mapped.filter(Boolean) }, priced,
  });
  let next = 0;
  return mapped.map((shape) => {
    if (!shape) return UNPLAYED;
    const got = priced[next++];
    return got && Number.isFinite(got.cost) ? got : UNPLAYED;
  });
}

// Which notes took a grip out of the memory above while a visibly better one
// was on offer here. One entry per source note, like overrideEffectKinds, so
// the result is cheap to hand back from the worker and simple for the canvas
// to draw; the value is the cost the memory is paying (recallReview's `gap`),
// which is what a threshold would be dialled against.
export function voicingReviewMarks(notes, tuning, options = {}) {
  const source = Array.isArray(notes) ? notes : [];
  const columns = chordColumns(source);
  const review = [];
  voiceColumns(columns, tuning, { ...options, review });
  const marks = new Array(source.length).fill(null);
  if (!review.length) return marks;
  const indexes = new Map(source.map((note, index) => [note, index]));
  for (const entry of review) {
    if (!significantRecall(entry)) continue;
    for (const note of columns[entry.index]?.notes || []) {
      const index = indexes.get(note);
      if (index != null) marks[index] = Math.round(entry.gap * 100) / 100;
    }
  }
  return marks;
}

// voiceNotes, plus the hand that played it: which finger took each note, and which
// fret the hand was anchored on while it did. Same single pass — the fingering is a
// by-product of the walk, so asking for it costs nothing beyond carrying it out.
//
// The board draws both, because "why did it choose that" is usually a question about
// where the hand already was, and a fret diagram that shows only positions cannot
// answer it. A note with no entry in `fingers`/`seats` is one a later pass moved; it
// keeps its position and loses its hand rather than reporting a stale one.
export function voiceNotesFingered(notes, tuning, cap = Infinity, options = {}) {
  const columns = chordColumns(notes, cap);
  const hands = [];
  const chosen = voiceColumns(columns, tuning, { ...options, hands });
  const voiced = new Map(), fingers = new Map(), seats = new Map();
  chosen.forEach((shape, i) => {
    const hand = hands[i];
    for (const [note, pos] of shape || []) {
      voiced.set(note, pos);
      if (!hand) continue;
      const finger = hand.fingers?.get(note);
      if (Number.isFinite(finger)) fingers.set(note, finger);
      if (hand.seat != null) seats.set(note, hand.seat);
    }
  });
  return { voiced, fingers, seats };
}

// Classify the visible source notes whose exported fingering is no longer the
// untouched automatic choice. "direct" is an authored position/arrangement
// override; "indirect" is an otherwise-automatic column whose chosen
// string/fret changed because those fixed neighbours participate in the passage
// optimization. Returning one entry per source note keeps the result cheap to
// transfer from the voicing worker and simple for the canvas to consume.
export function overrideEffectKinds(notes, tuning, options = {}) {
  const source = Array.isArray(notes) ? notes : [];
  const sourceColumns = chordColumns(source);
  const kinds = new Array(source.length).fill(null);
  if (!sourceColumns.some((column) =>
    column.notes.some((note) => note.pos || note.arrangement))) return kinds;

  const noteIndexes = new Map(source.map((note, index) => [note, index]));
  const directColumns = sourceColumns.map((column) =>
    column.notes.some((note) => note.pos || note.arrangement));
  if (directColumns.every(Boolean)) {
    sourceColumns.forEach((column) => {
      for (const note of column.notes) kinds[noteIndexes.get(note)] = "direct";
    });
    return kinds;
  }
  const baselineNotes = source.map((note) => {
    const copy = { ...note };
    delete copy.pos;
    delete copy.arrangement;
    return copy;
  });
  const performedNotes = arrangedNotes(source);
  const baselineColumns = chordColumns(baselineNotes);
  const performedColumns = chordColumns(performedNotes);
  // Both passes see the same bar plan, or the difference between them is the plan
  // rather than the override, and every note in the lane comes back marked.
  const baselineVoiced = voiceNotes(baselineNotes, tuning, Infinity, options);
  const performedVoiced = voiceNotes(performedNotes, tuning, Infinity, options);
  const realizationKey = (column, voiced) => (column?.notes || []).map((note) => {
    const position = voiced.get(note);
    return `${note.pitch}@${position ? `${position.string}:${position.fret}` : "-"}`;
  }).sort().join("|");

  sourceColumns.forEach((column, index) => {
    const direct = directColumns[index];
    const changed = direct || realizationKey(performedColumns[index], performedVoiced)
      !== realizationKey(baselineColumns[index], baselineVoiced);
    if (!changed) return;
    const kind = direct ? "direct" : "indirect";
    for (const note of column.notes) {
      const sourceIndex = noteIndexes.get(note);
      if (sourceIndex !== undefined) kinds[sourceIndex] = kind;
    }
  });
  return kinds;
}

// MIDI -> tab, in one idea: the fretting hand is a four-fret window, and inside
// that window a note takes the lowest string that reaches it.
//
// Measured against six hand-made Guitar Pro transcriptions (36 fretted lanes,
// 42,071 notes — Stairway, Hotel California, Master of Puppets, Nothing Else
// Matters, Teen Spirit, Do I Wanna Know):
//
//   * the window + lowest-string rule can *express* 99.7% of the fingerings
//     those six transcribers actually wrote. The representation is not the
//     bottleneck.
//   * told the right window, the rule reproduces 97.2% of their string choices
//     with no cost function at all — 100% on bass.
//   * so the only real decision is where the window sits, and that is what the
//     Viterbi below picks.
//
// No tunable cost is used for register bias, string-crossing cost, finger-stretch
// cost or travel minimisation; measured variants landed inside 74–79%. Open
// strings follow a separate rule: automatic voicing uses them only when no
// fretted placement is available. See
// docs/voicing-engine.md for the numbers and what they mean.

const SPAN = 4;          // the hand covers four frets. Corpus: 99.9% of chords fit three.

// HOW MANY FRETS THERE ARE IS A FACT ABOUT THE INSTRUMENT, so the caller states
// it and this is only the default for a caller that cannot. `web/fretboard-core.js`
// measures all three off named production models — electric 22, acoustic 20 (a
// 14-fret body join leaves 20 on the board), bass 20 — and the lane carries the
// `instrument` that selects one; registerColumns reads it from there, so the engine
// and the drawn neck cannot disagree about how long the neck is.
//
// It was a hardcoded 22 for every instrument, which was a fourth answer to a
// question the codebase already answered twice. Latent rather than live — over
// the thirteen transcriptions nothing lands above fret 20 on any lane, because
// the register keeps the hand low, and the writers exceed their own instrument
// 0.00% of the time on acoustic and bass — but an acoustic has no fret 21 to put
// a note on, whatever the corpus happens to ask for.
const DEFAULT_NECK_FRETS = 22;   // an electric; callers pass the real count

// The highest fret the index can stand on with a full grip still on the neck.
// Derived, so it follows the instrument instead of being a third number to keep
// in step.
const handCeiling = (maxFret) => maxFret - SPAN + 1;

// WHAT THE WINDOW MODEL NEEDED, AND WHY NONE OF IT IS HERE. Walking a four-fret
// window column by column needed a cost per move (flat, because the corpus says
// distance stops mattering once the hand commits), a smaller one for a one-fret
// nudge, a standing pull toward the nut to break the ties a flat cost leaves, and
// a large finite penalty for breaking a slide's string. All four are gone with
// the walk they served — the register decides position now, and it is decided per
// bar. The sweeps that produced them were real and are logged in
// docs/voicing-engine.md; they are history, not settings, and leaving them declared
// here would be four numbers a reader would reasonably think the engine reads.


// A note whose written technique restricts where it can be played. Everything the
// engine knows about effects arrives here; the caller derives it (see registerColumns)
// so this file stays ignorant of the app's note shape.
//
//   fretted  cannot be played on an open string — a slide slides a finger, a bend
//            pushes a fretted note, fretting-hand vibrato needs something to shake.
//   free     not held by the fretting hand at all, so the window does not apply.
//            A tapped note is the picking hand reaching wherever it likes: measured
//            over the corpus the transcribers put one outside the fretting hand 80%
//            of the time, which is the entire point of tapping, and the engine was
//            cramming 93% of them inside it.
//   reach    the hand must also cover this many frets ABOVE the note — a trill
//            alternates with a fret one or two up and both are held by one hand.
//   link     this note continues onto the SAME STRING in the next column: "any" for
//            a shift slide or a hammer/pull pair, "fretted" for a legato slide,
//            whose target is sounded by the left hand and so cannot be open.

/**
 * One column, one hand position. Walks the notes lowest pitch first and gives
 * each the lowest string that can reach it — open, or inside [hand, hand+SPAN).
 * Returns a string index per pitch, or null if the column will not fit.
 * `rules` is optional and parallel to `pitches`; see above.
 */
export function fitColumn(tuning, pitches, hand, span = SPAN, rules = null, maxFret = DEFAULT_NECK_FRETS) {
  const used = new Array(tuning.length).fill(false);
  const out = [];
  for (let i = 0; i < pitches.length; i++) {
    const p = pitches[i];
    const rule = rules ? rules[i] : null;
    let got = -1;
    for (let s = 0; s < tuning.length; s++) {
      if (used[s]) continue;
      const f = p - tuning[s];
      if (f < 0 || f > maxFret) continue;
      if (f === 0 && rule && rule.fretted) continue;
      if (f !== 0 && !(rule && rule.free)
        && (f < hand || f + (rule ? rule.reach || 0 : 0) >= hand + span)) continue;
      got = s;
      break;
    }
    if (got < 0) return null;
    used[got] = true;
    out.push(got);
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE REGISTER. Measured over all thirteen transcriptions (77 lanes, 128k notes),
// and it replaced the per-column hand Viterbi that used
// to live here because it is a different and much larger idea:
//
//   * a lane lives in two or three places. Median 2 positions cover 80% of its
//     notes, and 83% of hand-position holds return to one it has used before.
//   * so the decision is not "where is the hand in column i". One preferred fret
//     per BAR, with the hand never moving inside it, reproduces 95.1% of the
//     writers' string choices; one per lane already reproduces 81.1%. Deciding
//     per bar instead of per lane is worth 14-19 points, and it is the single
//     biggest lever in the problem.
//   * a note then takes the string that lands it NEAREST that fret — not the
//     fattest inside a window. Worth another 4.7 points at bar granularity. The
//     writers take the fattest reachable string only 17% of the time; the modal
//     choice is the second fattest, and "fattest that reaches" was only ever
//     right because a window forced it.
//
// The old window model is still here and still doing work — fitColumn expresses
// what a hand can HOLD, which is what the effect rules need — it just no longer
// decides where the hand goes. Peek-free this scores 73.2% against the window
// model's 66.2% on identical lanes.
//
// TRIED AND FAILED, so nobody builds them twice. An asymmetric cost, cheap
// reaching up from the index and dear reaching below it, which is true of a real
// hand: 62.6% against the symmetric 72.7%. A hard four-fret window as the cost
// instead of a point: 65.5%. Squared distance: 65.8%. The register is not the
// index finger, it is the fret a bar's notes cluster around, and a robust
// centroid beats a hand model here. Also: aligning the blocks to the last eighth
// of the bar, where the writers demonstrably shift more than mid-bar — no effect
// at all (95.1% -> 95.3% oracle), because those are single pickup notes and a
// soft register does not notice one note.
const TOPT = 18;         // registers considered: fret 0 to 17

// What changing register costs, in the same unit as the rest: one note sitting
// one fret away from where the hand is. 12 is not the value that maximises
// agreement — 4 is, by 1.5 points — and it is chosen anyway, because agreement
// cannot see what it buys. Two registers a couple of frets apart usually put the
// same notes on the same strings, so the percentage is nearly blind to WHEN the
// hand moves, and at 4 the model moved 1438 times against the writers' 719 and
// changed register at 13.5% of bar seams where the pitch had not moved at all.
// At 12: 698 shifts and 1.7% churn, against their 719 and 1.3%. See the "judge
// the tab by playing it" rule — this is the case it was written for.
const LAMBDA = 12;

// How hard each bar is pulled toward the lane's own home register. Bars land a
// whole string away from the writer in about a quarter of cases, and locally
// each of those is defensible — the same shape one string over — so the tie has
// to be broken from outside the bar. Knowing the home is worth +9.6 points
// (72.7 -> 82.8 with the oracle's), which is far more than anything else left on
// the table, and no estimator tried gets close to knowing it.
const MU = 1;

// A shift is cheaper where the music makes room for it and dearer where it does
// not. Read off the corpus rather than fitted: against a 3.5% base rate, the
// writers move the hand at 0.2% of seams where the pitch did not change and at
// ~20% after a rest of a quarter second. The flat cost had this exactly
// backwards — it churned on repeated material and sat still through the rests
// where a player repositions.
//
// 5-7 semitones is deliberately NOT cheap: that is the interval between two
// adjacent strings, so the hand crosses instead of moving, and the writers' own
// shift rate dips there in the middle of an otherwise rising curve.
// A HAND DOES NOT TELEPORT INSIDE A BAR. The register says where the hand lives,
// not where it was a moment ago, so each note seeks the register independently
// and two consecutive ones can land far apart when their options are spaced
// differently — a note only reachable at the 12th followed by one whose nearest
// option is the 3rd. Measured: 71% of the engine's jumps of five frets or more happened
// INSIDE one bar, where the register never changed, so they were never shifts at
// all. The window model got this free, because a window is continuity.
//
// Charged only BEYOND a hand's own reach, which is what makes it a constraint
// rather than a tax on movement. Taxing every fret of movement instead helped
// the gated corpus and cost 2.5 points overall, all of it Free Bird — a lane of
// wide arpeggios where crossing strings is the part. With the dead band, both
// improve: 76.0% -> 77.8% overall and two fewer gate failures.
//
// 16 is on a plateau (8 -> 77.7%, 16 and 32 -> 77.8%), which is the tell that it
// is not a weight being tuned: past a point it simply means "not unless there is
// no alternative", and the alternatives are what decide.
const STICK = 16;

const seamFactor = (silence, jump) =>
  (silence >= 0.25 ? 0.25 : 1) * (jump === 0 ? 4 : jump > 12 ? 0.5 : 1);

// AND AN OPEN STRING IS CHARGED IN FULL, which was tried the other way and is
// not close. Capping it at 2 frets — so a hand at the 3rd takes the open string
// beside it rather than climbing to the 5th, which is what a bassist does —
// reads well on a walking bass line and costs NINE POINTS over the corpus
// (74.2% -> 65.3%). The standalone analysis liked the cap; the engine, which
// also has the grip search and the effect rules, does not. Measured, not argued.

// WHAT ONE ALREADY-DECIDED ASSIGNMENT COSTS at register T — the same two terms
// gripAt charges, with the strings handed in instead of searched for. It exists for
// the fretboard's candidate boxes: the board offers every other place a column could
// be played and writes what each would cost, and that number only means something if
// it is the number the column was actually decided with. Pricing an offer any other
// way puts a second model's opinion on the neck.
//
// A shape wider than one hand is charged, not refused. gripAt could hold it at no g
// and fitAtRegister would fall back to its loose grip; refusing here would delete the
// offer from the board instead, which is what "no other positions" looked like.
// Limitation: the effect rules are not re-checked — the offers come from the full
// engine's enumeration and the board is answering "where else", not "is this legal".
function priceAssignment(tuning, pitches, strings, T, prev, span, maxFret) {
  let cost = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pitches.length; i++) {
    const st = strings[i];
    if (st == null || st < 0) return null;
    const f = pitches[i] - tuning[st];
    if (f < 0 || f > maxFret) return null;      // not on this instrument's neck
    let d = Math.abs(f - T);                    // an open string is charged in full, as above
    if (prev != null && f > 0) d += STICK * Math.max(0, Math.abs(f - prev) - SPAN);
    cost += d;
    if (f > 0) { if (f < lo) lo = f; if (f > hi) hi = f; }
  }
  if (hi > lo) cost += STICK * Math.max(0, hi - lo - (span - 1));
  // Where the index would stand to take it, read off the shape the same way the walk
  // reads it off the bar: the lowest fretted fret. Per shape and not per bar, because
  // an offer is a question about where the hand WOULD go. Nothing fretted, no hand.
  return { cost, seat: Number.isFinite(lo) ? lo : null };
}

/**
 * Where a note goes when the hand is at register `T`: the string that lands it
 * nearest that fret. The fattest string wins a tie, which is all that survives
 * of "take the lowest string that reaches" — a tie-break, not the decision.
 *
 * A column still has to be a shape one hand can hold, which the register on its
 * own does not say: it is a point the notes are drawn toward, and nothing stops
 * a chord being drawn to it from twelve frets apart. So the fretted notes of a
 * column must all sit inside one four-fret grip, and the grip is whichever one
 * lands the column nearest the register. The corpus says this costs nothing —
 * 99.8% of the writers' columns already span four frets or fewer, and 69.8% of
 * them span none at all — but without it a chromatic run produced chords no hand
 * could take.
 *
 * `forced` names a string a note must keep (a slide or hammer continuing onto
 * it) and is exempt from the grip, because the previous column already committed
 * the finger and the rest of the hand follows it. `rules` is as documented above
 * fitColumn.
 */
export function fitAtRegister(tuning, pitches, T, o = {}) {
  const span = o.span || SPAN, maxFret = o.maxFret || DEFAULT_NECK_FRETS;
  // A grip the player named is not searched for at all @@ see gripRun, which voiceRegister()
  // uses instead of this whenever a hold is in force. This function answers the free
  // question: where does the hand go when nobody said.
  let best = null;
  for (let g = 1; g <= handCeiling(maxFret); g++) {
    const got = gripAt(tuning, pitches, T, o, g, span, maxFret);
    if (got && (!best || got.cost < best.cost)) best = got;
  }
  // Nothing one hand can hold: seat it as near the register as possible anyway
  // and let the caller see the stretch. A transcription can ask for a chord no
  // hand takes, and saying so beats refusing to answer. Dropping the look-ahead
  // too, because a column that cannot be held at all cannot also be held to a
  // promise about the next one.
  const placed = best || gripAt(tuning, pitches, T, o, 1, maxFret + 1, maxFret)
    || gripAt(tuning, pitches, T, { ...o, rules: o.rules }, 1, maxFret + 1, maxFret, true);
  // Open strings are unavailable to automatic placement when that pitch can be
  // fretted anywhere else on the instrument. Explicit pins bypass this search.
  return (placed || { out: new Array(pitches.length).fill(-1) }).out;
}

// A HAND THE PLAYER PUT SOMEWHERE, WALKED FORWARD. It plays from `g` for as long as
// `g` can hold the notes; the first column it cannot hold is a SHIFT, and the hand
// goes to the nearest grip that can — up or down, whichever is closer, and the cheaper
// of the two against the register when both are the same distance away.
//
// The shift is the point. This used to fall straight through to the free search the
// moment one column did not fit, which silently threw the whole hold away: a hand held
// at 3 through a line containing one note that only exists at fret 2 or fret 7 came
// back voiced as though nothing had been asked for. A player who picks a position and
// is quietly overruled has no way to tell that from the feature not working — and it
// is not what a player does either, which is to hold the position until the music
// leaves it and then move.
//
// Returns the assignment and the grip it was taken at, or null when no grip anywhere
// can hold the column, which is the caller's cue to fall back to the free search.
function gripRun(tuning, pitches, T, o, g, span, maxFret) {
  const at = gripAt(tuning, pitches, T, o, g, span, maxFret);
  if (at) return { out: at.out, g };
  const ceiling = handCeiling(maxFret);
  for (let d = 1; d <= ceiling; d++) {
    let best = null;
    for (const cand of [g - d, g + d]) {
      if (cand < 1 || cand > ceiling) continue;
      const got = gripAt(tuning, pitches, T, o, cand, span, maxFret);
      if (got && (!best || got.cost < best.cost)) best = { out: got.out, g: cand };
    }
    if (best) return best;
  }
  return null;
}

// One column, one grip: every fretted note inside [g, g + span). Returns the
// assignment and what it cost in frets away from the register, or null if some
// note has nowhere to go.
function gripAt(tuning, pitches, T, o, g, span, maxFret, loose = false) {
  const rules = o.rules, forced = o.forced;
  const next = loose ? null : o.next, prev = loose ? null : o.prev;
  const used = new Array(tuning.length).fill(false);
  const out = new Array(pitches.length).fill(-1);
  let cost = 0;
  const fretOn = (i, s, free) => {
    const f = pitches[i] - tuning[s];
    const rule = rules ? rules[i] : null;
    const reach = (rule && rule.reach) || 0;
    if (f < 0 || f + reach > maxFret) return -1;
    if (f === 0 && rule && rule.fretted) return -1;
    if (f === 0 && hasFrettedPlacement(pitches[i], tuning, maxFret, reach)) return -1;
    // A note that continues onto this string has to be able to LEAVE on it: a
    // slide slides along one string, so a source seated where its target is open
    // (or off the neck) is not a legal seat for the source, however near the
    // register it is. Greedy placement cannot discover that after the fact —
    // the old window model priced the break in its transition, and this is where
    // that check has to live now.
    if (f !== 0 || !rule || !rule.fretted) { /* fall through */ }
    if (rule && rule.link && next && next.length) {
      const ok = next.some((q) => {
        const nf = q - tuning[s];
        return nf >= 0 && nf <= maxFret && !(rule.link === "fretted" && nf === 0);
      });
      if (!ok) return -1;
    }
    if (f === 0) return 0;
    // An open string is available from any grip; a fretted one is not. `free` is
    // a note the last column already committed to this string.
    if (!free && !(rule && rule.free) && (f < g || f + reach >= g + span)) return -1;
    return f;
  };
  if (forced) {
    for (let i = 0; i < pitches.length; i++) {
      const s = forced[i];
      if (s == null || s < 0 || used[s]) continue;
      const f = fretOn(i, s, true);
      if (f < 0) continue;
      used[s] = true; out[i] = s; cost += Math.abs(f - T);
    }
  }
  for (let i = 0; i < pitches.length; i++) {
    if (out[i] >= 0) continue;
    const rule = rules ? rules[i] : null;
    const reach = (rule && rule.reach) || 0;
    let bestS = -1, bestD = Infinity;
    for (let s = 0; s < tuning.length; s++) {          // fattest first, so it takes ties
      if (used[s]) continue;
      const f = fretOn(i, s, false);
      if (f < 0) continue;
      // A trill is held by one hand together with its own target, so the string
      // has to suit both frets; everywhere else reach is 0 and this is |f - T|.
      // The iteration order makes the fattest string win an exact tie.
      let d = Math.max(Math.abs(f - T), Math.abs(f + reach - T));
      if (prev != null && f > 0) d += STICK * Math.max(0, Math.abs(f - prev) - SPAN);
      if (d < bestD) { bestD = d; bestS = s; }
    }
    if (bestS < 0) return null;
    used[bestS] = true; out[i] = bestS; cost += bestD;
  }
  return { out, cost };
}

// What a block of music costs at register T. Open strings are considered only
// for pitches with no fretted placement; deliberate open choices are made by
// the player with a fingering pin.
function hasFrettedPlacement(pitch, tuning, maxFret, reach = 0) {
  return tuning.some((open) => {
    const fret = pitch - open;
    return fret > 0 && fret + reach <= maxFret;
  });
}

function blockCost(tuning, cols, T, maxFret) {
  let cost = 0;
  for (const c of cols) {
    if (c.fixed) continue;                    // already decided; it pays nothing
    const used = new Array(tuning.length).fill(false);
    for (let i = 0; i < c.pitches.length; i++) {
      let best = Infinity, bs = -1;
      for (let s = 0; s < tuning.length; s++) {
        if (used[s]) continue;
        const f = c.pitches[i] - tuning[s];
        if (f < 0 || f > maxFret) continue;
        if (f === 0 && hasFrettedPlacement(c.pitches[i], tuning, maxFret)) continue;
        const d = f === 0 ? 0 : Math.abs(f - T);
        if (d < best) { best = d; bs = s; }
      }
      if (bs < 0) { cost += 6; continue; }    // unreachable: no register helps
      used[bs] = true; cost += best;
    }
  }
  return cost;
}

// Group columns by bar. With no bar lines the whole lane is one block, which is
// not a fallback to some other engine — it is the same model at its coarsest,
// and that is still worth 81.1% against the writers.
//
// A COLUMN THE PLAYER HAS PUT A HAND ON also starts a block, wherever it falls. The
// bar is the granularity the engine chooses at, because that is what measured best;
// it is not the granularity a person is allowed to decide at, and a decision cannot
// start in the middle of a block that was already decided. So a hold cuts the bar it
// lands in, and the beats before it keep whatever they had.
//
// Walked in order rather than bucketed by bar index, because a hold has to split a
// bucket the bar line would have kept whole. Columns arrive time-sorted (chordColumns
// sorts them); out of order this makes more, smaller blocks rather than wrong ones.
function blocksOf(columns, bars, ignoreHolds = false) {
  const graded = bars && bars.length >= 2;
  const blocks = [], bar = [];
  let last = -1;
  columns.forEach((c, i) => {
    let b = 0;
    if (graded && typeof c.t0 === "number") { while (b + 1 < bars.length && bars[b + 1] <= c.t0 + 1e-6) b++; }
    if (!blocks.length || b !== last || (!ignoreHolds && c.hold != null)) { blocks.push([]); bar.push(b); }
    blocks[blocks.length - 1].push(i);
    last = b;
  });
  return blocks.length ? { blocks, bar } : { blocks: [columns.map((_, i) => i)], bar: [0] };
}

// WHAT A BLOCK IS SCORED ON. Its own columns — except for the first half of a bar a
// hold cut in two, which is scored on the WHOLE bar. That half is *before* the edit,
// and answering its register from the two notes it has left instead of from the bar
// it came from is how placing a hold changed the notes in front of it: not the
// Viterbi, which the runs below already wall off, but the cut itself shrinking the
// question. Scored on the bar, the run sees exactly the cost it saw before the cut
// and returns exactly the register it returned before.
function scoringOf(blocks, bar) {
  return blocks.map((idx, b) => {
    let out = idx;
    for (let k = b + 1; k < blocks.length && bar[k] === bar[b]; k++) out = out.concat(blocks[k]);
    return out;
  });
}

// Viterbi over BARS, not over columns. That is the whole difference from the
// window model this replaced: the decision is made once for a bar's worth of
// notes, so it cannot drift a fret at a time.
function solveRegisters(tuning, columns, blocks, bar, mu, home, maxFret, bare = false) {
  const nb = blocks.length;
  const score = scoringOf(blocks, bar);
  // `bare` is the home estimate asking what this lane would do with nobody's hand on
  // it. Where the lane LIVES is a fact about the music; a hold is the player
  // overriding that fact for a bar, and letting it back into the estimate is a second
  // way for one hold to reach backwards — a quiet one, because it moves `home` for
  // the whole lane rather than any one block. It was the only leak the run-splitting
  // below did not close.
  const held = bare ? blocks.map(() => null) : blocks.map((idx) => holdOf(columns, idx));
  const cost = blocks.map((idx, bi) => {
    const cols = score[bi].map((i) => columns[i]);
    // A HELD BLOCK IS NOT SCORED, IT IS TOLD. The player put the hand somewhere, so
    // that block has one legal state and neither the music's opinion of it nor the
    // pull toward the lane's home enters. Read off `held` above and NOT by asking
    // holdOf again: an inner `const held` here shadowed that array, which quietly
    // undid `bare` and let the home estimate see the holds after all.
    if (held[bi]) return Array.from({ length: TOPT }, (_, T) => (T === held[bi].T ? 0 : Infinity));
    return Array.from({ length: TOPT }, (_, T) => blockCost(tuning, cols, T, maxFret) + mu * Math.abs(T - home));
  });
  // What the seam between two blocks says about whether a hand would move there.
  const seam = [0];
  for (let b = 1; b < nb; b++) {
    const a = columns[blocks[b - 1][blocks[b - 1].length - 1]];
    const c = columns[blocks[b][0]];
    const silence = typeof a.end === "number" && typeof c.t0 === "number" ? Math.max(0, c.t0 - a.end) : 0;
    const jump = Math.abs(Math.min(...c.pitches) - Math.min(...a.pitches));
    seam.push(LAMBDA * seamFactor(silence, jump));
  }
  // A HOLD IS A WALL, AND THE SOLVE STOPS AT IT. Left as one run the DP is a
  // Viterbi, and a forced state at bar 30 changes which predecessor is cheapest at
  // bar 29, 28, 27 — so putting the hand somewhere re-fingered the approach to it.
  // That is a defensible model of a player (nobody teleports into a position) and it
  // is the wrong contract for an edit: an edit that rewrites what you already
  // listened to is an edit you cannot make one at a time. So the lane is solved in
  // runs that END at each hold, and each run is decided knowing nothing about the
  // holds after it. Forward is untouched — a held block is the first block of the
  // next run, and the seam out of it charges LAMBDA like any other, which is what
  // makes one hold carry a phrase.
  const out = new Array(nb);
  let start = 0;
  for (let b = 1; b <= nb; b++) {
    if (b < nb && !held[b]) continue;
    solveRun(cost, seam, start, b, out);
    start = b;
  }
  return out;
}

// One run of the Viterbi over blocks [lo, hi). The flat-penalty trick: the cheapest
// predecessor is either yourself or the globally cheapest state, so this is
// O(blocks x TOPT) rather than O(blocks x TOPT^2).
function solveRun(cost, seam, lo, hi, out) {
  if (hi <= lo) return;
  let dp = cost[lo].slice();
  const back = [];
  for (let b = lo + 1; b < hi; b++) {
    let bi = 0;
    for (let T = 1; T < TOPT; T++) if (dp[T] < dp[bi]) bi = T;
    const nd = new Array(TOPT), bk = new Array(TOPT);
    for (let T = 0; T < TOPT; T++) {
      let v = dp[T], p = T;
      if (dp[bi] + seam[b] < v) { v = dp[bi] + seam[b]; p = bi; }
      nd[T] = v + cost[b][T]; bk[T] = p;
    }
    back.push(bk); dp = nd;
  }
  let k = 0;
  for (let T = 1; T < TOPT; T++) if (dp[T] < dp[k]) k = T;
  for (let b = hi - 1; b >= lo; b--) { out[b] = k; if (b > lo) k = back[b - 1 - lo][k]; }
}

// What the player asked for in this block: the fret the hand stands on. `grip` pins
// the hand there and `T` is the register the notes are pulled toward, which is the
// MIDDLE of the hand's own four frets — the hand covers [g, g + span), so pulling to
// g alone would ask every note to sit under the index.
//
// It carried a second number for a while: a fret already inside the hand's reach was
// read as a request for the NOTE rather than for a shift, so the grip stayed and only
// the pull moved. That guess is gone. A hand override is a hand override, and asking
// for a note somewhere else is now the neck's own gesture (a ring, not a click on
// bare wood).
//
// The first hold in a block wins: two can only land on the same column, and there is
// no order in which both are true.
function holdOf(columns, idx) {
  for (const i of idx) {
    const h = columns[i].hold;
    if (h == null) continue;
    const fret = Number(Number.isFinite(h) ? h : h.fret);
    if (!Number.isFinite(fret)) continue;
    const grip = Math.max(1, Math.round(fret));
    return { grip, T: Math.max(0, Math.min(TOPT - 1, grip + ((SPAN - 1) >> 1))) };
  }
  return null;
}

// Cheapest register for the lane with nothing pulling it, which is the first
// pass's answer and half of the home estimate. The other half is the lane's
// 5th-percentile pitch measured on the fattest string — a part's low notes can
// only be played low, so it is anchored to something the model cannot talk
// itself out of. Both are weak on their own (27.6% and 13.2% exact); they are
// averaged because they are wrong in different directions.
function homeRegister(tuning, columns, blocks, bar, maxFret) {
  const pitches = columns.flatMap((c) => c.pitches).sort((a, b) => a - b);
  if (!pitches.length) return 0;
  const clamp = (v) => Math.max(0, Math.min(TOPT - 1, Math.round(v)));
  // How high the part sits: its 5th-percentile pitch measured against the SECOND
  // fattest string. Two honest caveats. It saturates — 46 of the corpus's 76
  // lanes clamp at 17 — so for most lanes this half of the blend is a constant
  // and only the other half varies. And a plain constant gets close: 8 scores
  // 75.3% against this term's 75.9%, so most of what it buys is simply "the
  // model crowds the nut, pull it up". The 0.6 that is left is real per-lane
  // signal, from the lanes that do not clamp.
  //
  // Measured against the alternatives, all with everything else fixed: against
  // the fattest string 75.2%, against the string that would actually carry the
  // note 72.4%, halved 75.3%, this 75.9%. The most principled reading is the
  // worst one, which is worth knowing and not worth pretending otherwise. It is
  // a default in any case — knowing a lane's true home is worth +9.6 points over
  // any of these, and that is a number a player can simply look at a part and
  // say.
  const floorNote = pitches[Math.floor(pitches.length * 0.05)];
  // Capped at the 12th and not at the neck's end. Above the 12th you are in a
  // register a player would state rather than one a default should guess at, and
  // the corpus is flat about it: 8, 10, 12 and 17 score 75.8 / 75.8 / 76.0 /
  // 76.1, so the cap costs a tenth of a point and stops a lead line whose lowest
  // note is an E4 defaulting to the 17th fret.
  const low = Math.max(0, Math.min(12, Math.round(floorNote - tuning[Math.min(1, tuning.length - 1)])));
  return clamp((low + medianOfFlat(tuning, columns, blocks, bar, maxFret)) / 2);
}

function medianOfFlat(tuning, columns, blocks, bar, maxFret) {
  const flat = solveRegisters(tuning, columns, blocks, bar, 0, 0, maxFret, true);
  const seen = [];
  blocks.forEach((idx, b) => { for (const i of idx) for (let k = 0; k < columns[i].pitches.length; k++) seen.push(flat[b]); });
  seen.sort((a, b) => a - b);
  return seen.length ? seen[seen.length >> 1] : 0;
}

/**
 * @param tuning  open-string MIDI pitches, physical order, index 0 = fattest
 *                string. Standard guitar is [40,45,50,55,59,64].
 * @param columns [{ pitches: [midi, ...], t0?, end?, fixed?, rules? }, ...] in
 *                time order. Pitches sounding together are one column; order
 *                inside it does not matter. `t0`/`end` are onset and release
 *                seconds — without them every column falls in one block and the
 *                lane gets a single register. `fixed` is an optional string
 *                index per pitch for a column the caller has already decided —
 *                an authored pin — and it is obeyed exactly. `hold` is a fret the
 *                player has put the hand on at this column; it starts a block and
 *                fixes its register, and the blocks after it are still solved.
 * @param span    how many frets one grip covers. The register says where the
 *                hand lives; this says how far it reaches from there, and every
 *                fretted note of a column has to fit inside one.
 * @param seats   optional array, filled with the fret the index stands on for
 *                each column — the lowest fretted fret in that column's own bar,
 *                so a lone note does not report itself as the anchor. The board
 *                draws this as the hand's band.
 * @param bars    bar-line times in seconds. The register is decided once per
 *                bar, which is the model's entire structure.
 * @param maxFret how many frets this instrument has. An acoustic has 20 and an
 *                electric 22; `web/fretboard-core.js` holds the measurements and
 *                registerColumns reads them off the lane.
 * @param price   optional { index, shapes, out }: string-index assignments for one
 *                column, priced where that column is decided and written back to
 *                `out`. See priceAssignment — this is what the fretboard's other
 *                positions cost.
 * @returns per column, per input pitch: { string, fret }. `string` is -1 for a
 *          note the instrument cannot play (below the lowest string, or a
 *          seventh voice on six strings) — the caller decides whether to
 *          octave-shift it or drop it.
 */
export function voiceRegister(tuning, columns, span = SPAN, seats = null, bars = null, maxFret = DEFAULT_NECK_FRETS, price = null) {
  const n = columns.length;
  if (!n) return [];

  // Sort each column once; placement walks it lowest pitch first.
  const sorted = columns.map((c) => {
    const idx = c.pitches.map((_, i) => i).sort((a, b) => c.pitches[a] - c.pitches[b]);
    return {
      idx, t0: c.t0, end: c.end, hold: c.hold,
      pitches: idx.map((i) => c.pitches[i]),
      fixed: c.fixed ? idx.map((i) => c.fixed[i]) : null,
      rules: c.rules ? idx.map((i) => c.rules[i]) : null,
    };
  });

  const { blocks, bar } = blocksOf(sorted, bars);
  // WHERE THE LANE LIVES is measured on bars alone. A hold splits the bar it lands
  // in, and the home estimate is a solve over whatever blocks it is handed — so the
  // split alone moved `home` for the whole lane, which moved the bars BEFORE the
  // hold. One of three quiet ways an edit reached backwards, and none of them was
  // the Viterbi everybody suspects.
  const flat = blocksOf(sorted, bars, true);
  const home = homeRegister(tuning, sorted, flat.blocks, flat.bar, maxFret);
  const registers = solveRegisters(tuning, sorted, blocks, bar, MU, home, maxFret);

  // Place every column at its bar's register, carrying forward the one thing a
  // register cannot express: a note that continues onto a NAMED string, because
  // a slide slides along one string and a hammer-on lands on the one already
  // held. The window model priced a break in its transition; here the constraint
  // is simply handed to the next column, which is what actually happens.
  const strings = new Array(n);
  // Where the hand stood for each column of a HELD block, which is not the same as the
  // read-back below: it is the grip the placement actually used, so it can say that the
  // hand started at the fret the player named and moved at the column that made it move.
  const stood = new Array(n).fill(null);
  let carry = null, prevFret = null;
  for (let b = 0; b < blocks.length; b++) {
    const T = registers[b];
    // A HOLD IS THE WHOLE BLOCK'S, not just the column it was placed on. "My hand is
    // on fret 9 here" is a statement about the hand, and the hand does not move again
    // until the next bar line or the next hold — which is what a block already is.
    const grip = holdOf(sorted, blocks[b])?.grip ?? null;
    // The hand the hold put down, and wherever it has since had to move to. It carries
    // forward rather than snapping back to the named fret: "play from 3 until that stops
    // working, then shift" is one shift, and a hand that returned to 3 the moment it
    // could would be a hand hopping back and forth mid-phrase.
    let stand = grip;
    for (const i of blocks[b]) {
      const c = sorted[i];
      const after = sorted[i + 1];
      // Before the placement, so `prevFret` is still the hand this column arrives
      // with — the offers and the grip that is taken are then on one scale.
      if (price && price.index === i) {
        price.out = price.shapes.map((given) =>
          priceAssignment(tuning, c.pitches, c.idx.map((k) => given[k]), T, prevFret, span, maxFret));
      }
      // A HELD BLOCK IS PLACED WITH NO MEMORY OF WHERE THE HAND WAS. STICK exists to
      // stop the engine teleporting the hand for no reason, and a hold is a reason: it
      // is the player saying the shift happens here. Left in, it wins — a hand pinned
      // to fret 2 one beat after fret 12 was charged 48 for the drop and played at 7
      // instead, which is a pin that visibly does not do what it says.
      const opts = {
        rules: c.rules, forced: carry, span, maxFret,
        next: after ? after.pitches : null, prev: grip != null ? null : prevFret,
      };
      let got;
      if (c.fixed) got = c.fixed.slice();
      else if (stand != null) {
        const run = gripRun(tuning, c.pitches, T, opts, stand, span, maxFret);
        // Null means no grip on the neck can hold this column at all — a chord no hand
        // takes. The free search below says so honestly instead of pretending the hold
        // still applies, and the hand keeps its last real position.
        if (run) { got = run.out; stand = run.g; }
        else got = fitAtRegister(tuning, c.pitches, T, opts);
        stood[i] = stand;
      } else got = fitAtRegister(tuning, c.pitches, T, opts);
      // Nothing placeable at all: a chord no instrument can hold. Say so with -1
      // rather than silently inventing a shape.
      if (got.some((s) => s < 0)) got = placeAnyway(tuning, c.pitches, got, maxFret);
      strings[i] = got;
      // Where the fretting hand just was, for the continuity term above. A note
      // the fretting hand never held does not count: a tapped note is the other
      // hand reaching wherever it likes, and letting it set this stranded the
      // fretting hand up at the tap and would not let it come back.
      {
        let lo = Infinity;
        for (let k = 0; k < got.length; k++) {
          if (got[k] < 0 || (c.rules && c.rules[k] && c.rules[k].free)) continue;
          const fr = c.pitches[k] - tuning[got[k]];
          if (fr > 0 && fr < lo) lo = fr;
        }
        if (Number.isFinite(lo)) prevFret = lo;
      }
      // Which strings the next column has to keep, and for which of its notes.
      carry = null;
      const next = after;
      if (c.rules && next) {
        for (let k = 0; k < c.rules.length; k++) {
          const link = c.rules[k] && c.rules[k].link;
          if (!link || got[k] < 0) continue;
          if (!carry) carry = new Array(next.pitches.length).fill(null);
          // The target is whichever of the next column's notes that string can
          // sound; a legato slide's target must also land fretted.
          for (let j = 0; j < next.pitches.length; j++) {
            if (carry[j] != null) continue;
            const f = next.pitches[j] - tuning[got[k]];
            if (f < 0 || f > maxFret) continue;
            if (link === "fretted" && f === 0) continue;
            carry[j] = got[k];
            break;
          }
        }
      }
    }
  }

  // The hand the board draws. The register is a centroid, not a finger — an
  // asymmetric cost that treated it as the index measured ten points worse — so
  // the anchor is read back off what was actually played: the lowest fretted
  // fret in the bar. Per bar and not per column, because a lone note taken on
  // its own reports itself as the index, which is how every note in a bass line
  // came back fingered 1.
  if (seats) {
    for (let b = 0; b < blocks.length; b++) {
      // A HELD BLOCK REPORTS THE HAND IT WAS GIVEN and never reads it back off the
      // notes. The read-back is the lowest fretted fret, and a hand gripping 9 to 12
      // whose lowest note is at 10 reports 10 — true of the notes, and one fret away
      // from the band the player just pointed at.
      //
      // Per column, because inside a held block the hand can shift: it stands where it
      // was put until a column cannot be held there. That is what gripRun walks, and
      // this is the grip it actually took, so the per-column reading does NOT inherit
      // the read-back's problem below — a lone note cannot report itself as the index
      // when nobody is reading the note.
      const grip = holdOf(sorted, blocks[b])?.grip ?? null;
      if (grip != null) {
        for (const i of blocks[b]) seats[i] = stood[i] ?? grip;
        continue;
      }
      let lo = Infinity;
      for (const i of blocks[b]) {
        const c = sorted[i];
        for (let k = 0; k < c.pitches.length; k++) {
          const s = strings[i][k];
          if (s < 0) continue;
          const f = c.pitches[k] - tuning[s];
          if (f > 0 && f < lo) lo = f;
        }
      }
      const seat = Number.isFinite(lo) ? lo : Math.max(1, registers[b]);
      for (const i of blocks[b]) seats[i] = seat;
    }
  }

  return sorted.map((c, i) => {
    const out = new Array(c.idx.length);
    for (let k = 0; k < c.idx.length; k++) {
      const s = strings[i][k];
      out[c.idx[k]] = s < 0
        ? { string: -1, fret: -1 }
        : { string: s, fret: c.pitches[k] - tuning[s] };
    }
    return out;
  });
}

// Last resort for the notes a register could not seat. Works down from the top
// pitch and gives each the *highest* string that reaches it, which leaves the fat
// strings free for the notes that have nowhere else to go — going up from the
// bottom instead lets one low note eat the only string three others could have
// used. Whatever is still unplaceable comes back as -1.
//
// It fills the gaps in `out` rather than replacing it, and honours the strings
// already spoken for. Merging its answer over a partial one without doing that
// was a real bug: it handed out strings the register had already used, so a
// column came back holding two notes on one string and a seventh voice on a
// six-string quietly became playable.
function placeAnyway(tuning, pitches, out = null, maxFret = DEFAULT_NECK_FRETS) {
  const seated = out ? out.slice() : new Array(pitches.length).fill(-1);
  const used = new Array(tuning.length).fill(false);
  for (const s of seated) if (s >= 0) used[s] = true;
  for (let i = pitches.length - 1; i >= 0; i--) {
    if (seated[i] >= 0) continue;
    for (let s = tuning.length - 1; s >= 0; s--) {
      if (used[s]) continue;
      const f = pitches[i] - tuning[s];
      if (f < 0 || f > maxFret) continue;
      if (f === 0 && hasFrettedPlacement(pitches[i], tuning, maxFret)) continue;
      used[s] = true;
      seated[i] = s;
      break;
    }
  }
  return seated;
}
