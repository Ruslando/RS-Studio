// The voicing cost engine: pure note→(string,fret) assignment, no DOM. Split from
// voicing.js (which keeps the chord-preview UI and re-exports everything here) so
// the model is importable headless — tests/web runs it under node.

import { noteName } from "./util.js";
import { OVERLAP_EPS } from "./constants.js";
import { NO_FINGER, THUMB, barreSpanSupported, fretboardFor } from "./fretboard-core.js";
import { SLIDES_TO_NEXT as SLIDE_TO_NEXT } from "./bend.js";

// One source of truth for string/fret choice, shared by the chord preview and
// (via buildTabSpec) the Guitar Pro export, so what you see is what you export.
// Notes are grouped into onset columns. The register engine plans positions per
// bar; a separate, small grip model assigns fingers and checks alternatives.
export const MAX_FRET = 24;

// Fretting fingers, index through little. The thumb is only a choice, and a barre
// is one finger across strings — so this also bounds the number of DISTINCT
// frets any playable shape can hold.
export const MAX_FINGERS = 4;
export { THUMB, NO_FINGER };

export const HAND_SPAN = 8;      // generous search guard; physical finger-pair reach decides comfort/feasibility

export const SHAPES_PER_COL = 6; // alternatives shown in the chord preview
export const DP_SHAPES_PER_COL = 18; // final context-aware search set
export const DP_CONTEXT_POOL = 48;   // broader pool inspected before neighbouring context prunes it

// The register engine chooses strings/frets. This small, independent grip model
// assigns fingers and filters alternatives; it does not plan a second passage.
export const COMFORT_REACH = 3;

// Movement weights retained by the public transition helpers and hand anchoring.
export const COST_W = {
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

export const GUITAR_HAND_PROFILE = Object.freeze({
  id: "guitar6", stringCount: 6, scaleLengthMm: 648, stringSpacingMm: 7,
});

// A bass fret is a third wider, so its stretch stops a fret sooner (handReach).
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

export const CHORD_GAP = 0.06;   // s; onset spread that still counts as one chord


// STACKED NOTES ARE ONE NOTE. Two notes of one pitch sounding over each other — a
// doubled detection, a paste onto itself — are one string struck once, and nothing
// that plays the lane can do anything else with them: they would need a string each.
// The editor keeps them and badges the stack (collectStacks, same test); everything
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
      while (j < same.length && same[j].start < end - OVERLAP_EPS) {
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
    if (last && n.start - last.t0 <= CHORD_GAP) last.notes.push(n);
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

function groupsAtEachFret(shape) {
  const present = [...shape.values()];
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
      const coversAllContacts = same.every(e => e.string < loS || e.string > hiS || members.includes(e));
      if (coversAllContacts && (members.length === 1 || barreSpanSupported(entries, fret, loS, hiS, present))) valid.push({ mask, members });
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

export function stringStates(shape, fingering, profile = GUITAR_HAND_PROFILE) {
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

export const hasPlayableFingering = (shape, profile = GUITAR_HAND_PROFILE) => fingeringOptions(shape, profile).length > 0;

// Select the fingers AND their anchor from one physical pose. The passage's
// register is context, not an independent index position. For a chord its pull
// is bounded so it cannot buy an unnecessarily split barre to save a shift.
export function handForShape(shape, seat, profile = GUITAR_HAND_PROFILE, required = new Map(), fixedSeat = false) {
  const contacts = [...shape].filter(([note, pos]) => pos.fret > 0 && !noteIsDead(note));
  // ONE FRETTED NOTE: the finger is where the hand puts it (fret − hand + 1, the
  // pinky for a stretch), so any hand within reach plays it and the index is on it
  // when the hand is on its fret. Out of reach, the hand comes to the note.
  if (contacts.length === 1) {
    const [note, pos] = contacts[0];
    const at = Number.isFinite(seat) && seat >= 1 && pos.fret - seat >= 0 && pos.fret - seat < handReach(profile) ? seat : pos.fret;
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

// THE HANDS THAT CAN PLAY ONE COLUMN, lowest first: what the fretboard's hand
// buttons offer. One fretted note: any hand within reach of it. A chord: the hands
// of its valid fingerings, so a chord fingered with the index has exactly that fret.
// Nothing fretted: no hand to choose.
export function handChoices(shape, profile = GUITAR_HAND_PROFILE, maxHand = Infinity) {
  const contacts = [...shape].filter(([note, pos]) => pos.fret > 0 && !noteIsDead(note));
  if (!contacts.length) return [];
  let seats;
  if (contacts.length === 1) {
    const fret = contacts[0][1].fret;
    seats = Array.from({ length: Math.min(fret, handReach(profile)) }, (_, k) => fret - k);
  } else {
    let poses = fingeringOptions(shape, profile);
    if (!poses.length) poses = fingeringOptions(shape, stretchProfile(profile));
    seats = poses.map((pose) => pose.seat);
  }
  return [...new Set(seats)].filter((g) => Number.isInteger(g) && g >= 1 && g <= maxHand).sort((a, b) => a - b);
}

// THE THUMB, only ever chosen (fingeringChoices), never picked by the engine. It
// frets the instrument's lowest string over the neck, on the fret of the lowest
// other fretted note, with the next string left out (its tip mutes it): EOF's
// thumb shapes, D/F# 2x0232 and the E-shape 1x3211. The other notes are fingered
// as usual, and the hand is theirs.
export function thumbPoses(shape, profile = GUITAR_HAND_PROFILE) {
  const fretted = [...shape].filter(([note, p]) => p.fret > 0 && !noteIsDead(note));
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
  const contacts = [...shape].filter(([note, pos]) => pos.fret > 0 && !noteIsDead(note));
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

export function fingersAtSeat(shape, seat, profile = GUITAR_HAND_PROFILE, required = new Map()) {
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
export function pinnedPositions(notes, tuning) {
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


// WHAT AN OVERRIDE MEANS FOR THE REST OF THE SONG, stored as `follow` on the pin:
//
//   here     this note or chord only; the memory learns what the engine would have
//            played here, so nothing after it changes (the default)
//   guided   the memory forgets this note or chord and learns the override three
//            times over: the same notes after it prefer it, but where the hand is
//            elsewhere by then a better position nearby may still win
//   locked   the same notes after it take it, until another override of them or
//            until a technique rules it out (spreadPins)
//
// Nothing reaches backwards, and no other note's memory is touched.
export const FOLLOW_MODES = ["here", "guided", "locked"];

export function normalizeOverrideInfluence(value = null) {
  return { follow: FOLLOW_MODES.includes(value?.follow) ? value.follow : "here" };
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

// A LOCKED OVERRIDE IS HANDED ON to every identical column after it that carries no
// pin of its own, until another pin of the same notes. Read at solve time and never
// written onto the other columns: returning the one pin to automatic returns them all,
// and a note drawn later joins without anybody re-applying anything.
// Limitation: "identical" is the same pitches at one onset. The same chord with a
// note left out is another column and is voiced on its own.
function spreadPins(columns, pins) {
  const out = new Array(columns.length).fill(null);
  out.from = new Array(columns.length).fill(-1);    // whose pin each one is
  if (!pins.some(Boolean)) return out;
  const low = (notes) => [...notes].sort((a, b) => a.pitch - b.pitch);
  const keys = columns.map((c) => low(c.notes).map((n) => n.pitch).join(","));
  const live = new Map();
  columns.forEach((column, i) => {
    if (pins[i]) {
      if (overrideFlow(column.notes).follow === "locked") live.set(keys[i], i);
      else live.delete(keys[i]);
    } else if (live.has(keys[i])) {
      const from = live.get(keys[i]), source = low(columns[from].notes);
      out[i] = new Map(low(column.notes).map((n, k) => [n, pins[from].get(source[k])]));
      out.from[i] = from;
    }
  });
  return out;
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

// The column exactly as transcribed, carried on every note of an overridden
// column (the same trick `arrangement` used, so it survives sorting and copying).
// A rewrite deletes and creates notes, so returning to automatic has to put those
// notes back, not merely drop the pins. Taken ONCE, at the first override, so it
// always names the written chord rather than whichever alternative came before.
function writtenColumnForm(columnNotes) {
  const saved = columnNotes.find((n) => n.written)?.written;
  if (saved) return saved;
  return columnNotes.map(({ arrangement, written, ...rest }) => ({ ...rest, ...(rest.pos ? { pos: { ...rest.pos } } : {}) }));
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

// WHERE A NOTE'S TECHNIQUE LETS IT BE PUT BY HAND. The voicer has always kept these
// rules for itself (fitColumn, the carry in voiceRegister); the neck's offers did
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
      fretted: !!rule.fretted, reach: rule.reach || 0, from: null,
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
function holdsByColumn(columns, holds) {
  const out = new Array(columns.length).fill(null);
  for (const h of Array.isArray(holds) ? holds : []) {
    const t = Number(h?.t), fret = Number(h?.fret);
    // At or behind the capo (moveCapo shifted it there) a hold has lapsed, like a pin.
    if (!Number.isFinite(t) || !Number.isFinite(fret) || fret < 1) continue;
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
  const frets = fretboardFor(options.instrument).frets - (Number(options.capo) || 0);
  const pins = columns.map(({ notes }) => lockedShape(notes, tuning));
  const spread = spreadPins(columns, pins);
  const input = columns.map(({ notes, t0 }, i) => {
    const rules = notes.map((n) => effectRule(n, columns[i + 1] ? columns[i + 1].notes : []));
    // A pin handed on from an identical column is an offer the column can refuse:
    // the pitches match but the technique may not, and a grip with an open string
    // under a note that slides here is not the same grip. (An incoming slide's string
    // is the other refusal, and only the walk knows it — see `soft` in voiceRegister.)
    // Some notes pinned and some not (a note added to an imported chord): the pinned
    // ones keep their strings exactly and only the rest are placed, around them.
    const some = pins[i] ? null : pinnedPositions(notes, tuning);
    const partial = some && some.size ? some : null;
    const handed = !pins[i] && !partial && spread[i] && !notes.some((n, k) => {
      const fret = spread[i].get(n).fret;
      return fret > frets || (fret === 0 && rules[k] && rules[k].fretted);
    }) ? spread[i] : null;
    const locked = pins[i] || handed;
    const flow = locked ? overrideFlow(columns[pins[i] ? i : spread.from[i]].notes) : null;
    const fingers = locked ? chosenFingers(notes, pins[i] ? notes : columns[spread.from[i]].notes) : new Map();
    return {
      // A hand put here by the player fixes the hand of this column only. It does not
      // move notes: where they go is decided before the hand (see planHand). A chosen
      // fingering puts the hand where those fingers are (handOfFingers).
      handAt: holds[i]?.fret ?? (fingers.size ? handOfFingers(locked, fingers, handProfileForTuning(tuning)) : null),
      fingers,
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
      pinned: partial ? notes.map((n) => partial.has(n) ? seat.get(partial.get(n).string) : null) : null,
      soft: !!handed,
      // How the override follows on (normalizeOverrideInfluence). Only here: the
      // memory learns what would have been played instead (`aside`). Guided: it
      // forgets these notes and learns the override (`guided`). A locked one is
      // handed on to the same notes after it (`handed`, spreadPins).
      aside: !!pins[i] && flow.follow === "here",
      guided: !!pins[i] && flow.follow === "guided",
      rules,
      // Muted notes, for the hand walk only (planHand): see `reach` in voiceRegister.
      dead: notes.some((n) => n.fx?.dead) ? notes.map((n) => !!n.fx?.dead) : null,
    };
  });

  // The register walk supplies passage context for each column. It is not the
  // final index-finger anchor: handForShape selects that together with actual
  // finger contacts after the strings and frets have been decided. Single notes
  // can stay in the passage's hand position when a physical stretch permits it.
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
  let voiced = null;
  const fingerMemory = new Map();   // grip -> string -> finger, in time order (see the hands below)
  voiced ||= voiceRegister(low, input, undefined, seats, options.bars, frets, price);
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
      // there picks its own). An override only here teaches nothing.
      const key = shapeKey(shape), contacts = [...shape.values()].filter((p) => p.fret > 0).length;
      let required = input[i].fingers;
      if (!required.size && contacts > 1 && fingerMemory.has(key))
        required = new Map([...shape].map(([note, p]) => [note, fingerMemory.get(key).get(p.string)]).filter(([, f]) => f != null));
      const hand = handForShape(shape, seats[i], handProfileForTuning(tuning), required, !!holds[i] || input[i].fingers.size > 0);
      options.hands[i] = hand;
      if (contacts > 1 && !input[i].aside)
        fingerMemory.set(key, new Map([...shape].map(([note, p]) => [p.string, hand.fingers.get(note)])));
    }
    return shape.size ? shape : null;
  });
}

// The fingers a pin asks for, on this column's notes. A locked override handed on
// from another column brings that column's fingers, matched by pitch as spreadPins
// matches the positions.
function chosenFingers(notes, source) {
  const low = (list) => [...list].sort((a, b) => a.pitch - b.pitch);
  const from = low(source), to = low(notes), out = new Map();
  to.forEach((note, k) => {
    const finger = from[k]?.pos?.finger;
    if (Number.isInteger(finger) && finger >= THUMB && finger <= 4) out.set(note, finger);
  });
  return out;
}

// Where the hand stands for a chosen fingering: a single note's finger is
// fret − hand + 1, a chord's fingering is one of its poses.
function handOfFingers(shape, fingers, profile) {
  const contacts = [...shape].filter(([note, p]) => p.fret > 0 && !noteIsDead(note));
  if (contacts.length === 1) {
    const [note, p] = contacts[0], finger = fingers.get(note);
    return finger >= 1 ? Math.max(1, p.fret - finger + 1) : null;
  }
  let poses = posesFor(shape, profile, fingers);
  const pose = poses.find((pose) => [...fingers].every(([note, f]) => pose.fingers.get(note) === f));
  return pose?.seat ?? null;
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
    if (!got || !Number.isFinite(got.cost)) return UNPLAYED;
    const hand = handForShape(shape, got.seat, handProfileForTuning(tuning));
    if (!hand.playable) return UNPLAYED;
    return { ...got, seat: hand.seat,
      fingers: [...shape].map(([note, pos]) => [pos.string, hand.fingers.get(note) ?? NO_FINGER]) };
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
  return { voiced, fingers, seats };
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
export const MAX_REACH = 6;   // with a stretch: the pinky reaches two frets past the four
export const handReach = (profile) => profile?.maxReach ?? MAX_REACH;

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

// Chord open strings need no fretting-hand movement and carry no register cost.
// Single notes retain their existing preference for a fretted placement.
const registerDistance = (pitches, fret, register) =>
  fret === 0 && pitches.length > 1 ? 0 : Math.abs(fret - register);

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
    let d = registerDistance(pitches, f, T);
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
  // Single notes avoid open strings when a fretted placement exists. Chords
  // may use open strings freely unless a written technique requires a fret.
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
  // Pinned notes are seated as given, before anything is searched: no grip, no rule
  // and no cost applies to them, and no other note may take their string.
  if (o.pinned) o.pinned.forEach((s, i) => { if (s != null) { used[s] = true; out[i] = s; } });
  const fretOn = (i, s, free) => {
    const f = pitches[i] - tuning[s];
    const rule = rules ? rules[i] : null;
    const reach = (rule && rule.reach) || 0;
    if (f < 0 || f + reach > maxFret) return -1;
    if (f === 0 && rule && rule.fretted) return -1;
    if (pitches.length === 1 && f === 0 && hasFrettedPlacement(pitches[i], tuning, maxFret, reach)) return -1;
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
      if (s == null || s < 0 || used[s] || out[i] >= 0) continue;
      const f = fretOn(i, s, true);
      if (f < 0) continue;
      used[s] = true; out[i] = s; cost += registerDistance(pitches, f, T);
    }
  }
  for (let i = 0; i < pitches.length; i++) {
    if (out[i] >= 0) continue;
    const rule = rules ? rules[i] : null;
    const reach = (rule && rule.reach) || 0;
    let bestS = -1, bestD = Infinity, bestRank = Infinity;
    for (let s = 0; s < tuning.length; s++) {          // fattest first, so it takes ties
      if (used[s]) continue;
      const f = fretOn(i, s, false);
      if (f < 0) continue;
      // A trill is held by one hand together with its own target, so the string
      // has to suit both frets; everywhere else reach is 0 and this is |f - T|.
      // The iteration order makes the fattest string win an exact tie.
      let d = f === 0 && pitches.length > 1 ? 0
        : Math.max(Math.abs(f - T), Math.abs(f + reach - T));
      if (prev != null && f > 0) d += STICK * Math.max(0, Math.abs(f - prev) - SPAN);
      const rank = d - (o.recall?.(i, s) || 0) / MEMORY_REGISTER_WEIGHT;
      if (rank < bestRank) { bestRank = rank; bestD = d; bestS = s; }
    }
    if (bestS < 0) return null;
    used[bestS] = true; out[i] = bestS; cost += bestD;
  }
  return { out, cost };
}

// Whether a single note has a fretted alternative to an open string.
function hasFrettedPlacement(pitch, tuning, maxFret, reach = 0) {
  return tuning.some((open) => {
    const fret = pitch - open;
    return fret > 0 && fret + reach <= maxFret;
  });
}

function blockCost(tuning, cols, T, maxFret) {
  let cost = 0;
  for (const c of cols) {
    // Keep every pitch in the register estimate, even when its position is
    // pinned. A positional override must not erase context before its onset.
    const used = new Array(tuning.length).fill(false);
    for (let i = 0; i < c.pitches.length; i++) {
      let best = Infinity, bs = -1;
      for (let s = 0; s < tuning.length; s++) {
        if (used[s]) continue;
        const f = c.pitches[i] - tuning[s];
        if (f < 0 || f > maxFret) continue;
        if (c.pitches.length === 1 && f === 0 && hasFrettedPlacement(c.pitches[i], tuning, maxFret)) continue;
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
// A COLUMN THE PLAYER HAS PUT A HAND ON also starts a block, wherever it falls (and
// so does a `cut`, which is where an implied hold is told to stop — see registerColumns). The
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
    if (!blocks.length || b !== last || (!ignoreHolds && (c.hold != null || c.cut))) { blocks.push([]); bar.push(b); }
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

// Memory is rebuilt once, chronologically, per solve. Speculative lookahead
// never trains it, so optimizer iterations cannot amplify their own guesses.
const MEMORY_LOOKAHEAD = 8;
const MEMORY_BEAM = 12;
const MEMORY_REGISTER_WEIGHT = 0.25;
const MEMORY_SHIFT = 5;
const MEMORY_STRENGTH = 4;
const GUIDED_WEIGHT = 3;   // a guided override's bonus (≈8) outweighs a hand shift (5)
const memoryShiftCost = (from, to) => from == null || from === to ? 0
  : MEMORY_SHIFT + .1 * Math.abs(from - to);

const memoryEntries = c => [
  ...c.pitches.map((pitch, k) => [`n:${pitch}`, k]),
  ...(c.pitches.length > 1 ? [[`c:${c.pitches.join(",")}`, -1]] : []),
];

function rememberedBonus(memory, c, out) {
  let bonus = 0;
  for (const [key, k] of memoryEntries(c)) {
    if (k >= 0 && (c.rules?.[k]?.free || c.dead?.[k] || out[k] < 0)) continue;
    const entry = memory.get(key);
    const count = entry?.counts.get(k < 0 ? out.join(",") : String(out[k])) || 0;
    if (count) bonus += MEMORY_STRENGTH * Math.log2(1 + count)
      * count / entry.total * (k < 0 ? 1.5 : 1 / c.pitches.length);
  }
  return bonus;
}

function learnPlacement(memory, c, out, weight) {
  for (const [key, k] of memoryEntries(c)) {
    if (k >= 0 && (c.rules?.[k]?.free || c.dead?.[k] || out[k] < 0)) continue;
    if (k < 0 && out.some(s => s < 0)) continue;
    let entry = memory.get(key);
    if (!entry) memory.set(key, entry = { counts: new Map(), total: 0 });
    const position = k < 0 ? out.join(",") : String(out[k]);
    entry.counts.set(position, (entry.counts.get(position) || 0) + weight);
    entry.total += weight;
  }
}

function linkedStrings(tuning, c, got, next, maxFret) {
  if (!next || !c.rules) return null;
  let carry = null;
  c.rules.forEach((rule, k) => {
    if (!rule?.link || got[k] < 0) return;
    carry ||= new Array(next.pitches.length).fill(null);
    for (let j = 0; j < next.pitches.length; j++) {
      const fret = next.pitches[j] - tuning[got[k]];
      if (carry[j] != null || fret < 0 || fret > maxFret || (rule.link === "fretted" && fret === 0)) continue;
      carry[j] = got[k]; break;
    }
  });
  return carry;
}

function rememberAhead(tuning, columns, start, registers, memory, stand, directed, carry, span, maxFret) {
  let beam = [{ g: stand, carry, cost: 0, first: null }];
  for (let i = start; i < Math.min(columns.length, start + MEMORY_LOOKAHEAD); i++) {
    const c = columns[i];
    if (i > start && (c.hold || c.cut)) break;
    const states = new Map();
    for (const state of beam) {
      const T = directed && state.g != null ? state.g + ((span - 1) >> 1) : registers[i];
      const opts = { rules: c.rules, forced: state.carry, pinned: c.pinned,
        next: columns[i + 1]?.pitches, span, maxFret,
        recall: (k, string) => {
          if (c.rules?.[k]?.free || c.dead?.[k]) return 0;
          const entry = memory.get(`n:${c.pitches[k]}`);
          const count = entry?.counts.get(String(string)) || 0;
          return count ? MEMORY_STRENGTH * Math.log2(1 + count) * count / entry.total / c.pitches.length : 0;
        } };
      const yields = c.soft && state.carry && state.carry.some((s, k) => s != null && s !== c.fixed[k]);
      // An override is obeyed where it stands and planned for nowhere before it:
      // looking ahead, the hand does not prepare for it, so nothing reaches backwards.
      const fixed = c.fixed && !c.aside && !yields && i === start;
      const anchored = i === start && c.hold;
      const candidates = anchored ? [state.g] : Array.from({ length: handCeiling(maxFret) }, (_, k) => k + 1);
      for (const g of candidates) {
        let placed;
        if (fixed) {
          const frets = c.fixed.map((s, k) => c.pitches[k] - tuning[s]).filter(f => f > 0);
          if (frets.some(f => f < g || f >= g + span)) continue;
          placed = { out: c.fixed.slice(), cost: priceAssignment(tuning, c.pitches, c.fixed, T, null, span, maxFret)?.cost || 0 };
        } else placed = gripAt(tuning, c.pitches, T, opts, g, span, maxFret);
        // Whole chord memories compete as whole shapes, not as independently
        // chosen voices. Revalidate every technique and occupied string here.
        if (!fixed && c.pitches.length > 1) {
          const known = memory.get(`c:${c.pitches.join(",")}`);
          for (const key of known?.counts.keys() || []) {
            const given = key.split(",").map(Number);
            if (given.some((s, k) => (state.carry?.[k] != null && state.carry[k] !== s)
              || (c.pinned?.[k] != null && c.pinned[k] !== s)
              || (!c.rules?.[k]?.free && c.pitches[k] - tuning[s] > 0
                && (c.pitches[k] - tuning[s] < g || c.pitches[k] - tuning[s] + (c.rules?.[k]?.reach || 0) >= g + span)))) continue;
            const recalled = gripAt(tuning, c.pitches, T, { ...opts, forced: given }, g, span, maxFret);
            if (!recalled || recalled.out.some((s, k) => s !== given[k])) continue;
            if (!placed || recalled.cost * MEMORY_REGISTER_WEIGHT - rememberedBonus(memory, c, recalled.out)
              < placed.cost * MEMORY_REGISTER_WEIGHT - rememberedBonus(memory, c, placed.out)) placed = recalled;
          }
        }
        if (!placed) continue;
        const shift = anchored ? 0 : memoryShiftCost(state.g, g);
        const cost = state.cost + placed.cost * MEMORY_REGISTER_WEIGHT + shift
          - rememberedBonus(memory, c, placed.out);
        const nextCarry = linkedStrings(tuning, c, placed.out, columns[i + 1], maxFret);
        const key = `${g}:${nextCarry?.join(",") || ""}`;
        if (!states.has(key) || cost < states.get(key).cost) states.set(key, {
          g, carry: nextCarry, cost, first: state.first || { out: placed.out, g },
        });
      }
    }
    if (!states.size) break;
    beam = [...states.values()].sort((a, b) => a.cost - b.cost).slice(0, MEMORY_BEAM);
  }
  if (beam[0].first) return beam[0].first;
  const c = columns[start], T = registers[start];
  const opts = { rules: c.rules, forced: carry, pinned: c.pinned, next: columns[start + 1]?.pitches, span, maxFret };
  const fallback = stand != null && gripRun(tuning, c.pitches, T, opts, stand, span, maxFret);
  return fallback ? { out: fallback.out, g: fallback.g }
    : { out: fitAtRegister(tuning, c.pitches, T, opts), g: stand };
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
 *                an authored pin — and it is obeyed exactly, unless `soft` marks
 *                it as handed on from an identical column, in which case a slide
 *                or hammer arriving on another string wins. `hold` is a fret the
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
      idx, t0: c.t0, end: c.end, hold: c.hold, handAt: c.handAt ?? null, cut: !!c.cut, soft: !!c.soft, aside: !!c.aside,
      guided: !!c.guided,
      pitches: idx.map((i) => c.pitches[i]),
      fixed: c.fixed ? idx.map((i) => c.fixed[i]) : null,
      pinned: c.pinned ? idx.map((i) => c.pinned[i]) : null,
      rules: c.rules ? idx.map((i) => c.rules[i]) : null,
      dead: c.dead ? idx.map((i) => c.dead[i]) : null,
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

  // Global registers remain a prior. Placement uses chronological memory and a
  // short joint search, rather than binding isolated matching fragments.
  const strings = new Array(n), stood = new Array(n).fill(null);
  const registerAt = new Array(n);
  blocks.forEach((idx, b) => idx.forEach(i => { registerAt[i] = registers[b]; }));
  let memory = new Map(), stand = null, directed = false, carry = null;
  let resume = null;
  for (let i = 0; i < n; i++) {
    const c = sorted[i];
    if (c.cut) {
      if (resume) ({ memory, stand, directed } = resume);
      else { memory = new Map(); stand = null; directed = false; }
      resume = null;
    }
    if (c.hold) {
      resume = c.hold.local ? { memory, stand, directed } : null;
      memory = new Map();
      stand = Math.max(1, Math.round(c.hold.fret));
      directed = true;
    }
    const T = directed && stand != null ? stand + ((span - 1) >> 1) : registerAt[i];
    if (price && price.index === i) {
      price.out = price.shapes.map(given => {
        const assignment = c.idx.map(k => given[k]);
        const got = priceAssignment(tuning, c.pitches, assignment, T, null, span, maxFret);
        if (!got) return null;
        const fretted = assignment.map((s, k) => c.rules?.[k]?.free || c.dead?.[k] ? 0 : c.pitches[k] - tuning[s]).filter(f => f > 0);
        const lo = Math.max(1, Math.max(...fretted, 1) - span + 1);
        const hi = Math.min(handCeiling(maxFret), Math.min(...fretted, handCeiling(maxFret)));
        const target = Math.max(lo, Math.min(hi, stand ?? lo));
        return { ...got, cost: got.cost * MEMORY_REGISTER_WEIGHT
          + memoryShiftCost(stand, target) - rememberedBonus(memory, c, assignment) };
      });
    }
    const chosen = rememberAhead(tuning, sorted, i, registerAt, memory,
      stand, directed, carry, span, maxFret);
    let got = chosen.out;
    const yields = c.soft && carry && carry.some((s, k) => s != null && s !== c.fixed[k]);
    if (c.fixed && !yields) got = c.fixed.slice();
    if (c.pinned) c.pinned.forEach((s, k) => { if (s != null) got[k] = s; });
    if (got.some(s => s < 0)) got = placeAnyway(tuning, c.pitches, got, maxFret);
    strings[i] = got;
    // Local pins are exceptions: the hypothetical automatic placement supplies
    // continuity and learning, while the authored placement alone is displayed.
    stand = chosen.g;
    if (!c.aside) {
      if (directed) stood[i] = stand;
      // A guided override replaces what was learned for these notes, and only these.
      if (c.guided) for (const [key] of memoryEntries(c)) memory.delete(key);
      learnPlacement(memory, c, got, c.guided ? GUIDED_WEIGHT : directed ? 2 : 1);
    } else learnPlacement(memory, c, chosen.out, 1);
    carry = linkedStrings(tuning, c, got, sorted[i + 1], maxFret);
  }

  // The hand the board draws. The register is a centroid, not a finger — an
  // asymmetric cost that treated it as the index measured ten points worse — so the
  // anchor is read back off what was actually played. See planHand.
  if (seats) {
    const named = new Array(n).fill(null);
    for (let i = 0; i < n; i++) if (stood[i] != null) named[i] = stood[i];
    const reach = sorted.map((c, i) => {
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < c.pitches.length; k++) {
        const s = strings[i][k];
        // A tapped note is the other hand's, and an open string is nobody's. A muted
        // one is the hand relaxing where it already is: its fret is whatever the
        // tab wrote down (an imported scratch says 22 beside a 3), not a reach.
        if (s < 0 || (c.rules && c.rules[k] && c.rules[k].free) || c.dead?.[k]) continue;
        const f = c.pitches[k] - tuning[s];
        if (f > 0) { lo = Math.min(lo, f); hi = Math.max(hi, f); }
      }
      return Number.isFinite(lo) ? { lo, hi } : null;
    });
    const maxReach = handReach(handProfileForTuning(tuning));
    // The player's hand, where it can play what is there; otherwise it has lapsed.
    sorted.forEach((c, i) => {
      const g = c.handAt, r = reach[i];
      if (g != null && r && g >= 1 && g <= r.lo && r.hi - g < maxReach) named[i] = g;
    });
    const planned = planHand(reach, named, span, maxReach);
    for (let i = 0; i < n; i++) seats[i] = planned[i] ?? Math.max(1, registers[blocks.findIndex((idx) => idx.includes(i))] || 1);
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

// WHERE THE HAND IS, COLUMN BY COLUMN, once the notes are placed. It used to be one
// answer per bar — the lowest fretted fret in it — which is right while a bar fits in
// a hand and nonsense when it does not: a run coming down from the 13th fret to the
// 2nd in one bar reported the hand at 2 throughout, with a fourth finger eleven frets
// away. One note at a time is a chord spread over time, and it has to fit a hand too.
//
// So the hand is walked. On each column the index stands at or below the lowest
// fretted note and reaches up to the highest; a shift moves it. Both are priced and
// the cheapest walk wins (a Viterbi over the index fret):
//
//   reaching   free up to four frets, then steeper with every fret — 5 is a stretch
//              (1), 6 a real one (3), 7 costs more than moving twice (9), and on up.
//              A soft edge, not a cutoff: one note a fret outside the hand is played
//              with a stretch, not with two shifts.
//   shifting   4 (and a hair per fret travelled), so a stretch of six still beats
//              a shift and one of seven does not.
//   the index  a hair for every fret the index stands below the lowest note, which
//              only breaks ties: the hand sits ON the phrase, not under it.
//
// `named[i]` is a hand the player put there (a hold) and is taken as given. Columns
// with nothing fretted take the hand that is already there. This reads the hand off
// the notes; it does not move them — where each note goes is still the register's.
const HAND_SHIFT = 4;
// Past the reach no hand gets there: priced out, but still finite, so a column that
// cannot be held any other way (a chord wider than the reach) keeps a hand.
const stretchCost = (frets, span, reach = MAX_REACH) => (frets <= span ? 0 : frets > reach ? 1e6 : 3 ** (frets - span - 1));

function planHand(reach, named, span = SPAN, maxReach = MAX_REACH) {
  const n = reach.length, out = new Array(n).fill(null);
  let prev = null;                         // [{ g, cost, from }] of the last fretted column
  const trail = [];
  for (let i = 0; i < n; i++) {
    const r = reach[i];
    if (named[i] == null && !r) continue;
    // From the lowest note down to where the top one is still in reach. A column
    // wider than any reach (fret 2 and fret 14 at once) still has the first: the
    // index on its lowest note. With none, the walk below had no state to read.
    const frets = named[i] != null ? [named[i]]
      : Array.from({ length: r.lo - Math.min(r.lo, Math.max(1, r.hi - maxReach + 1)) + 1 }, (_, k) => r.lo - k);
    const states = frets.map((g) => {
      const own = named[i] != null ? 0 : stretchCost(r.hi - g + 1, span, maxReach) + 0.01 * (r.lo - g);
      let best = 0, from = -1;
      if (prev) {
        best = Infinity;
        prev.forEach((p, k) => {
          const c = p.cost + (p.g === g ? 0 : HAND_SHIFT + 0.002 * Math.abs(p.g - g));
          if (c < best) { best = c; from = k; }
        });
      }
      return { g, cost: best + own, from };
    });
    trail.push({ i, states });
    prev = states;
  }
  let k = prev ? prev.reduce((b, st, j) => (st.cost < prev[b].cost ? j : b), 0) : -1;
  for (let t = trail.length - 1; t >= 0; t--) {
    const st = trail[t].states[k];
    out[trail[t].i] = st.g; k = st.from;
  }
  // Nothing fretted here: the hand is wherever it already was, or is about to be.
  for (let i = 1; i < n; i++) if (out[i] == null) out[i] = out[i - 1];
  for (let i = n - 2; i >= 0; i--) if (out[i] == null) out[i] = out[i + 1];
  return out;
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
      if (pitches.length === 1 && f === 0 && hasFrettedPlacement(pitches[i], tuning, maxFret)) continue;
      used[s] = true;
      seated[i] = s;
      break;
    }
  }
  return seated;
}
