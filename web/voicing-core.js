// The voicing cost engine: pure note→(string,fret) assignment, no DOM. Split from
// voicing.js (which keeps the chord-preview UI and re-exports everything here) so
// the model is importable headless — tests/web runs it under node.

import { noteName } from "./util.js";
import { MAX_FRET, OVERLAP_EPS } from "./constants.js";
import { NO_FINGER, THUMB, barreSpanSupported, fretboardFor } from "./fretboard-core.js";
import { SLIDES_TO_NEXT as SLIDE_TO_NEXT, SLIDE_OUT, edgeSlideFrets, edgeSlideSpan, slideInOf, slideReach } from "./bend.js";

// One source of truth for string/fret choice, shared by the chord preview and
// (via buildTabSpec) the Guitar Pro export, so what you see is what you export.
// Notes are grouped into onset columns. The register engine plans positions per
// bar; a separate, small grip model assigns fingers and checks alternatives.

// Fretting fingers, index through little. The thumb is only a choice, and a barre
// is one finger across strings — so this also bounds the number of DISTINCT
// frets any playable shape can hold.
const MAX_FINGERS = 4;
export { THUMB, NO_FINGER };

const HAND_SPAN = 8;      // generous search guard; physical finger-pair reach decides comfort/feasibility

const SHAPES_PER_COL = 6; // alternatives shown in the chord preview
const DP_SHAPES_PER_COL = 18; // final context-aware search set
const DP_CONTEXT_POOL = 48;   // broader pool inspected before neighbouring context prunes it

// The register engine chooses strings/frets. This small, independent grip model
// assigns fingers and filters alternatives; it does not plan a second passage.
const COMFORT_REACH = 3;

// Movement weights retained by the public transition helpers and hand anchoring.
const COST_W = {
  mfret: 1, mstring: 0.30, fingerMove: 0.48, fingerSide: 0.65,
  place: 0.12, pivot: 0.30, slide: 8, glide: 0.45, plan: 0.18,
};

const MAX_HAND_SPAN_MM = 115;
// The limits below are what ordinary playing asks for. A big hand with practice
// reaches further: a shape that fits only this much more is "not reasonable",
// one that fails even here is not playable at all.
const STRETCH_REACH = 2.0;
const SPREAD_COST = 1;   // per fret a finger pair spreads beyond one finger per fret
const MAX_BARRE_SPAN_BY_FINGER = { 1: Infinity, 2: 3, 3: 3, 4: 3 };

const GUITAR_HAND_PROFILE = Object.freeze({
  id: "guitar6", stringCount: 6, scaleLengthMm: 648, stringSpacingMm: 7,
});

// A bass fret is a third wider, so its stretch stops a fret sooner.
export const BASS_HAND_PROFILE = Object.freeze({
  id: "bass4", stringCount: 4, scaleLengthMm: 864, stringSpacingMm: 9, maxReach: 5,
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

const STRETCH_CACHE = new Map();
const stretchProfile = (profile) => {
  let stretched = STRETCH_CACHE.get(profile.id);
  if (!stretched) STRETCH_CACHE.set(profile.id, stretched = { ...profile, id: `${profile.id}:stretch`, reach: STRETCH_REACH });
  return stretched;
};

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

const CHORD_GAP = 0.06;   // s; onset spread that still counts as one chord

// STACKED NOTES ARE ONE NOTE. Two notes of one pitch sounding over each other — a
// doubled detection, a paste onto itself — are one string struck once, and nothing
// that plays the lane can do anything else with them: they would need a string each.
// The editor keeps them and badges the stack (note-issues.js stackClusters, same test); everything
// downstream sees the longest of each stack and nothing of the rest. It lives in
// chordColumns because every reader of a lane comes through here — the voicer, the
// neck, the tab and both exports — so none of them can forget.
export function unstacked(notes) {
  const byPitch = new Map();
  for (const n of notes) (byPitch.get(n.pitch) || byPitch.set(n.pitch, []).get(n.pitch)).push(n);
  let lost = null;
  for (const same of byPitch.values()) {
    if (same.length < 2) continue;
    same.sort((a, b) => a.start - b.start);
    for (let i = 0; i < same.length;) {
      let j = i + 1, end = same[i].end, keep = same[i];
      // Two strings tuned alike (a 12-string's unisons) sound one pitch twice: placed on
      // different strings, they are two notes, not one struck twice.
      const apart = (m) => Number.isInteger(keep.pos?.string) && Number.isInteger(m.pos?.string) && m.pos.string !== keep.pos.string;
      while (j < same.length && same[j].start < end - OVERLAP_EPS && !apart(same[j])) {
        if (same[j].end - same[j].start > keep.end - keep.start) keep = same[j];
        end = Math.max(end, same[j].end); j++;
      }
      for (let k = i; k < j; k++) if (same[k] !== keep) (lost ||= new Set()).add(same[k]);
      i = j;
    }
  }
  return lost ? notes.filter((n) => !lost.has(n)) : notes;
}

export function chordColumns(notes, cap = Infinity) {
  const sorted = [...unstacked(notes)].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const cols = [];
  for (const n of sorted) {
    const last = cols[cols.length - 1];
    // A chord's notes sound together: one that has ended when this starts (a grace
    // note before its beat, a fast run) is a step before it, however close.
    if (last && n.start - last.t0 <= CHORD_GAP && last.notes.every((m) => m.end > n.start + OVERLAP_EPS)) last.notes.push(n);
    else if (cols.length < cap) cols.push({ t0: n.start, notes: [n] });
  }
  return cols;
}

// The onset columns still sounding at `t`, low to high by their top pitch. A held
// note under a moving line is two columns here, not one chord.
export function soundingColumns(notes, t) {
  const top = (c) => Math.max(...c.notes.map((n) => n.pitch));
  return chordColumns(notes)
    .filter((c) => c.t0 <= t && c.notes.some((n) => n.end > t))
    .sort((a, b) => top(a) - top(b));
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
// Only these two kinds link to a following note ("in"/"out" slides do not):
// SLIDE_TO_NEXT, imported from bend.js, which plays and draws them.

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

// Notes joined by a fretted slide share one finger, whichever end is edited.
// Open-string landings and slides in/out do not join finger assignments.
export function slideFingerGroup(notes, note, positionOf = n => n.pos) {
  const columns = chordColumns(notes), links = new Map();
  const link = (a, b) => {
    if (!links.has(a)) links.set(a, new Set());
    links.get(a).add(b);
  };
  for (let i = 0; i + 1 < columns.length; i++) {
    for (const from of columns[i].notes) {
      const source = positionOf(from);
      if (!SLIDE_TO_NEXT.has(from.slide) || !(source?.fret > 0)) continue;
      for (const to of columns[i + 1].notes) {
        const target = positionOf(to);
        if (!(target?.fret > 0) || target.string !== source.string) continue;
        link(from, to); link(to, from);
      }
    }
  }
  const group = new Set([note]);
  for (const member of group) for (const next of links.get(member) || []) group.add(next);
  return [...group];
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

// A finger may cover several strings at one fret (a barre), but only when
// every string across that span that is played is played at the same or a higher
// fret. A string the chord leaves out may lie under it (pressed, not picked, like
// EOF's F7 1x1211); muted, open and lower-fretted strings break it. A higher finger can cover a
// lower barre. With at most six strings, a tiny bitmask search enumerates every
// physically valid barre/separate-fingertip partition rather than assuming that
// every equal-fret note must share one finger.
const noteIsDead = (note) => !!note?.fx?.dead;
// Which notes of a shape the hand need not hold. A muted note beside sounding ones
// is the hand resting where it is (a scratch), so it is not a reach. A chord muted
// as a whole is still the grip, laid on the strings, so it has to be holdable.
const looseIn = (shape) => ([...shape.keys()].some((n) => !noteIsDead(n)) ? noteIsDead : () => false);

function groupsAtEachFret(shape) {
  const present = [...shape.values()];
  const loose = looseIn(shape);
  // A chord muted whole is held like the chord, so a barre may lie across its
  // muted strings: barreSpanSupported reads a dead note as a gap otherwise.
  const entries = [...shape.entries()].map(([note, p]) => ({ note, ...p })).filter((e) => !loose(e.note));
  const support = loose === noteIsDead ? entries
    : entries.map((e) => (e.note?.fx?.dead ? { ...e, note: { ...e.note, fx: { ...e.note.fx, dead: false } } } : e));
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
      const coversAllContacts = same.every(e => e.string < loS || e.string > hiS || members.includes(e));
      if (coversAllContacts && (members.length === 1 || barreSpanSupported(support, fret, loS, hiS, present))) valid.push({ mask, members });
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
// valid grouping, while the scorer considers every grouping and fingering.
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
// requires, and taking the cheapest. Everything
// here is per-shape; nothing knows about neighbours yet.
// ============================================================================

function stringStates(shape, fingering, profile = GUITAR_HAND_PROFILE) {
  const entries = [...shape].map(([note, p]) => ({ note, ...p, finger: fingering?.fingers.get(note) ?? NO_FINGER }));
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
    const muter = internal ? entries.find((e) => e.fret > 0 && e.finger >= THUMB && Math.abs(e.string - string) === 1) : null;
    if (muter) states.push({ string, state: "mute-left", method: "finger-overhang", finger: muter.finger });
    else states.push({ string, state: "skip-right", method: internal ? (explicitStroke ? "selective-strum" : "selective-pick") : "outside-attack" });
  }
  return states;
}

// Conservative defaults for ordinary playing, not anatomical limits. Each row
// is [maximum fret difference, maximum longitudinal mm, lateral comfort mm].
// Inspired by Radicioni/Lombardo's pair constraints; middle/ring is deliberately
// allowed one fret (their zero would reject the conventional open C fingering).
// Index/middle spans two frets at the nut (A-shape barre 1-2-3-4) and index/ring
// the E-shape's ring finger two frets over a barre.
const FINGER_REACH = Object.freeze({
  '1:2': [2, 75, 20], '1:3': [3, 90, 30], '1:4': [4, 105, 40],
  '2:3': [1, 38, 18], '2:4': [3, 75, 32], '3:4': [1, 38, 16],
});
const pairKey = (a, b) => [a.finger, b.finger].sort((x, y) => x - y).join(':');
const stringGap = (a, b) => {
  const aa = a.members.map(e => e.string), bb = b.members.map(e => e.string);
  // A finger over a barre need not reach across the whole barre.
  return Math.max(0, Math.min(...aa) - Math.max(...bb), Math.min(...bb) - Math.max(...aa));
};

// Also exposed for callers inspecting lateral tension in isolation.
export function fingerSplayCost(a, b, profile = GUITAR_HAND_PROFILE) {
  const reach = FINGER_REACH[pairKey(a, b)];
  if (!reach) return 0;
  return Math.max(0, stringGap(a, b) * profile.stringSpacingMm / reach[2] - 1) ** 2;
}

function gripParts(shape, fingering, profile) {
  const stretch = profile.reach || 1;
  const groups = fingering.groups;
  const parts = { fingers: groups.reduce((sum, g) => sum + 0.25 + 0.1 * (g.finger - 1), 0), stretch: 0, barre: 0, control: 0 };
  for (const g of groups) {
    g.string = g.members.reduce((sum, e) => sum + e.string, 0) / g.members.length;
    g.barreSpan = Math.max(...g.members.map(e => e.string)) - Math.min(...g.members.map(e => e.string)) + 1;
    if (g.members.length > 1) {
      if (g.barreSpan > MAX_BARRE_SPAN_BY_FINGER[g.finger]) return null;
      parts.barre += 0.8 * g.finger + 0.05 * (g.barreSpan - 1);
    }
  }
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    const a = groups[i], b = groups[j];
    if ((a.fret - b.fret) * (a.finger - b.finger) < 0) return null;
    if (a.fret === b.fret && (a.finger - b.finger) * (a.string - b.string) > 0) {
      // Keep the ordinary tucked index of open A, but no crossed fingers over
      // a planted index or threading another fingertip through a barre.
      if (a.members.length > 1 || b.members.length > 1 ||
          (Math.min(a.finger, b.finger) > 1 && groups.some(g => g.finger === 1 && g.fret < a.fret))) return null;
      parts.control += stringGap(a, b);
    }
    const [frets, mm, across] = FINGER_REACH[pairKey(a, b)].map(limit => limit * stretch);
    if (Math.abs(a.fret - b.fret) > frets) return null;
    // Length and width share one reach budget. A barre leaves less freedom
    // to stretch; a wide split cannot hide behind individually legal axes.
    const barre = a.members.length > 1 || b.members.length > 1;
    const along = Math.abs(fretXmm(a.fret, profile) - fretXmm(b.fret, profile)) / (mm * (barre ? 0.85 : 1));
    const sideways = stringGap(a, b) * profile.stringSpacingMm / (2 * across);
    const reach = Math.hypot(along, sideways);
    if (reach > 1) return null;
    // Millimetres decide what a hand can reach at all; which finger takes a note
    // follows one finger per fret, anywhere on the neck (as EOF's chord shapes
    // do): each fret a pair spreads beyond its finger distance costs.
    parts.stretch = Math.max(parts.stretch, SPREAD_COST * Math.max(0, Math.abs(a.fret - b.fret) - Math.abs(a.finger - b.finger)));
    // Higher fingers reaching bass-ward of a planted outer finger are awkward.
    const low = a.finger < b.finger ? a : b, high = low === a ? b : a;
    parts.control += Math.max(0, high.string - low.string) * (low.finger - 1) * 0.25;
  }
  if (groups.length === 1 && Number.isFinite(fingering.seat)) {
    const g = groups[0], distance = g.fret - fingering.seat;
    if (distance < 0 || distance > g.finger ||
        fretXmm(g.fret, profile) - fretXmm(fingering.seat, profile) > MAX_HAND_SPAN_MM * stretch) return null;
    parts.stretch += 0.5 * Math.abs(distance - (g.finger - 1));
  }
  const stroke = [...shape.keys()].some(n => !!n.stroke);
  for (const state of stringStates(shape, fingering, profile)) {
    if (state.state === 'mute-left') parts.control += 0.5;
    if (state.state === 'skip-right' && state.method !== 'outside-attack') parts.control += stroke ? 1.5 : 0.75;
  }
  return parts;
}

const FINGERING_CACHE = new WeakMap();
const MAX_FINGERINGS_PER_SHAPE = 12;

export function fingeringOptions(shape, profile = GUITAR_HAND_PROFILE) {
  let byProfile = FINGERING_CACHE.get(shape);
  if (!byProfile) { byProfile = new Map(); FINGERING_CACHE.set(shape, byProfile); }
  let base = byProfile.get(profile.id);
  if (!base) {
    const openFingers = new Map([...shape].filter(([, p]) => p.fret === 0).map(([note]) => [note, NO_FINGER]));
    const candidates = [];
    for (const grouping of fingerGroupings(shape)) {
      const used = new Set(), assigned = [];
      (function assign(i) {
        if (i === grouping.length) {
          const fingers = new Map(openFingers);
          const groups = grouping.map((g, k) => ({ ...g, finger: assigned[k], members: g.members.map((e) => ({ ...e })) }));
          for (const g of groups) for (const e of g.members) fingers.set(e.note, g.finger);
          const bases = groups.map((g) => g.fret - (g.finger - 1)).sort((a, b) => a - b);
          const rawSeat = bases.length ? Math.round(bases[(bases.length - 1) >> 1]) : null;
          // Do not invent a hand position behind the nut for a single contact.
          // Chords can bunch their fingers, so only lone contacts use this rule.
          if (rawSeat !== null && rawSeat < 1 && groups.length === 1) return;
          const index = groups.find(group => group.finger === 1);
          const seat = index ? index.fret : rawSeat === null ? null : Math.max(1, rawSeat);
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
    base.all = candidates;   // every valid fingering, for the Finger buttons
    byProfile.set(profile.id, base);
  }
  return base;
}

export function gripCostBreakdown(shape, profile = GUITAR_HAND_PROFILE) {
  const best = fingeringOptions(shape, profile)[0];
  return best ? { total: best.cost, parts: best.parts, fingering: best } : { total: Infinity, parts: {}, fingering: null };
}

const hasPlayableFingering = (shape, profile = GUITAR_HAND_PROFILE) => fingeringOptions(shape, profile).length > 0;

// A SLIDE-IN IS FINGERED WHERE IT STARTS. The finger goes down on the start fret
// and the hand travels with it to the landing, so the finger is chosen for the
// start: B3→D#4 on the G string is the index on fret 4 sliding to 8, not a pinky
// stretched to fret 8 from a hand at 4 (which would have to start on fret 4 with
// the pinky, under the index). The seat returned is still the landing's.
// Only when every fretted note slides in by the same amount (a whole grip sliding in).
function slideInOffset(shape) {
  const fretted = [...shape].filter(([, pos]) => pos.fret > 0);
  const offsets = new Set(fretted.map(([note, pos]) => slideInOf(note) ? edgeSlideSpan(note, pos.fret, slideInOf(note)) : 0));
  return offsets.size === 1 ? [...offsets][0] : 0;
}

// Select the fingers AND their anchor from one physical pose. The passage's
// register is context, not an independent index position. For a chord its pull
// is bounded so it cannot buy an unnecessarily split barre to save a shift.
export function handForShape(shape, seat, profile = GUITAR_HAND_PROFILE, required = new Map(), fixedSeat = false) {
  const into = slideInOffset(shape);
  if (into) {
    const start = new Map([...shape].map(([note, pos]) => [note, pos.fret > 0 ? { ...pos, fret: pos.fret + into } : pos]));
    const hand = handAtStart(start, seat == null ? seat : seat + into, profile, required, fixedSeat);
    return { ...hand, seat: hand.seat == null ? hand.seat : hand.seat - into };
  }
  return handAtStart(shape, seat, profile, required, fixedSeat);
}

function handAtStart(shape, seat, profile, required, fixedSeat) {
  const loose = looseIn(shape), contacts = [...shape].filter(([note, pos]) => pos.fret > 0 && !loose(note));
  // ONE FRETTED NOTE: the finger is where the hand puts it (fret − hand + 1, the
  // pinky for a stretch), so any hand within reach plays it and the index is on it
  // when the hand is on its fret. Out of reach, the hand comes to the note.
  if (contacts.length === 1) {
    const [note, pos] = contacts[0];
    const reached = Number.isFinite(seat) && seat >= 1 && pos.fret - seat >= 0;
    // A finger asked for (the same slide played before) puts the hand under it,
    // unless the player fixed the hand.
    const asked = required.get(note);
    const at = fixedSeat && reached ? seat : asked >= 1 && pos.fret - asked + 1 >= 1 ? pos.fret - asked + 1 : reached ? seat : pos.fret;
    const fingers = new Map([...shape].filter(([, p]) => p.fret === 0).map(([n]) => [n, NO_FINGER]));
    fingers.set(note, Math.min(4, pos.fret - at + 1));
    return { fingers, seat: at, playable: true };
  }
  // A chord only the widest hands reach still has a hand and fingers; a chosen
  // fingering may be any valid one, not only the few kept for the search.
  let poses = required.size ? posesFor(shape, profile, required) : fingeringOptions(shape, profile);
  if (!poses.length) poses = fingeringOptions(shape, stretchProfile(profile));
  const compatible = poses.filter(pose => [...required].every(([note, finger]) => pose.fingers.get(note) === finger));
  let choices = compatible.length ? compatible : poses;
  if (fixedSeat) {
    const atSeat = choices.filter(pose => pose.seat === seat);
    if (atSeat.length) choices = atSeat;
  }
  if (!choices.length) return { fingers: assignFingers(shape, profile), seat: null, playable: false };
  const fretted = contacts.length;
  const cost = pose => {
    if (!Number.isFinite(seat) || pose.seat == null) return pose.cost;
    const travel = fretTravelUnits(seat, pose.seat, profile);
    return pose.cost + (fretted > 1 ? Math.min(COST_W.plan, travel * COST_W.plan) : travel * COST_W.mfret);
  };
  const chosen = choices.reduce((best, pose) => cost(pose) < cost(best) ? pose : best);
  return { fingers: new Map(chosen.fingers), seat: chosen.seat ?? seat ?? null, playable: true };
}

// THE THUMB, only ever chosen (fingeringChoices), never picked by the engine. It
// frets the instrument's lowest string over the neck, on the fret of the lowest
// other fretted note, with the next string left out (its tip mutes it): EOF's
// thumb shapes, D/F# 2x0232 and the E-shape 1x3211. The other notes are fingered
// as usual, and the hand is theirs.
function thumbPoses(shape, profile = GUITAR_HAND_PROFILE) {
  const loose = looseIn(shape), fretted = [...shape].filter(([note, p]) => p.fret > 0 && !loose(note));
  const low = fretted.find(([, p]) => p.string === profile.stringCount - 1);
  if (!low || fretted.length < 2 || [...shape.values()].some((p) => p.string === profile.stringCount - 2)) return [];
  const rest = new Map([...shape].filter(([note]) => note !== low[0]));
  if (low[1].fret !== Math.min(...fretted.filter((f) => f !== low).map(([, p]) => p.fret))) return [];
  return fingeringOptions(rest, profile).all.map((pose) => ({
    ...pose, fingers: new Map([...pose.fingers, [low[0], THUMB]]) }));
}

// The fingerings that can hold `fingers`: the thumb's when one is the thumb.
function posesFor(shape, profile, fingers) {
  if ([...fingers.values()].includes(THUMB)) return thumbPoses(shape, profile);
  const poses = fingeringOptions(shape, profile).all;
  return poses.length ? poses : fingeringOptions(shape, stretchProfile(profile)).all;
}

// THE FINGERINGS ONE COLUMN CAN BE PLAYED WITH, as Map(note -> finger): what the
// fretboard's Finger buttons step through. One fretted note: each finger whose hand
// (fret − finger + 1) is on the neck. A chord: its valid fingerings, cheapest first.
export function fingeringChoices(shape, profile = GUITAR_HAND_PROFILE, maxHand = Infinity) {
  const loose = looseIn(shape), contacts = [...shape].filter(([note, pos]) => pos.fret > 0 && !loose(note));
  if (!contacts.length) return [];
  if (contacts.length === 1) {
    const [note, pos] = contacts[0];
    return [1, 2, 3, 4].filter((f) => pos.fret - f + 1 >= 1 && pos.fret - f + 1 <= maxHand).map((f) => new Map([[note, f]]));
  }
  let poses = fingeringOptions(shape, profile).all;
  if (!poses.length) poses = fingeringOptions(shape, stretchProfile(profile)).all;
  poses = [...poses, ...thumbPoses(shape, profile)];
  const seen = new Set(), out = [];
  for (const pose of poses) {
    const fingers = new Map(contacts.map(([note]) => [note, pose.fingers.get(note)]));
    const key = contacts.map(([note]) => fingers.get(note)).join(",");
    if (!seen.has(key) && pose.seat <= maxHand) { seen.add(key); out.push(fingers); }
  }
  return out;
}

function fingersAtSeat(shape, seat, profile = GUITAR_HAND_PROFILE, required = new Map()) {
  return handForShape(shape, seat, profile, required).fingers;
}

// Intrinsic difficulty of a single shape (lower = easier to fret): choose the
// cheapest feasible concrete fingering, then sum named ergonomic, string-control,
// and control contributions. Raw fret span is only a coarse
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
function handRange(shape) {
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
function handString(shape) {
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
function transitionCostBreakdown(prevShape, prevFingering, curShape, curFingering,
  profile = GUITAR_HAND_PROFILE, dt, refIoi) {
  return transitionResult(prevShape, prevFingering, curShape, curFingering, profile, dt, refIoi, true);
}

// Left-hand fingers (1=index … 4=pinky, -1 open) for a shape. Same-fret notes
// share a number only when fingerGroups proves that a real barre can connect
// them without overriding an open/lower note on an intervening string.
export function assignFingers(shape, profile = GUITAR_HAND_PROFILE) {
  const best = fingeringOptions(shape, profile)[0] || fingeringOptions(shape, stretchProfile(profile))[0];
  if (best) return new Map(best.fingers);
  // Imported/manual impossible shapes still render without inventing a fifth
  // finger. This fallback mirrors the old deterministic labelling.
  const fingers = new Map([...shape].filter(([, p]) => p.fret === 0).map(([note]) => [note, NO_FINGER]));
  fingerGroups(shape).forEach((group, i) => {
    for (const e of group.members) fingers.set(e.note, i < 4 ? i + 1 : NO_FINGER);
  });
  return fingers;
}

// The notes of a column whose own `pos` is still a real place for them: in range,
// sounding the note's pitch, and on a string no earlier note of the column took. A
// pin left stale by a later pitch edit simply lapses instead of corrupting the tab.
function pinnedPositions(notes, tuning) {
  const shape = new Map();
  const usedStrings = new Set();
  for (const n of notes) {
    const p = n.pos;
    if (!p || !Number.isInteger(p.string) || !Number.isInteger(p.fret)) continue;
    if (p.string < 0 || p.string >= tuning.length || p.fret < 0 || p.fret > MAX_FRET) continue;
    if (tuning[p.string] + p.fret !== n.pitch) continue;   // no longer this pitch
    if (usedStrings.has(p.string)) continue;               // two notes, one string
    usedStrings.add(p.string);
    shape.set(n, { string: p.string, fret: p.fret });
  }
  return shape;
}

// ONE POSITION PER NOTE. `note.pos` is where the note is played, whoever set it: the
// player, an import or an earlier solve (keepVoicing). The next solve takes it as
// given, so adding a note never moves the ones already there. Only notes without a
// position that still fits are placed. "Recalculate positions" clears it.
const fitsPitch = (p, pitch, tuning, maxFret = MAX_FRET) =>
  !!p && Number.isInteger(p.string) && Number.isInteger(p.fret) &&
  p.string >= 0 && p.string < tuning.length && p.fret >= 0 && p.fret <= maxFret &&
  tuning[p.string] + p.fret === pitch;

// A finger the player typed onto a note (note.finger): 0 the thumb, 1-4 index to pinky.
export const isChosenFinger = (f) => Number.isInteger(f) && f >= THUMB && f <= 4;

// Write a solve back as each placed note's position. `before` runs once, ahead of the
// first write. Returns whether any note changed.
export function keepVoicing(notes, { voiced }, tuning, before = null) {
  let changed = false;
  // What is stored is what is played: a note whose position lapsed or was overruled
  // (a reference plays its first occurrence's) takes the one it is played at.
  for (const n of notes) {
    const p = voiced.get(n);
    if (!p || (n.pos?.string === p.string && n.pos?.fret === p.fret && fitsPitch(n.pos, n.pitch, tuning))) continue;
    if (!changed) before?.();
    n.pos = { string: p.string, fret: p.fret };   // replaced, never edited: undo snapshots share the old object
    changed = true;
  }
  return changed;
}

// Frets count from the capo, so moving it keeps every note on its string and moves
// its fret by the difference. A pin that lands behind the capo is kept, not deleted:
// it lapses (pinnedPositions rejects a negative fret), the note is fingered like any
// other, and moving the capo back — Cancel does exactly that — restores it.
// Returns whether anything changed.
export function moveCapo(lane, capo) {
  const delta = capo - (Number(lane.capo) || 0);
  if (!delta) return false;
  lane.capo = capo;
  const shift = (p) => (Number.isInteger(p?.fret) ? { ...p, fret: p.fret - delta } : p);
  for (const note of lane.notes) {
    if (note.pos) note.pos = shift(note.pos);
    if (note.arrangement?.notes) note.arrangement = { ...note.arrangement, notes: note.arrangement.notes.map(shift) };
  }
  // Where the player put the hand moves with it, so it stays on the same wood.
  if (Array.isArray(lane.handHolds)) lane.handHolds = lane.handHolds.map((h) => ({ ...h, fret: h.fret - delta }));
  return true;
}

// A column is "locked" to an explicit voicing when EVERY note in it is pinned.
// Returns that pinned shape (Map note -> {string, fret}) or null. A column where
// only some notes are pinned is voiced around them — see `pinned` in registerColumns.
export function lockedShape(notes, tuning) {
  const shape = pinnedPositions(notes, tuning);
  return shape.size && shape.size === notes.length ? shape : null;
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
export function shapeFault(notes, tuning, shape, limits = null, maxFret = MAX_FRET) {
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
    // Not playability, which stays the player's call: what the note's own
    // technique makes impossible, the same test every offer on the neck passes.
    const wrong = placementFault(limits?.get(n), n.pitch, p.string, tuning, maxFret);
    if (wrong) return wrong;
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

export function enumerateShapes(notes, tuning, maxFret = MAX_FRET, pins = null, profile = handProfileForTuning(tuning)) {
  const cand = notes.map(note => ({
    note,
    options: fretOptions(note, tuning).filter(option => option.fret <= maxFret &&
      (!pins?.has(note) || pins.get(note).string === option.s && pins.get(note).fret === option.fret)),
  }));
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
export const outOfFretboardRange = (pitch, tuning, maxFret = MAX_FRET) =>
  pitch < Math.min(...tuning) || pitch > Math.max(...tuning) + maxFret;

// enumerateShapes always returns something — a greedy last resort with no
// playable fingering — so "these notes cannot be played together" is otherwise
// invisible to callers and reaches the UI as a shape smeared across the neck.
// This is the explicit test for it.
// "ok", "stretch" (only a big hand with practice reaches it) or "impossible".
export const chordPlayability = (notes, tuning, maxFret = MAX_FRET) => {
  if (notes.length > tuning.length || notes.some(n => outOfFretboardRange(n.pitch, tuning, maxFret))) return "impossible";
  const pins = pinnedPositions(notes, tuning);
  // A stored, sounding pin is part of the requested chord, including partial pins.
  const fits = (profile) => enumerateShapes(notes, tuning, maxFret, pins, profile).some(shape =>
    shape.size === notes.length && new Set([...shape.values()].map(p => p.string)).size === notes.length &&
    [...shape.values()].every(p => p.fret >= 0 && p.fret <= maxFret) &&
    [...pins].every(([note, p]) => shape.get(note)?.string === p.string && shape.get(note)?.fret === p.fret) &&
    hasPlayableFingering(shape, profile));
  const profile = handProfileForTuning(tuning);
  return fits(profile) ? "ok" : fits(stretchProfile(profile)) ? "stretch" : "impossible";
};

export const unplayableColumn = (notes, tuning, maxFret = MAX_FRET) => chordPlayability(notes, tuning, maxFret) !== "ok";

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
function contextShapes(pool, previous = [], next = [], cap = DP_SHAPES_PER_COL, profile = GUITAR_HAND_PROFILE) {
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
function contextualCandidateSets(columns, tuning, cap = DP_SHAPES_PER_COL, influences = null) {
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


// Every override guides later placements. Legacy Only here / Locked values
// normalize to Guided, so no hidden mode survives opening an older project.
export const FOLLOW_MODES = ["guided"];
export function normalizeOverrideInfluence() {
  return { follow: "guided" };
}

// The flags a pin nobody chose them for gets: an imported tab's positions.
export function defaultPinFlags() {
  return { ...normalizeOverrideInfluence() };
}

// How an existing override on these notes follows on, or how a new one would.
export function overrideFlow(notes) {
  const source = (notes || []).find((note) => note.arrangement)?.arrangement
    || (notes || []).find((note) => note.pos)?.pos;
  return normalizeOverrideInfluence(source);
}
export const overrideInfluence = overrideFlow;

// The ranked alternative shapes offered to the user for a column, ignoring any
// current pin (so they can always cycle back through the automatic options).
export function columnShapeChoices(notes, tuning, cap = SHAPES_PER_COL) {
  return rankShapes(enumerateShapes(notes, tuning), handProfileForTuning(tuning)).slice(0, cap);
}

// Build playable guitar realizations of a chord formula rather than preserving
// the source pitches. Used by the non-destructive "playable alternative" UI:
// every pitch class must occur at least once; extra strings duplicate tones.
function chordArrangementChoices(pcs, root, count, tuning, sourcePitches = [], cap = SHAPES_PER_COL) {
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
  const pin = (p) => ({ string: p.string, fret: p.fret, scope: "local", follow: flow.follow });
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

// Pin `note` at `pos`. A finger typed on the note was typed for where it was: one
// that moves to another string or fret drops it and is fingered for the new place.
export function placeNote(note, pos) {
  if (note.finger != null && note.pos && (note.pos.string !== pos.string || note.pos.fret !== pos.fret)) delete note.finger;
  note.pos = pos;
}

// Apply `choice` to one column of `laneNotes`, which means rewriting the column
// to what the shape actually plays: voices it drops leave the lane, pitches it
// adds arrive as real notes, and every survivor is pinned to its string/fret.
// A null choice clears positions so the current notes can be placed again.
//
// Returns { notes, column } — the lane's new note array and the column's new
// notes. Pure: no undo, no redraw, no selection, nothing outside the notes.
// `mintId` comes from the caller because note ids are drawn from app state, which
// this module deliberately cannot see; a preview copy needs none.
export function writeColumnOverride(laneNotes, columnNotes, choice, flow, mintId = null) {
  const result = rewriteColumn(laneNotes, columnNotes, choice, flow, mintId);
  keepColumnShape(columnNotes, result.column);
  return result;
}

// A rewritten column stays in the arpeggio or handshape it was in (web/shapes.js):
// notes it adds join it. A column split across shapes keeps each note's own.
function keepColumnShape(before, after) {
  const first = before[0];
  const shared = first?.shapeId && before.every((n) => n.shapeId === first.shapeId)
    ? [first.shapeId, first.shapeKind, before.find((n) => n.shapeName)?.shapeName] : null;
  const own = new Map(before.map((n) => [n.id, [n.shapeId, n.shapeKind, n.shapeName]]));
  for (const note of after) {
    const [id, kind, name] = shared || own.get(note.id) || [];
    delete note.shapeId; delete note.shapeKind; delete note.shapeName;
    if (id) { note.shapeId = id; note.shapeKind = kind; if (name) note.shapeName = name; }
  }
}

function rewriteColumn(laneNotes, columnNotes, choice, flow, mintId) {
  if (!choice) {
    for (const n of columnNotes) { delete n.pos; delete n.arrangement; delete n.written; }
    return { notes: laneNotes, column: columnNotes };
  }
  const { keep, add, drop } = columnRewritePlan(columnNotes, choice, flow);
  for (const { note, pos } of keep) {
    if (pos) placeNote(note, pos); else delete note.pos;
    delete note.arrangement;   // a legacy arrangement on this column is now spelled out in notes
    delete note.written;
  }
  if (!add.length && !drop.length) return { notes: laneNotes, column: keep.map((k) => k.note) };
  // Added notes take the column's own extent — the same bar the hover preview
  // ghosts, so what you previewed is what lands.
  const start = Math.min(...columnNotes.map((n) => n.start));
  const end = Math.max(...columnNotes.map((n) => n.end));
  const stroke = columnNotes.find((n) => n.stroke)?.stroke;
  const born = add.map(({ pitch, pos }) => ({
    ...(mintId ? { id: mintId() } : {}), start, end, pitch, pos,
    ...(stroke ? { stroke } : {}),
  }));
  const dropped = new Set(drop);
  return {
    notes: [...laneNotes.filter((n) => !dropped.has(n)), ...born],
    column: [...keep.map((k) => k.note), ...born].sort((a, b) => a.pitch - b.pitch),
  };
}

// Opening any project keeps its current notes and positions, never an earlier
// chord snapshot. Old overlays become ordinary notes once, before the first solve.
export function loadNotePositions(savedNotes) {
  let notes = (savedNotes || []).map(({ source, auto, written, ...note }) => {
    const pos = note.pos || (Number.isInteger(auto?.string) && Number.isInteger(auto?.fret) ? auto : null);
    if (pos) note.pos = { ...pos, ...normalizeOverrideInfluence(pos) };
    return note;
  });
  if (!notes.some(n => n.arrangement)) return notes;
  const ids = new Set(notes.map(n => n.id));
  let next = 1;
  const mintId = () => {
    while (ids.has(`loaded_note_${next}`)) next++;
    const id = `loaded_note_${next++}`;
    ids.add(id);
    return id;
  };
  for (const column of chordColumns(notes)) {
    const arrangement = column.notes.find(n => n.arrangement)?.arrangement;
    if (!Array.isArray(arrangement?.notes) || !arrangement.notes.length) continue;
    const voices = arrangement.notes;
    const choice = { notes: voices, shape: new Map(voices.map(n => [n, { string: n.string, fret: n.fret }])) };
    const start = Math.min(...column.notes.map(n => n.start));
    const end = Math.max(...column.notes.map(n => n.end));
    const result = writeColumnOverride(notes, column.notes, choice, normalizeOverrideInfluence(arrangement), mintId);
    // Legacy overlays played every voice for the whole column (arrangedNotes),
    // even when a matching source note had a shorter duration or a later onset.
    for (const note of result.column) { note.start = start; note.end = end; }
    notes = result.notes;
  }
  for (const note of notes) delete note.arrangement;
  return notes;
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
      pos: { string: a.string, fret: a.fret, scope: "local", follow: influence.follow },
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
      else added.push({ pitch: note.pitch, start, end, pos: { string: note.string, fret: note.fret } });
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
  // A slide-in starts on a pitch you hear (B3 into D#4), fretted and slid up, so its
  // whole span has to fit on the string: D#4 on the B string would start on the open
  // string. A slide-out only has to go somewhere; a shorter one is ordinary playing
  // and imported tabs have them low on the neck.
  const into = slideInOf(note), out = SLIDE_OUT.has(note.slide) ? note.slide : null;
  if (into || out) rule.edge = (fret) => fret > 0
    && ((into && slideReach(into, fret) < edgeSlideFrets(note, into)) || (out && slideReach(out, fret) === 0));
  if (SLIDE_TO_NEXT.has(note.slide)) { rule.link = note.slide === "legato" ? "fretted" : "any"; rule.slide = true; }
  // "any" and not "fretted": a pull-off onto an open string is ordinary playing.
  else if (hammerOrigin(note) && next.some(hammerDest)) rule.link = "any";
  return Object.keys(rule).length ? rule : null;
}

// WHERE A NOTE'S TECHNIQUE LETS IT BE PUT BY HAND. The voicer has always kept these
// rules for itself (placeInHand); the neck's offers did
// not, so a slid note was offered its open string and a slide's target a string the
// slide does not run along. Every offer the board makes — a ring, a box, a step of
// the shape walk — asks here first, off the same effectRule the voicer reads, so a
// technique added there is kept here without a second list.
//
//   fretted  not on an open string
//   reach    this many frets above it are still on the neck (a trill's upper note)
//   onto     the note it slides or hammers INTO must be able to follow on the string:
//            reachable there, fretted for a legato slide, and where that column is
//            already pinned, actually pinned to it
//   from     the string the note before it slides or hammers in on. A target has one
//            place; move the note it comes from and it follows.
//
// `positionOf(note)` is where the lane is voiced now, which is what says which
// string an incoming slide is on.
export function placementLimits(columns, index, tuning, positionOf, maxFret = MAX_FRET) {
  const limits = new Map();
  const col = columns[index], prev = columns[index - 1], next = columns[index + 1];
  if (!col) return limits;
  const after = next ? next.notes : [];
  const held = next && lockedShape(next.notes, tuning);
  for (const note of col.notes) {
    const rule = effectRule(note, after) || {};
    limits.set(note, {
      fretted: !!rule.fretted, reach: rule.reach || 0, from: null, edge: rule.edge || null,
      onto: rule.link && after.length ? {
        fretted: rule.link === "fretted", pitches: after.map((n) => n.pitch),
        strings: held ? new Set([...held.values()].map((p) => p.string)) : null,
        positions: held ? [...held.values()] : null,
      } : null,
    });
  }
  // The same hand-off voiceRegister makes: lowest note first, each linked note
  // claiming the first note of this column its string can sound.
  const low = (notes) => [...notes].sort((a, b) => a.pitch - b.pitch);
  const claimed = new Set();
  for (const source of prev ? low(prev.notes) : []) {
    const link = effectRule(source, col.notes)?.link;
    const at = link ? positionOf(source) : null;
    if (!at) continue;
    for (const target of low(col.notes)) {
      const fret = target.pitch - tuning[at.string];
      if (claimed.has(target) || fret < 0 || fret > maxFret || (link === "fretted" && fret === 0)) continue;
      claimed.add(target); limits.get(target).from = at.string;
      break;
    }
  }
  return limits;
}

// null when `string` is somewhere the note may go, or the sentence saying why not.
export function placementFault(limit, pitch, string, tuning, maxFret = MAX_FRET) {
  if (!limit) return null;
  const fret = pitch - tuning[string], name = noteName(pitch);
  if (limit.fretted && fret === 0) return `${name} carries a technique an open string cannot play`;
  if (fret + limit.reach > maxFret) return `${name} trills past the last fret there`;
  if (limit.edge?.(fret)) return `${name} slides in or out, and the slide does not fit on that string`;
  if (limit.from != null && limit.from !== string)
    return `${name} is slid or hammered onto, so it stays on the string it comes from`;
  const onto = limit.onto;
  if (onto && !(onto.positions ? onto.positions.some(p => p.string === string
    && p.fret >= (onto.fretted ? 1 : 0) && p.fret <= maxFret) : onto.pitches.some(p => {
    const fret = p - tuning[string];
    return fret >= (onto.fretted ? 1 : 0) && fret <= maxFret;
  }))) return `${name} slides or hammers into a note that cannot follow on that string`;
  return null;
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
function holdsByColumn(columns, holds, changes = false) {
  const out = new Array(columns.length).fill(null);
  for (const h of Array.isArray(holds) ? holds : []) {
    const t = Number(h?.t), fret = Number(h?.fret);
    // At or behind the capo (moveCapo shifted it there) a hold has lapsed, like a pin.
    if (!Number.isFinite(t) || !Number.isFinite(fret) || fret < 1) continue;
    const i = columns.findIndex((c) => Number(c.t0) >= t - 1e-6);
    if (i >= 0 && out[i] == null) out[i] = { fret };
  }
  if (changes) {
    let active = null;
    for (let i = 0; i < out.length; i++) { active = out[i] || active; out[i] = active; }
  }
  return out;
}

// ARPEGGIOS AND HANDSHAPES ARE ONE GRIP (web/shapes.js). The player holds one chord
// shape and picks its notes, so every note of a shape the user marked is played from
// that grip: one fret per string, all of it under one hand, and the hand still while
// it lasts. Never inferred: only notes the user marked are voiced this way.
//
// The grip is chosen against what the lane would play without it: first the walk
// as it is, then, among the playable grips of the shape's pitches (a note pinned by
// the player keeps its pin), the one that moves the fewest notes from there, then the
// cheapest. Its notes are then handed to the walk as pinned, with the grip's own
// fingers and hand, so the hand plan and everything around the shape are worked
// out against the grip. A shape whose pitches no single grip holds is voiced as
// usual, and the export says so at the shape.
//
// Returns Map(note -> { string, fret, finger, seat }) or null when there is none.
// The grips one shape could be held with, keeping its notes' positions (`withPins`)
// or not. One note per pitch stands for all its repeats: a repeated pitch is the
// same finger on the same fret.
function gripCandidates(members, tuning, frets, profile, withPins) {
  const reps = new Map();
  for (const n of members) if (!reps.has(n.pitch)) reps.set(n.pitch, n);
  const voices = [...reps.values()];
  if (voices.length > tuning.length) return { reps, candidates: [] };
  const pins = new Map();
  if (withPins) for (const n of members) {
    const pin = pinnedPositions([n], tuning).get(n), voice = reps.get(n.pitch);
    if (pin && !pins.has(voice)) pins.set(voice, pin);
  }
  const fretted = new Set(members.filter(needsFret).map((n) => n.pitch));
  const candidates = enumerateShapes(voices, tuning, frets, pins, profile).filter((grip) =>
    grip.size === voices.length
    && new Set([...grip.values()].map((p) => p.string)).size === voices.length
    && [...grip].every(([voice, p]) => p.fret <= frets && !(p.fret === 0 && fretted.has(voice.pitch)))
    && hasPlayableFingering(grip, profile)
    // Every position is kept: a grip that moves one is no grip for these notes.
    && [...pins].every(([voice, p]) => grip.get(voice)?.string === p.string && grip.get(voice)?.fret === p.fret));
  return { reps, candidates };
}

// Why a shape's notes, where they are now, are not one grip although another place
// for them would be; null when they are one, or when no grip holds these pitches at
// all (the export says so). Positions are kept, so the player is told instead.
export function shapeGripFault(members, tuning, frets = MAX_FRET) {
  const profile = handProfileForTuning(tuning);
  if (gripCandidates(members, tuning, frets, profile, true).candidates.length) return null;
  if (!gripCandidates(members, tuning, frets, profile, false).candidates.length) return null;
  const placed = members.filter((n) => fitsPitch(n.pos, n.pitch, tuning, frets));
  const open = (s) => noteName(tuning[s]).replace(/-?\d+$/, "");
  for (const a of placed) for (const b of placed) {
    if (a.pitch < b.pitch && a.pos.string === b.pos.string)
      return `${noteName(a.pitch)} and ${noteName(b.pitch)} are both on the ${open(a.pos.string)} string, so one grip cannot hold both`;
  }
  const bad = placed.find((n) => n.pos.fret === 0 && needsFret(n));
  if (bad) return `${noteName(bad.pitch)} is on an open string, but its technique needs a fret`;
  const fretsUsed = placed.map((n) => n.pos.fret).filter((f) => f > 0);
  return fretsUsed.length
    ? `Its notes span frets ${Math.min(...fretsUsed)} to ${Math.max(...fretsUsed)}, too far apart for one hand`
    : "Its notes cannot be held as one grip where they are";
}

function shapeGrips(columns, tuning, options) {
  const groups = new Map();
  for (const { notes } of columns) for (const n of notes) {
    if (!n.shapeId || (n.shapeKind !== "arpeggio" && n.shapeKind !== "handshape")) continue;
    if (!groups.has(n.shapeId)) groups.set(n.shapeId, []);
    groups.get(n.shapeId).push(n);
  }
  for (const [id, members] of groups) if (members.length < 2) groups.delete(id);
  if (!groups.size) return null;

  // The lane as it would be played without grips: what the grips are measured against.
  const { priceAt, priced, hands: _, grips: __, ...plain } = options;
  const firstHands = [];
  const first = registerColumns(columns, tuning, { ...plain, hands: firstHands });
  const placed = new Map(), seatOf = new Map();
  first.forEach((shape, i) => shape?.forEach((pos, note) => {
    placed.set(note, pos);
    if (Number.isFinite(firstHands[i]?.seat)) seatOf.set(note, firstHands[i].seat);
  }));

  const frets = fretboardFor(options.instrument).frets - (Number(options.capo) || 0);
  const profile = handProfileForTuning(tuning);
  const grips = new Map();
  for (const members of groups.values()) {
    const { reps, candidates } = gripCandidates(members, tuning, frets, profile, true);
    if (!candidates.length) continue;
    const moved = (grip) => members.filter((n) => {
      const was = placed.get(n), now = grip.get(reps.get(n.pitch));
      return !was || was.string !== now.string || was.fret !== now.fret;
    }).length;
    const ranked = candidates.map((grip) => ({ grip, moved: moved(grip), cost: shapeCost(grip, profile) }))
      .sort((a, b) => a.moved - b.moved || a.cost - b.cost);
    const grip = ranked[0].grip;
    const hand = handForShape(grip, seatOf.get(members[0]), profile);
    for (const n of members) {
      const voice = reps.get(n.pitch), p = grip.get(voice);
      const finger = hand.playable ? hand.fingers.get(voice) : undefined;
      grips.set(n, { string: p.string, fret: p.fret,
        ...(Number.isInteger(finger) && finger >= THUMB ? { finger } : {}),
        ...(hand.playable && Number.isFinite(hand.seat) ? { seat: hand.seat } : {}) });
    }
  }
  return grips.size ? grips : null;
}

function registerColumns(columns, tuning, options = {}) {
  const order = tuning.map((_, i) => i).sort((a, b) => tuning[a] - tuning[b]);
  const low = order.map((i) => tuning[i]);
  const seat = new Map(order.map((appIndex, leanIndex) => [appIndex, leanIndex]));

  const holds = holdsByColumn(columns, options.anchorChanges ? handAnchorsInForce(columns, options.holds) : options.holds, options.anchorChanges);
  const frets = fretboardFor(options.instrument).frets - (Number(options.capo) || 0);
  // A column that is all inside arpeggios or handshapes is pinned to their grip
  // (shapeGrips), which keeps any position its notes have.
  const grips = options.grips || null;
  const userPins = columns.map(({ notes }) => lockedShape(notes, tuning));
  const gripped = columns.map(({ notes }) => grips && notes.every((n) => grips.has(n))
    ? new Map(notes.map((n) => [n, { string: grips.get(n).string, fret: grips.get(n).fret }])) : null);
  const pins = columns.map((_, i) => gripped[i] || userPins[i]);
  const allRules = columns.map(({ notes }, i) => notes.map((n) => effectRule(n, columns[i + 1] ? columns[i + 1].notes : [])));
  const input = columns.map(({ notes, t0 }, i) => {
    const rules = allRules[i];
    // Some notes pinned and some not (a note added to an imported chord): the pinned
    // ones keep their strings exactly and only the rest are placed, around them.
    const some = pins[i] ? null : pinnedPositions(notes, tuning);
    const partial = some && some.size ? some : null;
    const authored = pins[i];
    const locked = authored;
    const chosen = authored ? chosenFingers(notes, notes) : new Map();
    // The grip's fingers, where the player chose none: one hand for the whole shape.
    if (gripped[i]) for (const n of notes) {
      const g = grips.get(n);
      if (!chosen.has(n) && Number.isInteger(g.finger) && notes.length > 1) chosen.set(n, g.finger);
    }
    return {
      // The hand change in force here: the planner keeps the hand on it while the notes
      // allow. Placed notes stay put; explicit fingers that disagree are reported later.
      anchor: holds[i]?.fret ?? null,
      fingers: chosen,
      pitches: notes.map((n) => n.pitch),
      // Onset and release: a shift is cheaper across a rest or after a long note.
      t0,
      end: notes.reduce((t, n) => Math.max(t, Number(n.end) || t0 || 0), t0 || 0),
      // A placed column keeps its strings even against its notes' technique.
      fixed: locked ? notes.map((n) => seat.get(locked.get(n).string)) : null,
      pinned: partial ? notes.map((n) => partial.has(n) ? seat.get(partial.get(n).string) : null) : null,
      rules,
      // Muted notes are not held by the hand. A chord muted whole is held like the chord.
      dead: notes.some((n) => n.fx?.dead) && !notes.every((n) => n.fx?.dead) ? notes.map((n) => !!n.fx?.dead) : null,
    };
  });

  // The planner decides strings and frets with a hand per column; handForShape then
  // picks the actual finger contacts and index fret. It also prices the fretboard's
  // other positions for one column (`price`), so the board's offers and the hand
  // agree; without it `Show other positions` drew nothing.
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
  const fingerMemory = new Map();   // grip -> string -> finger, in time order (see the hands below)
  const voiced = voiceRegister(low, input, undefined, seats, frets, price);
  // One entry per offered shape, in order: that is the contract scoreShapesAsDecided
  // reads back. `fingers` is empty because the engine has none to give — the board falls
  // back to assignFingers, which is the same function the exported tab asks.
  if (price) for (const got of price.out) sink.push({ ...(got || { cost: Infinity, seat: null }), fingers: [] });
  return voiced.map((placed, i) => {
    const shape = new Map();
    columns[i].notes.forEach((note, k) => {
      const p = placed[k];
      // -1 is the engine saying the instrument cannot reach this note. Leaving it out of
      // the shape is what the full engine's unplaceable notes already do.
      if (p.string < 0) return;
      shape.set(note, { string: order[p.string], fret: p.fret });
    });
    if (options.hands) {
      // The fingers this column must have: the ones chosen for it, or else the ones
      // the same grip had last time (a preference: a hand that cannot play them
      // there picks its own).
      // A grip, or a single note with its slide: a lone note's finger otherwise
      // follows the passage around it, which differs from one time to the next.
      const slides = [...shape].filter(([n, p]) => p.fret > 0 && n.slide).map(([n]) => n.slide).sort().join(",");
      const key = `${shapeKey(shape)}|${slides}`, contacts = [...shape.values()].filter((p) => p.fret > 0).length;
      const remembers = contacts > 1 || (contacts === 1 && !!slides);
      let required = input[i].fingers;
      if (!required.size && remembers && fingerMemory.has(key))
        required = new Map([...shape].map(([note, p]) => [note, fingerMemory.get(key).get(p.string)]).filter(([, f]) => f != null));
      const hand = handForShape(shape, seats[i], handProfileForTuning(tuning), required,
        !!holds[i] || input[i].fingers.size > 0 || !!gripped[i]);
      options.hands[i] = hand;
      // A finger the player typed onto a note is what the next same grip remembers.
      if (remembers)
        fingerMemory.set(key, new Map([...shape].map(([note, p]) => [p.string,
          isChosenFinger(note.finger) && p.fret > 0 ? note.finger : hand.fingers.get(note)])));
    }
    return shape.size ? shape : null;
  });
}

// The fingers a pin asks for, on this column's notes, matched by pitch.
function chosenFingers(notes, source) {
  const low = (list) => [...list].sort((a, b) => a.pitch - b.pitch);
  const from = low(source), to = low(notes), out = new Map();
  to.forEach((note, k) => {
    const finger = from[k]?.pos?.finger;
    if (Number.isInteger(finger) && finger >= THUMB && finger <= 4) out.set(note, finger);
  });
  return out;
}

// Every entry point below goes through here, so this is the one place the engine
// is named. `registerColumns` is that engine: the hand planner (planShifts) moves
// the hand as few times as it can and puts each note where that hand reaches it. See its section at the foot of this file.
function voiceColumns(columns, tuning, options = {}) {
  const grips = shapeGrips(columns, tuning, options);
  return registerColumns(columns, tuning, grips ? { ...options, grips } : options);
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
    if (!got || !Number.isFinite(got.cost)) return UNPLAYED;
    const active = options.anchorChanges ? [...(options.holds || [])].sort((a, b) => a.t - b.t)
      .filter(h => h.t <= column.t0 + 1e-6).at(-1) : null;
    const hand = handForShape(shape, active?.fret ?? got.seat, handProfileForTuning(tuning), new Map(), !!active);
    // A grip that needs another hand than the saved one is still on offer: the saved
    // hand stays where it is, and the mismatch is reported as a conflict, not refused.
    if (!hand.playable) return UNPLAYED;
    return { ...got, seat: hand.seat,
      fingers: [...shape].map(([note, pos]) => [pos.string, hand.fingers.get(note) ?? NO_FINGER]) };
  });
}

// voiceNotes, plus the physical hand that plays it. The register walk determines
// positions; handForShape chooses finger contacts and their actual anchor as one
// pose. Slide continuations then carry compatible fingers into the next grip.
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
  carrySlideFingers(chosen, fingers, seats, handProfileForTuning(tuning));
  const found = { voiced, fingers, seats };
  if (options.anchorChanges) applyHandAnchors(notes, found, tuning, options.holds);
  return found;
}

// A saved change owns the whole following range. Keep its value even when a
// note or an explicitly chosen finger cannot reach it; report that conflict.
// IMPLICIT HAND ANCHORS. A slide that leaves the hand elsewhere sets it for the next
// column exactly like a saved anchor; the only difference is that nobody edits it.
// A pitched slide-out (outDown/outUp) leaves it where the slide ends, a shift/legato
// slide moves it by the frets its finger travels. A saved anchor on that column wins.
// Pick slides are the picking hand's; the fretting hand stays.
// Everything that asks where the hand is reads this list, never handHolds alone.
export function slideLanding(note, next, fret, posOf) {
  const at = posOf(note);
  if (note.slide === 'outDown' || note.slide === 'outUp')
    return Math.max(1, fret + edgeSlideSpan(note, at?.fret || fret));
  if (!SLIDE_TO_NEXT.has(note.slide) || !(at?.fret > 0) || !next) return null;
  const land = next.notes.map(posOf).find(p => p?.string === at.string && p.fret > 0);
  return land ? Math.max(1, fret + land.fret - at.fret) : null;
}

export function handAnchorsInForce(columns, holds = [], posOf = (n) => n.pos) {
  const ordered = (Array.isArray(holds) ? holds : []).filter(h => Number.isFinite(Number(h?.t)))
    .sort((a, b) => Number(a.t) - Number(b.t));
  const out = [...ordered];
  let j = 0, fret = null, landing = null, slid = null;
  columns.forEach((column, i) => {
    let saved = null;
    while (j < ordered.length && Number(ordered[j].t) <= column.t0 + 1e-6) saved = ordered[j++];
    if (saved) fret = Number(saved.fret);
    else if (landing != null && landing !== fret) {
      fret = landing;
      // The rail's id for this landing (slideOutHandChanges), so a conflict flags it.
      out.push({ id: `slide_${slid.id || slid.start}_to`, t: column.t0, fret, implicit: true });
    }
    slid = column.notes.length === 1 ? column.notes[0] : null;
    landing = slid && fret != null ? slideLanding(slid, columns[i + 1], fret, posOf) : null;
  });
  return out.sort((a, b) => Number(a.t) - Number(b.t));
}

export function applyHandAnchors(notes, found, tuning, holds = []) {
  const profile = handProfileForTuning(tuning), conflicts = new Map();
  // Stored positions, as registerColumns and note-issues read them, so all agree.
  const ordered = handAnchorsInForce(chordColumns(notes), holds);
  let i = 0, active = null;
  for (const column of chordColumns(notes)) {
    while (i < ordered.length && ordered[i].t <= column.t0 + 1e-6) active = ordered[i++];
    if (!active) continue;
    const shape = new Map(column.notes.flatMap(n => found.voiced.has(n) ? [[n, found.voiced.get(n)]] : []));
    const required = new Map(column.notes.flatMap(n => {
      const finger = n.finger ?? n.pos?.finger;
      return isChosenFinger(finger) ? [[n, finger]] : [];
    }));
    const hand = handForShape(shape, active.fret, profile, required, true);
    const mismatch = !hand.playable || (shape.size && hand.seat != null && hand.seat !== active.fret)
      || [...required].some(([n, f]) => shape.get(n)?.fret > 0 && hand.fingers.get(n) !== f);
    for (const note of column.notes) {
      found.seats.set(note, active.fret);
      const finger = required.get(note) ?? hand.fingers.get(note);
      if (finger != null) found.fingers.set(note, finger);
      if (mismatch) conflicts.set(note, active.id);
    }
  }
  found.handConflicts = conflicts;
  found.handAnchors = ordered;
  return found;
}

// A SLIDE KEEPS ITS FINGER, AND THE HAND GOES WITH IT. A shift/legato slide is one
// finger travelling along its string, so the note it lands on is held by the finger
// that left, and the hand's seat moves by the frets it slid. The walk prices each
// column on its own and reads a finger off the seat it stands on, so left alone it
// labels the target by fret distance — a 7→9 slide with the hand at 5 came out as
// 3 → 4, and the board's digit changed under a finger that never lifted. The other
// notes of a landing grip are counted from the seat the hand slid to.
function carrySlideFingers(chosen, fingers, seats, profile) {
  for (let i = 1; i < chosen.length; i++) {
    const prev = chosen[i - 1], cur = chosen[i];
    if (!prev || !cur) continue;
    let delta = null, seat = null;
    const carried = new Set();
    for (const [note, pos] of cur) {
      if (!(pos.fret > 0)) continue;
      for (const [from, at] of prev) {
        if (at.string !== pos.string || !(at.fret > 0) || !SLIDE_TO_NEXT.has(from.slide) || !fingers.has(from)) continue;
        fingers.set(note, fingers.get(from));
        carried.add(note);
        delta ??= pos.fret - at.fret;
        seat ??= seats.get(from) ?? null;
      }
    }
    if (delta == null || seat == null) continue;
    seat += delta;
    const required = new Map([...carried].map(note => [note, fingers.get(note)]));
    const hand = handForShape(cur, seat, profile, required);
    for (const [note] of cur) {
      seats.set(note, hand.seat);
      if (hand.fingers.has(note)) fingers.set(note, hand.fingers.get(note));
    }
  }
}

// MIDI -> tab: where the fretting hand is decides where every note goes. The hand
// planner below picks the hand for each column; inside it a note has one place.

const SPAN = 4;   // the hand covers four frets from the index

// HOW MANY FRETS THERE ARE IS A FACT ABOUT THE INSTRUMENT, so the caller states
// it and this is only the default for a caller that cannot. `web/fretboard-core.js`
// measures all three off named production models (electric 22, acoustic 20, bass 20)
// and the lane carries the `instrument` that selects one; registerColumns reads it
// from there, so the engine and the drawn neck cannot disagree.
const DEFAULT_NECK_FRETS = 22;   // an electric; callers pass the real count

// The highest fret the index can stand on with a full grip still on the neck.
const handCeiling = (maxFret) => maxFret - SPAN + 1;

// A note whose written technique restricts where it can be played. Everything the
// engine knows about effects arrives here; the caller derives it (see effectRule)
// so this file's planner stays ignorant of the app's note shape.
//
//   fretted  cannot be played on an open string: a slide slides a finger, a bend
//            pushes a fretted note, fretting-hand vibrato needs something to shake.
//   free     not held by the fretting hand at all (a tapped note), so the window
//            does not apply.
//   reach    the hand must also cover this many frets ABOVE the note: a trill
//            alternates with a fret one or two up and both are held by one hand.
//   edge     a slide in or out needs room on the string: frets it cannot start on.
//   link     this note continues onto the SAME STRING in the next column: "any" for
//            a shift slide or a hammer/pull pair, "fretted" for a legato slide,
//            whose target is sounded by the left hand and so cannot be open.
//   slide    the note slides into the next one, which carries the hand with it.

// Whether a single note has a fretted alternative to an open string.
function hasFrettedPlacement(pitch, tuning, maxFret, reach = 0) {
  return tuning.some((open) => {
    const fret = pitch - open;
    return fret > 0 && fret + reach <= maxFret;
  });
}

// A column with its pitches sorted low to high (`idx` maps back to the input order).
function sortedRegisterColumn(c) {
  const idx = c.pitches.map((_, i) => i).sort((a, b) => c.pitches[a] - c.pitches[b]);
  const order = (list) => (list ? idx.map((i) => list[i]) : null);
  return { idx, t0: c.t0, end: c.end, anchor: c.anchor ?? null, pitches: order(c.pitches),
    fixed: order(c.fixed), pinned: order(c.pinned), rules: order(c.rules), dead: order(c.dead) };
}

/**
 * voiceRegister(tuning, columns, span, seats, maxFret, price)
 * @param tuning  open-string MIDI pitches, physical order, index 0 = fattest string.
 * @param columns [{ pitches, t0?, end?, fixed?, pinned?, rules?, dead?, anchor? }] in
 *                time order. `fixed` is a string per pitch the caller has decided (a
 *                placed column), `pinned` the same for some of its notes, `anchor` the
 *                hand change in force at that column.
 * @param seats   optional array, filled with each column's hand (index fret).
 * @param price   optional { index, shapes, out }: string assignments for one column,
 *                priced against the plan and written back to `out` as { cost, seat }.
 *                This is what the fretboard's other positions cost.
 * @returns per column, per input pitch: { string, fret }; string -1 for a note the
 *          instrument cannot play.
 */

// THE HAND PLANNER. The hand stays where it is until the notes force it to move,
// and over the whole lane it moves as few times as it can:
//
//   window    a hand covers four frets from the index; the pinky reaching one
//             fret further is a stretch, cheaper than a shift. Nothing wider, so
//             one hand never covers more than five frets.
//   shift     costs 1, less where the music makes room (a rest, a column played
//             on open strings, a slide that carries the hand, after a long note)
//             and more in the middle of a fast run. A hair per fret travelled, so
//             the hand stays closest to where it already is.
//   open      an open string costs a little: used when it saves a shift.
//   anchors   a saved hand change keeps the hand there until the next one; leaving
//             it costs more than any shift, so only notes that cannot be played
//             there move it (and then the anchor reports a conflict).
//   pins      a placed note keeps its string; the hand goes where it can reach it.
//   links     a slide or hammer-on continues on the same string.
// ponytail: one Viterbi over hand frets (columns x frets^2); chords try every string
// assignment, fine up to six strings.
const SHIFT = 1, STRETCH = 0.3, OPEN = 0.1, LOOSE = 0.2, LEAVE_ANCHOR = 20, BROKEN_LINK = 50, OFF_PIN = 100;
const FAST_NOTE = 0.15, LONG_NOTE = 0.5, TIE_ON = 1e-5, TIE_MOVE = 1e-6;

function shiftEase(prev, c, prevStrings, tuning) {
  if (prev.t0 == null || c.t0 == null) return 1;
  const gap = c.t0 - prev.end, dur = prev.end - prev.t0;
  const open = prev.pitches.every((p, k) => prevStrings[k] < 0 || p - tuning[prevStrings[k]] === 0);
  if (gap >= REST_GAP || open || prev.rules?.some((r) => r?.slide)) return 0.25;
  if (dur >= LONG_NOTE) return 0.5;
  return dur < FAST_NOTE ? 2 : 1;
}

// The cheapest way to play column `c` with the hand at `g`: { cost, strings } or null.
function placeInHand(tuning, c, g, span, maxFret) {
  const k = c.pitches.length, pinnedAny = !!c.fixed || !!c.pinned?.some((s) => s != null);
  const options = c.pitches.map((p, j) => {
    const want = c.fixed ? c.fixed[j] : c.pinned?.[j] ?? null, rule = c.rules?.[j], out = [];
    for (let s = 0; s < tuning.length; s++) {
      if (want != null && s !== want) continue;
      const f = p - tuning[s];
      if (f < 0 || f > maxFret) continue;
      if (want == null && ((f === 0 && rule?.fretted) || rule?.edge?.(f))) continue;
      out.push({ s, f, bound: f > 0 && !rule?.free && !c.dead?.[j], reach: rule?.reach || 0 });
    }
    return out;
  });
  const used = new Array(tuning.length).fill(false), pick = new Array(k).fill(null);
  let best = null;
  const score = () => {
    let lo = Infinity, hi = -Infinity, cost = 0;
    for (const o of pick) {
      if (!o) continue;
      if (o.f === 0) cost += OPEN;
      else if (o.bound) { lo = Math.min(lo, o.f); hi = Math.max(hi, o.f + o.reach); }
      else if (o.f < g || o.f > g + span) cost += LOOSE;   // muted or tapped: anywhere, near is nicer
    }
    if (lo === Infinity) return cost;
    // Ties only, never worth a shift over a whole lane: the hand sits on the notes,
    // the index on the lowest (TIE_ON), then it moves the least (TIE_MOVE).
    cost += TIE_ON * Math.abs(lo - g);
    if (lo >= g && hi <= g + span - 1) return cost;
    if (lo >= g && hi <= g + span) return cost + STRETCH;
    return pinnedAny ? cost + OFF_PIN + 0.1 * Math.min(Math.abs(g - lo), Math.abs(g + span - 1 - hi)) : Infinity;
  };
  const walk = (j) => {
    if (j === k) {
      const cost = score();
      if (cost < (best?.cost ?? Infinity)) best = { cost, strings: pick.map((o) => (o ? o.s : -1)) };
      return;
    }
    let any = false;
    for (const o of options[j]) {
      if (used[o.s]) continue;
      any = true; used[o.s] = true; pick[j] = o; walk(j + 1); used[o.s] = false; pick[j] = null;
    }
    if (!any) walk(j + 1);   // nowhere to put it: it stays unplaced (-1)
  };
  walk(0);
  return best;
}

// A slide or hammer-on leaving a lone note continues on the same string.
function linkCost(prev, c, a, b, tuning) {
  if (prev.pitches.length !== 1 || c.pitches.length !== 1) return 0;
  const rule = prev.rules?.[0];
  if (!rule?.link) return 0;
  if (a.strings[0] !== b.strings[0]) return BROKEN_LINK;
  return rule.link === "fretted" && b.strings[0] >= 0 && c.pitches[0] - tuning[b.strings[0]] === 0 ? BROKEN_LINK : 0;
}

function planShifts(tuning, cols, span, seats, maxFret, price) {
  const n = cols.length, frets = Array.from({ length: handCeiling(maxFret) }, (_, i) => i + 1);
  const at = cols.map((c) => {
    const row = frets.map((g) => placeInHand(tuning, c, g, span, maxFret));
    if (row.some(Boolean)) return row;
    // No hand anywhere holds it (a chord wider than a stretch): place it anyway, hand-free.
    const strings = placeAnyway(tuning, c.pitches, c.fixed || c.pinned?.map((s) => s ?? -1) || null, maxFret);
    return frets.map(() => ({ cost: 0, strings }));
  });
  const own = (i, gi, until) => {
    const p = at[i][gi];
    if (!p) return Infinity;
    const a = i < until ? cols[i].anchor : null;
    return p.cost + (a != null && frets[gi] !== a ? LEAVE_ANCHOR : 0);
  };
  const step = (i, hi, gi) => (hi === gi ? 0 : SHIFT * shiftEase(cols[i - 1], cols[i], at[i - 1][hi].strings, tuning)
    + TIE_MOVE * Math.abs(frets[hi] - frets[gi])) + linkCost(cols[i - 1], cols[i], at[i - 1][hi], at[i][gi], tuning);
  // A hand change reaches forward only: columns before it are planned without it, but
  // still seeing the notes after it. A hand change is in force from its column on.
  const starts = [0];
  for (let i = 1; i < n; i++) if (cols[i].anchor != null && cols[i].anchor !== cols[i - 1].anchor) starts.push(i);
  // What columns i.. cost from hand gi at i, seeing no hand changes: what every
  // segment sees past its end. Worked out once, backwards, from the first change on.
  const rest = new Array(n);
  for (let i = n - 1; i >= (starts[1] ?? n); i--) rest[i] = frets.map((g, gi) => {
    const o = own(i, gi, 0);
    if (o === Infinity || i === n - 1) return o;
    let best = Infinity;
    frets.forEach((h, k) => { if (rest[i + 1][k] < Infinity) best = Math.min(best, step(i + 1, gi, k) + rest[i + 1][k]); });
    return o + best;
  });
  // Plan columns a..until-1 from the hand before a, with what follows priced in.
  const hand = new Array(n);
  const plan = (a, until) => {
    // A fret that cannot hold column a is never stepped into (as in the loop below).
    let cost = frets.map((g, gi) => {
      const o = own(a, gi, until);
      return a && o < Infinity ? o + step(a, hand[a - 1], gi) : o;
    });
    const back = [];
    for (let i = a + 1; i < until; i++) {
      const next = [], from = [];
      frets.forEach((g, gi) => {
        const o = own(i, gi, until);
        let best = Infinity, k = -1;
        if (o < Infinity) frets.forEach((h, hi) => {
          if (cost[hi] === Infinity) return;
          const v = cost[hi] + step(i, hi, gi);
          if (v < best) { best = v; k = hi; }
        });
        next.push(best + o); from.push(k);
      });
      back.push(from); cost = next;
    }
    if (until < n) cost = cost.map((v, hi) => {
      if (v === Infinity) return v;
      let best = Infinity;
      frets.forEach((g, gi) => { if (rest[until][gi] < Infinity) best = Math.min(best, step(until, hi, gi) + rest[until][gi]); });
      return v + best;
    });
    hand[until - 1] = cost.reduce((best, v, gi) => (v < cost[best] ? gi : best), 0);
    for (let i = until - 1; i > a; i--) hand[i - 1] = back[i - 1 - a][hand[i]];
  };
  starts.forEach((a, k) => plan(a, starts[k + 1] ?? n));
  if (seats) hand.forEach((gi, i) => { seats[i] = frets[gi]; });
  if (price && cols[price.index]) {
    const c = cols[price.index], g = frets[hand[price.index]];
    price.out = price.shapes.map((given) => {
      const fixed = c.idx.map((k) => given[k]);
      if (fixed.some((s, j) => s == null || s < 0 || c.pitches[j] - tuning[s] < 0 || c.pitches[j] - tuning[s] > maxFret)) return null;
      // What it costs: played from this column's hand, or after a shift.
      let cost = Infinity;
      for (const h of frets) {
        const p = placeInHand(tuning, { ...c, fixed, pinned: null }, h, span, maxFret);
        if (p) cost = Math.min(cost, p.cost + (h === g ? 0 : SHIFT));
      }
      // Where the index would stand to take it: its lowest fretted note.
      const held = fixed.map((s, j) => c.rules?.[j]?.free || c.dead?.[j] ? 0 : c.pitches[j] - tuning[s]).filter((f) => f > 0);
      return Number.isFinite(cost) ? { cost, seat: held.length ? Math.min(...held) : null } : null;
    });
  }
  return hand.map((gi, i) => at[i][gi].strings);
}

function voiceRegister(tuning, columns, span = SPAN, seats = null, maxFret = DEFAULT_NECK_FRETS, price = null) {
  if (!columns.length) return [];
  // Sort each column once; placement walks it lowest pitch first.
  const sorted = columns.map(sortedRegisterColumn);
  const strings = planShifts(tuning, sorted, span, seats, maxFret, price);
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

const REST_GAP = 0.1;   // s; the shortest rest that frees the hand, however short the note

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
      if (pitches.length === 1 && f === 0 && hasFrettedPlacement(pitches[i], tuning, maxFret)) continue;
      used[s] = true;
      seated[i] = s;
      break;
    }
  }
  return seated;
}
