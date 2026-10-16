// The fretboard's geometry, in millimetres, and what the hand on it is playing.
// Nothing here touches the DOM, so tests/fretboard.test.mjs can run it under node —
// same reason marker-rails.js is split this way. The imports are util.js's
// noteName, which is pure: a second copy of the twelve note names is exactly the
// drift the design contract exists to prevent — and bend.js's curve, for the same
// reason: the board bends the string the stage draws, not a second idea of it.
//
// Fret placement is 12-TET in closed form: d(n) = L * (1 - 2^(-n/12)). The
// luthier's constant 17.817152 is that same rule iterated (each fret sits
// 1/17.817 of the way down the *remaining* string), and the test checks the two
// agree to well inside the 0.01" a fret slot is cut to. The identity that
// catches any arithmetic slip on sight: fret 12 lands on exactly half the scale.
// The historic "rule of 18" is the one that is wrong, and it is not used here.
//
// Every number below is a measurement off a real instrument, not a drawing
// choice, which is why they are millimetres and not pixels: the renderer scales
// mm → px once, isotropically, so what lands on screen is the shape of a neck
// (8.5 : 1 for the electric) rather than the stretched diagram every chord-chart
// library draws — and it is why the three necks below come out different shapes
// on the panel instead of one board with the string count swapped.
//
// One spec per instrument, and there are three. Each is measured off a named
// production model rather than averaged over a category,
// so the numbers can be checked against a spec sheet; each is taken the same way,
// so tests/fretboard.test.mjs runs one set of assertions over all three.
//
// The check that catches a guessed number in any of them is the edge margin: half
// of (board width − string spread) is the wood outside the outer strings, it is
// what a player's fingers fall off, and it is ~4mm at both ends of every neck ever
// built. The board taper and the string fan are measured independently — one off
// the fretboard, one off the nut and the bridge — so the two agreeing to a tenth
// of a millimetre is a real cross-check and not arithmetic.

import { bendSnapAt } from "./string-techniques.js";
import { hammerLink } from "./articulations.js";
import { graceBefore } from "./grace.js";
import { noteName } from "./util.js";
import { SLIDES_TO_NEXT, bendCurve, pitchMoves, pitchOffsetAt, slideAt, trillInterval, trillOffsetAt } from "./bend.js";

export const GUITAR = {
  name: "Electric guitar",
  scale: 647.7,          // 25.5" — Fender, Ibanez, most superstrats
  frets: 22,
  strings: 6,            // index 0 = highest string, the top line of a tab staff
  // The board edges are a straight taper between these two widths. 30% looks like
  // too much and it is real: the neck widens because the *strings* do, and the
  // two spreads below are the same taper measured at the string centres instead.
  // Keeping both pairs is the check — the edge margin they imply (board width
  // minus string spread, halved) has to come out the same at both ends, and it
  // does: 3.90mm at the nut, 4.02mm at the last fret. That is what caught the
  // 56.0 this first shipped with, which implied 4.24 at the heel and nothing in
  // particular at the nut.
  widthAtNut: 42.8,      // 1.6875", modern Fender
  widthAtEnd: 55.56,     // 2-3/16" at the heel — the standard Strat neck spec
  // Outer string centres. Strings fan out toward the bridge, so the spread at a
  // fret interpolates over the *scale*, not over the length of drawn board.
  spreadAtNut: 35.0,     // 1.375" E-to-e
  spreadAtBridge: 52.4,  // 2-1/16", modern Fender bridge spacing
  gauges: [0.254, 0.330, 0.432, 0.660, 0.914, 1.168],   // .010-.046, high E first
  fretCrown: 2.6,        // .102" — medium jumbo, what a 22-fret Fender neck ships with
  nutDepth: 3.2,         // the nut itself, behind fret 0
  overhang: 5.0,         // board past the last fret
  dotDiameter: 6.35,     // 0.25"
  dots: [3, 5, 7, 9, 12, 15, 17, 19, 21],
  doubleDots: [12],
};

export const ACOUSTIC = {
  name: "Acoustic guitar",
  // Martin dreadnought, the shape everything else copies. Everything here is off
  // the D-28 spec sheet.
  //
  // 25.4" is what Martin publishes; a long-scale Martin measures 25.34" on the
  // instrument, which is a 1.6mm difference over the whole string and 0.8mm at the
  // twelfth fret. The published figure wins because every other number here is from
  // the same sheet and they have to describe one guitar.
  scale: 645.16,         // 25.4"
  frets: 20,             // a 14-fret body join leaves 20 on the board
  strings: 6,
  widthAtNut: 44.45,     // 1-3/4", Martin's modern standard
  // Martin publishes the width at the 12th fret rather than at the end, so the end
  // is that taper carried to fret 20: 44.45 + (53.98 − 44.45) × d20/d12. The test
  // checks the 12th-fret width comes back out at exactly 2-1/8".
  widthAtEnd: 57.50,
  spreadAtNut: 36.5,     // 1-7/16" E-to-e, which is the 1-3/4" nut less ~4mm a side
  // Saddle spacing is set by the bridge rather than by the neck, and it runs
  // 2-1/8" to 2-1/4" across makers and across Martin's own models. 2-3/16" is the
  // one that holds the nut's edge margin all the way up the board: at 2-1/8" the
  // wood outside the outer strings would open from 3.98mm at the nut to 4.51mm at
  // the last fret, and the taper Martin publishes does not do that.
  spreadAtBridge: 55.56, // 2-3/16" at the saddle
  // Phosphor bronze lights, .012–.053 — every one thicker than the electric's.
  gauges: [0.305, 0.406, 0.610, 0.813, 1.067, 1.346],
  fretCrown: 2.03,       // .080" — acoustic wire is narrower than an electric's
  nutDepth: 4.76,        // 3/16" bone, thicker than the electric's 1/8"
  overhang: 5.0,
  dotDiameter: 6.35,     // 0.25"
  // No dot at the 3rd, which is the fastest way to tell a Martin-style board from
  // an electric one at a glance, and true of most steel-strings.
  dots: [5, 7, 9, 12, 15, 17],
  // And a *single* dot at the twelfth, which is the other half of the same tell.
  // Doubling it is the near-universal steel-string convention and Martin is the
  // exception, so a board that takes Martin's nut, its taper and its missing 3rd
  // has to take this too or it is a Martin everywhere except the one fret a player
  // finds the octave by. Nothing is lost: the fret numbers below the board name the
  // 12th outright, which is more than the second dot ever said.
  doubleDots: [],
};

export const BASS = {
  name: "Bass guitar",
  // Fender Jazz Bass. The 34" scale is the same one the voicing engine's
  // BASS_HAND_PROFILE already uses, so the drawn neck and the cost model agree
  // about how far a shift is.
  scale: 863.6,          // 34"
  frets: 20,
  strings: 4,
  widthAtNut: 38.1,      // 1.5" — the J neck; a Precision is 1-5/8"
  // Fender publishes no width at the last fret. The quoted 2-1/2" is the heel —
  // the rectangle sized for the neck pocket — and taking it as the board's own
  // taper is what the numbers rule out: it would leave 7.1mm of wood outside the
  // outer strings at fret 20 against 3.95mm at the nut, and a neck whose edge
  // margin nearly doubles up the board is not a neck anyone builds. So this is the
  // taper the strings demand instead — the spread at fret 20 plus the nut's own
  // edge — and it puts the board at 51.6mm (2.03") at the twelfth, which is where
  // a J neck measures.
  widthAtEnd: 56.6,
  spreadAtNut: 30.2,     // 1-3/16" G-to-E
  spreadAtBridge: 57.15, // 3 × 0.75", standard Fender bass bridge spacing
  gauges: [1.143, 1.651, 2.159, 2.667],   // .045–.105 long scale, G first
  fretCrown: 2.7,        // .106" — bass wire runs wider than a guitar's
  nutDepth: 3.2,
  overhang: 5.0,
  dotDiameter: 6.35,
  dots: [3, 5, 7, 9, 12, 15, 17, 19],
  doubleDots: [12],
};

// Keyed by the INSTRUMENTS keys in constants.js — not imported from there, because
// this file is DOM-free so the tests can run it, and constants.js is where the Tone
// factories live. tests/fretboard.test.mjs is what holds the two lists together, and
// it holds them to a *bijection*: three instruments, three necks, no key spare on
// either side. It was four to three while one field named both the guitar and its
// sound, and `guitar` and `guitar_dist` pointing at one object was that field's
// duplication showing through here.
export const FRETBOARDS = { electric: GUITAR, acoustic: ACOUSTIC, bass: BASS };
// An unknown or absent instrument draws the electric, which is what instrKey() also
// falls back to. A lane must never leave the panel with no neck on it.
export const fretboardFor = (instrument) => FRETBOARDS[instrument] || GUITAR;

// Distance from the nut to fret n. n = 0 is the nut.
export const fretDistance = (n, scale = GUITAR.scale) => scale * (1 - 2 ** (-n / 12));

// The drawn slab: the nut, every fret, and the board's own overhang past the last.
export const boardLength = (s = GUITAR) => s.nutDepth + fretDistance(s.frets, s.scale) + s.overhang;
export const boardWidth = (s = GUITAR) => s.widthAtEnd;

// Half the board's width x mm from the nut. Constant behind the nut, and
// constant again past the last fret — that overhang is where the taper stops,
// so boardWidth() above stays the true widest point.
export function boardHalfWidthAt(x, s = GUITAR) {
  const t = Math.min(1, Math.max(0, x) / fretDistance(s.frets, s.scale));
  return (s.widthAtNut + (s.widthAtEnd - s.widthAtNut) * t) / 2;
}

// Centre of string i, x mm from the nut, as an offset from the board's
// centreline. A real string is straight, so this is linear in x all the way to
// the bridge — no clamp at the last fret.
export function stringOffsetAt(i, x, s = GUITAR) {
  const spread = s.spreadAtNut + (s.spreadAtBridge - s.spreadAtNut) * (Math.max(0, x) / s.scale);
  return (i / (s.strings - 1) - 0.5) * spread;
}

// An inlay marks a fret *space*, not a fret: it sits midway between the wire
// behind it and the wire it names.
export const dotCentre = (n, s = GUITAR) =>
  (fretDistance(n - 1, s.scale) + fretDistance(n, s.scale)) / 2;

// ---- where the hand is ----
// A fingertip presses in the space behind the wire, which is where an inlay is
// too. Fret 0 is not pressed at all, so it reads on the nut — or on the capo, when
// the neck carries one (`s.capo`, see laneSpec). Frets count from the capo, as the
// tab does, so a fretted note sits `capo` spaces further up the wood.
export const fretCentre = (fret, s = GUITAR) =>
  fret <= 0 ? (s.capo ? capoLine(s) : -s.nutDepth / 2) : dotCentre(fret + (s.capo || 0), s);

// Where a capo clamps: just behind its fret's wire, where a finger would press.
export const capoLine = (s) => fretDistance(s.capo, s.scale) - 3;

// A hand is one grip at a time, not six independent strings.
//
// The first build tracked a timeline per string, and it was wrong for a reason
// worth writing down: a string's own notes can be twenty seconds apart, so each
// marker held its last fret and drifted to the next on its own schedule. Six
// markers each answering a different question is not a hand — most of what was on
// screen at any moment was a stale position from a phrase that had finished.
//
// So the unit is the chord column the voicing engine already works in: one grip,
// one moment, and the fingers that hold it. Everything a hand does — pressing,
// shifting, lifting — is then a property of the grip and reads as one movement.

// Columns as {start, end, fingers: [{string, fret, finger, start}]}, sorted, with
// out-of-range strings dropped (a lane may be voiced against a wider tuning) and
// empty grips discarded so they cannot become gaps in the middle of a phrase.
//
// `shape` is where the hand *is*, with the fingering deliberately left out: it is
// what tells two consecutive grips apart, and a grip the hand does not have to
// move for is the same grip whether or not the fingering engine relabelled it.
// `note` rides along untouched: it is one of the column's own note objects, and it
// is how the board answers "which column is under the playhead" to anything that
// works in notes rather than in millimetres — the positions overlay asks the
// voicing engine about a column, and a column is named by a note in it.
export function handColumns(columns, strings = GUITAR.strings) {
  const out = [];
  for (const c of columns) {
    const fingers = (c.fingers || []).filter((f) => f.string >= 0 && f.string < strings);
    if (!fingers.length) continue;
    const shape = fingers.map((f) => `${f.string}:${f.fret}`).sort().join(" ");
    out.push({ start: c.start, end: c.end, eighth: c.eighth, fingers, shape, note: c.note, seat: c.seat ?? null });
  }
  return out.sort((a, b) => a.start - b.start);
}

// The last entry that has started by t, or -1. Binary search because this runs
// every frame over a whole song's worth of columns.
export function gripIndex(timeline, t) { return startedBy(timeline, t); }

function startedBy(timeline, t) {
  let lo = 0, hi = timeline.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].start <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

const markAt = (f, s) => ({
  strikeStart: f.strikeStart, tremoloStep: f.tremoloStep, soundingEnd: f.soundingEnd,
  finger: f.finger, fret: f.fret, string: f.string, start: f.start, dead: f.dead,
  // The note object itself, so a mark can be edited and not only drawn: moving one
  // note of a grip has to name which note, and pitch cannot (a unison bend puts the
  // same pitch on two strings). Carried, never read by the drawing.
  pitch: f.pitch, note: f.note, x: fretCentre(f.fret, s),
});

// ---- a bend ----
// A bent string is pushed along the fret and the finger goes with it: the treble
// strings toward the bass side, the bass strings toward the treble, which is how a
// player bends them (the way that does not push the string off the neck). A whole
// step moves it about one string's spacing, roughly what a full bend covers at
// mid-neck, so the lift is counted in string spacings: `string + lift` is where the
// fingertip is. An open string has no finger to push it, so it never lifts.
// A vibrato is the same push, small and repeated, so it moves the finger the same way.
export const BEND_SPACING_PER_SEMI = 0.5;
export function bendLift(mark, t, strings) {
  const note = mark.note;
  if (!pitchMoves(note) || !(mark.fret > 0)) return 0;
  const span = note.end - note.start;
  const semi = pitchOffsetAt(note, span > 0 ? (t - note.start) / span : 0, t - note.start);
  return semi * BEND_SPACING_PER_SEMI * (mark.string < (strings - 1) / 2 ? 1 : -1);
}

// How long the hand has to reach the next grip, and this is the number the whole
// animation turns on. It is `travel` — one beat, set by the caller — except that it
// may never take more than **half** of the outgoing grip's own time.
//
// A shift is spent in the seconds before the next grip, not smeared after the last
// one: a real hand arrives just in time. The first build additionally required a
// *rest* to move in, and on a contiguous transcription (this one is nearly all
// back-to-back eighths) that meant almost every shift happened between two frames
// and was invisible. So the window is now allowed to open while the outgoing note
// is still sounding — a hand does have to lift to move — and the half is what keeps
// that honest: the grip is always held for at least half its length before the hand
// leaves it, so no note is swallowed whole by the shift into the next one. It is the
// same reasoning that fixes the glow at half a beat, from the other end.
const travelWindow = (cur, next, travel) =>
  Math.min(travel, cur ? (next.start - cur.start) / 2 : travel);

// Only a known finger can carry its marker into the next position.
function originFor(f, origins) {
  if (!(f.fret > 0) || !f.finger || f.dead) return null;
  return origins.find((o) => o.fret > 0 && !o.dead && o.finger === f.finger) || null;
}

// Where the hand is at time t: `{ pressed, marks }`, or null for an empty neck.
//
// Travel is tested before the grip is, because a shift now overlaps the note it is
// leaving. Outside those two states the neck is **empty** — nothing is being played,
// so nothing is shown. That is the line that removes the ghosts: a marker exists
// only because a note is sounding or about to.
//
// A travelling finger is matched to the next grip by its finger number, so 1
// slides to 1 and never to 3. Both its fret and its string interpolate, because a
// finger crossing to another course moves diagonally.
function handPoseAt(columns, t, travel, s = GUITAR) {
  const i = startedBy(columns, t);
  const cur = i >= 0 ? columns[i] : null;
  const next = columns[i + 1];
  // Re-striking the grip you are already holding is not a shift, so it never opens
  // a window. Without this the hand "travelled" from a chord to the same chord — no
  // marker moved a millimetre, but the state change from filled to outlined and
  // back read as movement anyway, which is worse than showing nothing.
  // A slide onto the next note is not a shift of the hand: the finger stays down and
  // slides there (the pressed branch below carries it), so no travel window opens.
  const slidesOn = cur?.fingers.some((f) => f.fret > 0 && SLIDES_TO_NEXT.has(f.note?.slide));
  // The sounding grace note precedes its authored column. Show the lower finger
  // already pressed, with the upper hammer-on finger poised at the main fret.
  const before = next?.fingers.flatMap((f) => {
    const grace = graceBefore(f.note, next.eighth ? 30 / next.eighth : 120, f.fret);
    if (!grace || t < grace.start || t >= f.note.start) return [];
    const lower = f.fret + grace.offset;
    const targetFinger = lower > 0 ? Math.max(2, f.finger || 1) : f.finger || 1;
    const m = markAt({ ...f, fret: lower, finger: lower > 0 ? targetFinger - 1 : 0,
      start: grace.start, strikeStart: grace.start, tremoloStep: 0 }, s);
    m.graceTarget = { fret: f.fret, x: fretCentre(f.fret, s), finger: targetFinger };
    return [m];
  }) || [];
  if (before.length) {
    const strings = new Set(before.map((m) => m.string));
    const held = cur?.fingers.filter((f) => f.note?.end > t && !strings.has(f.string)).map((f) => markAt(f, s)) || [];
    return { pressed: true, marks: [...held, ...before] };
  }

  const hammersOn = cur && next?.fingers.some((f) => cur.fingers.some((g) =>
    g.string === f.string && hammerLink(g.note, f.note)));
  const window = next ? travelWindow(cur, next, travel) : 0;
  // Once the neck has gone empty, the old grip is no longer a visible origin.
  // Reappear at the destination instead, including when its shape is unchanged.
  const fresh = !cur || cur.end < next?.start - window;
  if (next && (fresh || (!(cur && cur.shape === next.shape) && !slidesOn && !hammersOn))) {
    if (t >= next.start - window) {
      // A PREBEND IS PUSHED BEFORE IT IS PICKED. Where the previous note has already
      // let go, the second half of that free time is spent pushing the string up, so
      // the finger eases into the bend instead of snapping there at the onset; the
      // shift itself finishes first. With no free time (back-to-back notes) there is
      // nothing to ease in and the bend lands at the onset, as before.
      const pre = next.fingers.some((f) => f.fret > 0 && bendCurve(f.note)?.[0][1]);
      const lead = pre ? Math.max(0, Math.min(window, cur ? next.start - cur.end : window)) : 0;
      const arrive = window - lead / 2;
      const u = arrive > 0 ? Math.min(1, (t - (next.start - window)) / arrive) : 1;
      // Smootherstep: leave and arrive with zero velocity and acceleration.
      const shift = u * u * u * (u * (u * 6 - 15) + 10);
      const v = lead > 0 ? Math.max(0, (t - (next.start - lead / 2)) / (lead / 2)) : 0;
      const push = v * v * (3 - 2 * v);   // smoothstep: a push starts and lands gently
      const origins = cur && !fresh ? cur.fingers : [];
      const held = !fresh ? handPoseAt(columns, t, 0, s)?.marks.filter((m) =>
        !next.fingers.some((f) => originFor(f, [m]))) || [] : [];
      return {
        pressed: false,
        marks: [...held.map((m) => ({ ...m, pressed: true })), ...next.fingers.flatMap((f) => {
          const grace = graceBefore(f.note, next.eighth ? 30 / next.eighth : 120, f.fret);
          const b = markAt(grace ? { ...f, fret: f.fret + grace.offset } : f, s), a = originFor(f, origins);
          b.lift = bendLift(b, next.start, s.strings) * push;
          // Unmatched fingers preview at their own destination without travelling.
          if (!a) {
            b.opacity = u * u * (3 - 2 * u);
            return [b];
          }
          const o = markAt(a, s);
          return {
            ...b,
            fret: u < 0.5 ? a.fret : f.fret,
            string: o.string + (b.string - o.string) * shift,
            x: o.x + (b.x - o.x) * shift,
          };
        })],
      };
    }
  }
  if (cur && t <= cur.end) {
    const prev = columns[i - 1];
    return { pressed: true, marks: cur.fingers.map((f) => {
      const m = markAt(f, s);
      // Arrived by a legato slide: sounding, but not picked again, so no strike.
      m.slurred = !!prev?.fingers.some((g) => g.string === f.string && g.note?.slide === "legato");
      m.lift = bendLift(m, t, s.strings);
      // A slide carries the finger along its string, a fret per semitone. Onto the
      // next note it lands where that grip holds the same string.
      const note = f.note;
      const source = prev?.fingers.find((g) => g.string === f.string && hammerLink(g.note, note));
      if (source) {
        m.slurred = true;
        m.hammerMotion = f.fret > source.fret ? "hammer" : "pull";
        if (source.fret < f.fret && source.fret > 0)
          m.hammerSupport = { fret: source.fret, x: fretCentre(source.fret, s), finger: source.finger };
      }
      const target = next?.fingers.find((g) => g.string === f.string && hammerLink(note, g.note));
      if (target && target.fret !== f.fret)
        m.hammerTarget = { fret: target.fret, x: fretCentre(target.fret, s), finger: target.finger,
          pressed: target.fret < f.fret, opacity: target.fret < f.fret ? 1 : 0.55 };
      const grace = graceBefore(note, cur.eighth ? 30 / cur.eighth : 120, f.fret);
      if (grace) {
        const lower = f.fret + grace.offset;
        m.finger = lower > 0 ? Math.max(2, f.finger || 1) : f.finger || 1;
        m.slurred = true;
        m.hammerMotion = "hammer";
        const release = (t - note.start) / grace.duration;
        if (lower > 0 && release >= 0 && release < 1) {
          m.graceOrigin = { fret: lower, x: fretCentre(lower, s), finger: m.finger - 1,
            opacity: 1 - release };
        }
      }
      if (note?.slide && f.fret > 0) {
        const onto = SLIDES_TO_NEXT.has(note.slide) && next?.fingers.find((g) => g.string === f.string);
        const semi = slideAt(note, t - note.start, note.end - note.start,
          { to: onto ? onto.fret - f.fret : 0, steps: false, eighth: cur.eighth });
        if (semi) m.x = fretCentre(Math.max(1, f.fret + semi), s);
      }
      const interval = trillInterval(note?.trill);
      if (interval && t >= note.start && t < note.end && f.fret + interval <= s.frets) {
        const fret = f.fret + interval;
        const used = new Set(cur.fingers.filter((g) => g !== f).map((g) => g.finger));
        const finger = [1, 2, 3, 4].find((v) => v > (f.finger || 0) && !used.has(v)) || 0;
        m.trill = { fret, x: fretCentre(fret, s), finger,
          down: !!trillOffsetAt(note, t - note.start, cur.eighth ? 30 / cur.eighth : 120) };
      }
      return m;
    }) };
  }
  return null;
}

// Releases remain at their last played position for a short, smooth fade.
// Keep this out of the paused/editing view, where travel is zero.
export const MARK_RELEASE_SECONDS = 0.18;
export function handAt(columns, t, travel, s = GUITAR) {
  const pose = handPoseAt(columns, t, travel, s);
  if (!(travel > 0)) return pose;
  const marks = (pose?.marks || []).filter((m) => !m.note || t <= m.note.end);
  const i = startedBy(columns, t);
  for (let j = i; j >= 0; j--) {
    const col = columns[j], next = columns[j + 1];
    if (next && next.start <= t - MARK_RELEASE_SECONDS) break;
    for (const f of col.fingers) {
      const end = Math.min(f.note?.end ?? col.end, next?.start ?? Infinity);
      if (t < end || t >= end + MARK_RELEASE_SECONDS) continue;
      // A moving finger already owns its marker; do not leave a second one behind.
      if (marks.some((m) => (f.finger && m.finger === f.finger && !m.dead && !f.dead)
        || (m.string === f.string && m.fret === f.fret))) continue;
      const last = handPoseAt(columns, end - 1e-8, 0, s)?.marks.find((m) =>
        m.note === f.note && m.string === f.string);
      if (!last) continue;
      const u = (t - end) / MARK_RELEASE_SECONDS;
      const release = f.soundingEnd ?? end;
      const lift = t >= release ? bendLift(last, Math.min(release, f.note?.end ?? release), s.strings)
        * bendSnapAt(t - release) : last.lift;
      marks.push({ ...last, lift, pressed: true, releasing: true, opacity: 1 - u * u * (3 - 2 * u) });
    }
  }
  return marks.length ? { pressed: pose?.pressed ?? true, marks } : null;
}

// Sustaining strings and released tension outlive the displayed note column.
export function ringingMarksAt(fingers, t, s = GUITAR) {
  return fingers.filter((f) => f.note.end <= t && t < f.soundingEnd)
    .map((f) => {
      const m = markAt(f, s);
      return { ...m, ringing: true, lift: bendLift(m, f.note.end, s.strings) };
    });
}

export function releasedStringsAt(fingers, t, s = GUITAR) {
  return fingers.filter((f) => {
    const end = f.soundingEnd ?? f.note.end;
    return end <= t && t < end + MARK_RELEASE_SECONDS;
  }).map((f) => {
    const m = markAt(f, s);
    m.releasing = true;
    m.lift = bendLift(m, f.note.end, s.strings) * bendSnapAt(t - (f.soundingEnd ?? f.note.end)) || 0;
    return m;
  });
}

export function releasedBendsAt(fingers, t, s = GUITAR) {
  return releasedStringsAt(fingers, t, s).filter((m) => Math.abs(m.lift) > 0.001);
}

// Sounding notes own their strings. Fading markers and upcoming finger positions
// must not mask the string's release, even when the rest of a chord is still held.
export function stringContactAt(now, string) {
  const marks = now?.at?.marks.filter((m) => m.string === string) || [];
  const pressed = marks.find((m) => !m.releasing && (m.pressed ?? now.at.pressed)
    && (m.note?.start ?? m.start) <= now.t && now.t < (m.soundingEnd ?? m.note?.end ?? Infinity));
  return pressed || now?.ringing?.find((m) => m.string === string)
    || now?.releases?.find((m) => m.string === string)
    || marks.find((m) => m.releasing) || marks[0];
}

// ---- every other place ONE note could go ----
// For each mark of a grip, every string that can sound its pitch on this neck. The
// strings the grip already holds are left out — two notes cannot share one, and a
// mark's own place is where it already is — so what comes back is exactly the set of
// legal single-note moves and no offer here can lapse when it is taken.
//
// `tuning` is the app's own order (index 0 = highest string), which is the order the
// marks' `string` is in.
//
// `only` narrows which marks get offers without narrowing which strings are spoken
// for: selecting one note of a chord asks where THAT note could go, and the other
// three are still being held while it moves.
export function notePlacements(marks, tuning, frets, only = null) {
  const taken = new Set(marks.map((m) => m.string));
  const out = [];
  for (const m of only || marks) {
    if (!m.note) continue;
    for (let string = 0; string < tuning.length; string++) {
      if (taken.has(string)) continue;
      const fret = m.pitch - tuning[string];
      if (fret < 0 || fret > frets) continue;
      out.push({ note: m.note, string, fret });
    }
  }
  return out;
}

// ---- somewhere else to put it ----
// A candidate shape's own patch of neck, in millimetres: the span of the marks it
// puts down, which the renderer pads by a marker before it draws the border. A box
// and not a highlight per fret, because what is being offered is one grip — six
// separate marks say "these six places", and the choice is all of them or none.
export function shapeBox(positions, s = GUITAR) {
  if (!positions?.length) return null;
  // Only the fretted notes bound it: an open string needs no hand, and a shape at
  // fret 9 with an open E is a shape at fret 9 — boxing the nut with it drew a
  // rectangle across two thirds of the neck and buried every other candidate under
  // it. A shape that is *all* open is the one case with nothing else to measure.
  const fretted = positions.filter((p) => p.fret > 0);
  positions = fretted.length ? fretted : positions;
  const xs = positions.map((p) => fretCentre(p.fret, s));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const strings = positions.map((p) => p.string);
  const lo = Math.min(...strings), hi = Math.max(...strings);
  // The strings fan out, so a box's edge is not parallel to the centreline: each
  // corner is measured where it actually falls and the extremes win.
  const offs = [stringOffsetAt(lo, x0, s), stringOffsetAt(lo, x1, s),
    stringOffsetAt(hi, x0, s), stringOffsetAt(hi, x1, s)];
  return { x0, x1, off0: Math.min(...offs), off1: Math.max(...offs) };
}

// Which box a pointer is in — the *smallest*, so a compact shape sitting inside a
// wider one's span stays reachable. Boxes are the drawn pixels, not millimetres.
export function pickBox(boxes, x, y) {
  let best = -1, area = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
    const a = (b.x1 - b.x0) * (b.y1 - b.y0);
    if (a < area) { area = a; best = i; }
  }
  return best;
}

// ---- what the hand is holding ----
// The board says where the hand is; it cannot say what that is, and a player reads
// "D#sus4" faster than six fret numbers.
//
// Root and quality by table: for each candidate root the intervals above it are a
// key, and a match names the grip. The bass is tried first, so a shape sitting on
// its root keeps it, and a match on any other root prints as a slash chord —
// guitar voicings are inverted more often than not, and calling an E-bass C shape
// "C" would be a small lie in most bars of most songs.
//
// Shells with no fifth are in the table because a guitar plays them constantly; a
// dyad that is not a fifth, and anything past the ninths, is not. No match is not a
// failure — the notes are then the answer, in the notation the editor already
// writes (rule 25), which is also all a single note ever needed.
const SHAPES = {
  "0,7": "5",
  "0,4,7": "", "0,3,7": "m", "0,3,6": "dim", "0,4,8": "aug",
  "0,2,7": "sus2", "0,5,7": "sus4",
  "0,4,10": "7", "0,3,10": "m7", "0,4,11": "maj7",
  "0,4,7,10": "7", "0,4,7,11": "maj7", "0,3,7,10": "m7", "0,3,7,11": "mMaj7",
  "0,3,6,10": "m7b5", "0,3,6,9": "dim7", "0,4,7,9": "6", "0,3,7,9": "m6",
  "0,2,4,7": "add9", "0,5,7,10": "7sus4",
  "0,2,4,7,10": "9", "0,2,3,7,10": "m9", "0,2,4,7,11": "maj9",
};

const pcOf = (p) => ((p % 12) + 12) % 12;
const pcName = (p) => noteName(pcOf(p)).replace(/-?\d+$/, "");

// Pitches (a grip's, dead strings left out — a mute has no pitch) → its name, or "".
export function chordLabel(pitches) {
  const live = (pitches || []).filter((p) => Number.isFinite(p));
  if (!live.length) return "";
  if (live.length === 1) return noteName(live[0]);
  const bass = Math.min(...live);
  const pcs = [...new Set(live.map(pcOf))].sort((a, b) => a - b);
  if (pcs.length === 1) return pcName(bass);
  for (const root of [pcOf(bass), ...pcs]) {
    const quality = SHAPES[pcs.map((p) => pcOf(p - root)).sort((a, b) => a - b).join(",")];
    if (quality === undefined) continue;
    const name = pcName(root) + quality;
    return root === pcOf(bass) ? name : `${name}/${pcName(bass)}`;
  }
  return [...new Set(live.slice().sort((a, b) => a - b).map(pcName))].join(" ");
}
