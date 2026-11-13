// Note-based repeat discovery. Onsets, pitches and relative beat times define a
// passage; bar lines, fingering, techniques and existing markings do not.
import { effectiveTechniqueFields } from './repeat-change-details.js';
import { passageStructure } from './passage-structure.js';
import { pulsePassages } from './pulse-passages.js';
import { recurringCores } from './repeat-cores.js';
import { alphabeticLabel, repeatVariations } from './repeat-variations.js';

const REPEAT_MIN_NOTES = 4;
const REPEAT_SIMILARITY = 0.8;
const BEAT_TOL = 0.125;
const MIN_PHRASE_ONSETS = 4;
const PHRASE_REST_BEATS = 8;

// Discovery recognizes octave variants; comparison still pairs exact pitches
// first and reports the actual pitch change. Arbitrary transpositions are not
// equivalent passages.
const pitchClass = pitch => ((pitch % 12) + 12) % 12;
// Discovery scores attacks, not strings. This prevents a full chord from
// outweighing several single-note events or a change of phrase boundary.
const attackCount = notes => new Set(notes.map(n => Math.round(n.beat * 1e4))).size;
function attackEvidence(A, B) {
  const group = notes => {
    const events = [];
    for (const e of notes) {
      const last = events.at(-1);
      if (last && Math.abs(last.beat - e.beat) < 1e-4) last.notes.push(e.note);
      else events.push({ beat: e.beat, notes: [e.note], shares: new Map() });
    }
    return events;
  };
  const aa = group(A), bb = group(B);
  let j = 0, score = 0;
  for (const a of aa) {
    while (j < bb.length && bb[j].beat < a.beat - BEAT_TOL) j++;
    if (j < bb.length && Math.abs(a.beat - bb[j].beat) <= BEAT_TOL) score += shared(a, bb[j++]);
  }
  return score;
}

function matchPassages(A, B) {
  return matchByPitch(A, B, note => note.pitch);
}

function matchByPitch(A, B, pitchOf) {
  const buckets = new Map(), used = new Set(), pairs = [];
  const key = (pitch, bucket) => `${pitch}:${bucket}`;
  for (const b of B) {
    const k = key(pitchOf(b.note), Math.floor(b.beat / BEAT_TOL));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(b);
  }
  for (const a of A) {
    let best = null, gap = BEAT_TOL + 1e-9;
    const bucket = Math.floor(a.beat / BEAT_TOL);
    for (let k = bucket - 1; k <= bucket + 1; k++) for (const b of buckets.get(key(pitchOf(a.note), k)) || []) {
      if (used.has(b)) continue;
      const d = Math.abs(b.beat - a.beat);
      if (d < gap) { gap = d; best = b; }
    }
    if (best) { used.add(best); pairs.push([a.note, best.note]); }
  }
  return pairs;
}

// Pair exact pitches first, then changed pitches at the same relative onset.
// Every note gets at most one counterpart, including at passage boundaries.
function alignPassages(A, B) {
  const pairs = matchPassages(A, B), source = new Set(pairs.map(([a]) => a)), target = new Set(pairs.map(([, b]) => b));
  const substitutions = [];
  for (const a of A) {
    if (source.has(a.note)) continue;
    let best = null, distance = Infinity;
    for (const b of B) {
      if (target.has(b.note) || Math.abs(a.beat - b.beat) > BEAT_TOL) continue;
      const d = Math.abs(a.note.pitch - b.note.pitch);
      if (d < distance) { distance = d; best = b; }
    }
    if (best) { substitutions.push([a.note, best.note]); source.add(a.note); target.add(best.note); }
  }
  return { pairs, substitutions, source, target };
}

// A repeat begins and ends at notes represented in EVERY instance. Changed
// pitches can anchor an edge; an absent prefix/tail cannot. Missing notes
// between these anchors remain part of the passage.
export function boundRepeat(repeat, { rebase = true } = {}) {
  // Pulse phrases have independently inferred boundaries. Cropping these to
  // shared attacks would hide missing openings and differing endings again.
  if (repeat.copies.every(copy => copy.phraseLength > 0)) return repeat;
  if (repeat.copies.length < 2) return repeat;
  const [model, ...others] = repeat.copies;
  const mappings = others.map(copy => {
    const { pairs, substitutions } = alignPassages(model.notes, copy.notes);
    return new Map([...pairs, ...substitutions]);
  });
  const anchors = model.notes.filter(({ note }) => mappings.every(map => map.has(note)));
  if (!anchors.length) return null;
  const first = Math.min(...anchors.map(e => e.beat)), last = Math.max(...anchors.map(e => e.beat));
  const firstNotes = anchors.filter(e => Math.abs(e.beat - first) < 1e-6);
  const lastNotes = anchors.filter(e => Math.abs(e.beat - last) < 1e-6);
  const copies = repeat.copies.map((copy, i) => {
    const beats = new Map(copy.notes.map(e => [e.note, e.beat]));
    const from = i ? Math.min(...firstNotes.map(e => beats.get(mappings[i - 1].get(e.note)))) : first;
    const to = i ? Math.max(...lastNotes.map(e => beats.get(mappings[i - 1].get(e.note)))) : last;
    const notes = copy.notes.filter(e => e.beat >= from - 1e-6 && e.beat <= to + 1e-6);
    const origin = notes[0]?.beat || 0;
    return { ...copy, notes: notes.map(e => ({ note: e.note, beat: e.beat - (rebase ? origin : 0) })) };
  });
  return { ...repeat, copies };
}

function onsetEvents(notes, beatAt) {
  const events = [];
  for (const note of [...notes].filter(n => !n.gripOnly).sort((a, b) => a.start - b.start || a.pitch - b.pitch)) {
    const beat = beatAt(note.start), last = events.at(-1);
    if (last && Math.abs(last.beat - beat) < 1e-4) last.notes.push(note);
    else events.push({ beat, notes: [note] });
  }
  let soundingUntil = -Infinity;
  for (const event of events) {
    event.breakBefore = event.beat - soundingUntil >= PHRASE_REST_BEATS;
    soundingUntil = Math.max(soundingUntil, ...event.notes.map(n => beatAt(n.end)));
    event.pitchKey = event.notes.map(n => n.pitch).join(',');
    event.shares = new Map();
  }
  return events;
}
const shared = (a, b) => {
  const cacheKey = b.pitchKey ?? b.notes.map(n => n.pitch).join(',');
  if (a.shares.has(cacheKey)) return a.shares.get(cacheKey);
  const pitches = b.notes.map(n => n.pitch), unmatched = [];
  let score = 0;
  for (const note of a.notes) {
    const i = pitches.indexOf(note.pitch);
    if (i < 0) unmatched.push(note.pitch);
    else { score++; pitches.splice(i, 1); }
  }
  for (const pitch of unmatched) {
    const i = pitches.findIndex(p => pitchClass(p) === pitchClass(pitch));
    if (i >= 0) { score += .9; pitches.splice(i, 1); }
  }
  score /= Math.max(a.notes.length, b.notes.length);
  a.shares.set(cacheKey, score);
  return score;
};
const copyOf = (events, from, to) => ({
  notes: events.slice(from, to).flatMap(e => e.notes.map(note => ({ note, beat: e.beat - events[from].beat }))),
});

// Consider competing divisions together instead of permanently awarding notes
// to the first high-scoring family. The bounded beam keeps alternative phrase
// boundaries alive while their remaining, non-overlapping copies are scored.
function choosePassages(plans, rebuild) {
  const rank = (a, b) => b.savings - a.savings || b.spans.length - a.spans.length || b.count - a.count || a.spans[0][0] - b.spans[0][0];
  const cache = new Map();
  const available = (plan, used) => {
    const spans = plan.spans.filter(([from, to]) => {
      for (let i = from; i < to; i++) if (used.has(i)) return false;
      return true;
    });
    if (spans.length < 2) return null;
    if (spans.length === plan.spans.length) return plan;
    const key = spans.map(s => s.join(':')).join(',');
    if (!cache.has(key)) cache.set(key, rebuild(spans));
    return cache.get(key);
  };
  const compare = (a, b) => b.score - a.score || a.chosen.length - b.chosen.length;
  // Every extra family needs its own minimum phrase and two boundaries. Charge
  // that description cost so separately grouping each chord does not beat a
  // complete progression merely by finding one extra isolated chord elsewhere.
  const familyCost = MIN_PHRASE_ONSETS + 2;
  let beam = [{ used: new Set(), chosen: [], score: 0 }], best = null;
  while (beam.length) {
    const next = new Map();
    for (const state of beam) {
      const options = plans.map(p => available(p, state.used)).filter(p => p?.savings > 0).sort(rank);
      if (!options.length) { if (!best || compare(state, best) < 0) best = state; continue; }
      const seen = new Set();
      for (const plan of options) {
        const used = new Set(state.used);
        for (const [from, to] of plan.spans) for (let i = from; i < to; i++) used.add(i);
        const key = [...used].sort((a, b) => a - b).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const branch = { used, chosen: [...state.chosen, plan], score: state.score + plan.savings - familyCost };
        if (!next.has(key) || compare(branch, next.get(key)) < 0) next.set(key, branch);
        if (seen.size === 3) break;
      }
    }
    beam = [...next.values()].sort(compare).slice(0, 8);
  }
  return best.chosen;
}

// Extend two candidate onsets along their relative beat timelines, allowing
// changed pitches and inserted/missing onsets. Dense ornaments can contain
// several unmatched attacks; stop on sustained divergence or a long silence.
// Keep its longest prefix with >=80% shared notes (octave variants weigh .9).
function extend(events, i, j, allowed = () => true) {
  const offset = events[j].beat - events[i].beat;
  let a = i, b = j, na = 0, nb = 0, matched = 0, misses = 0, mismatchBeat = null, best = null;
  while (a < j && b < events.length) {
    if ((a > i && events[a].breakBefore) || (b > j && events[b].breakBefore)) break;
    const delta = events[b].beat - events[a].beat - offset;
    const beat = delta > BEAT_TOL ? events[a].beat - events[i].beat : events[b].beat - events[j].beat;
    let m = 0;
    const aligned = Math.abs(delta) <= BEAT_TOL;
    if (aligned) {
      m = shared(events[a], events[b]);
      a++; b++; na++; nb++;
    } else if (delta > 0) { a++; na++; }
    else { b++; nb++; }
    matched += m;
    misses = m ? 0 : misses + 1;
    mismatchBeat = m ? null : mismatchBeat ?? beat;
    // A changed final onset can be a variation when both passages play a note.
    // Advancing one side through unmatched trailing notes cannot extend a group.
    if (aligned && matched >= REPEAT_MIN_NOTES && matched / Math.max(na, nb) >= REPEAT_SIMILARITY && allowed(i, j, a, b))
      best = { i, j, a, b, matched, na, nb };
    if (misses >= 3 && beat - mismatchBeat >= 2) break;
  }
  if (!best) return null;
  const forward = best;
  // The first changed note cannot anchor a pitch match. Recover a varied
  // prefix from the matching suffix when its relative timing still lines up.
  a = i - 1; b = j - 1;
  na = best.na; nb = best.nb; matched = best.matched; misses = 0;
  while (a >= 0 && b >= best.a) {
    if (events[a + 1].breakBefore || events[b + 1].breakBefore) break;
    // Recover a changed opening, without collapsing every matching suffix
    // back to the same maximal start. Suffixes are useful phrase candidates.
    if (shared(events[a], events[b])) break;
    if (Math.abs(events[b].beat - events[a].beat - offset) > BEAT_TOL) break;
    const m = shared(events[a], events[b]);
    na++; nb++; matched += m;
    misses = m ? 0 : misses + 1;
    if (matched / Math.max(na, nb) >= REPEAT_SIMILARITY && allowed(a, b, best.a, best.b))
      best = { ...best, i: a, j: b, matched, na, nb };
    if (misses >= 3) break;
    a--; b--;
  }
  return best === forward ? [best] : [forward, best];
}

// Matching onset candidates retain pitch-index and suffix insertion order.
function indexRepeatCandidates(events, allowed) {
  const candidates = [];
  // The pitch-class index includes octave variants. Keep suffix starts too:
  // different phrase boundaries must compete before any notes are claimed.
  const byPitch = new Map();
  events.forEach((event, i) => {
    for (const pitch of new Set(event.notes.map(n => pitchClass(n.pitch)))) {
      if (!byPitch.has(pitch)) byPitch.set(pitch, []);
      byPitch.get(pitch).push(i);
    }
  });
  for (let i = 0; i < events.length; i++) {
    const starts = new Set(events[i].notes.flatMap(n => byPitch.get(pitchClass(n.pitch))));
    for (const j of starts) {
      if (j <= i) continue;
      const candidate = extend(events, i, j, allowed);
      if (candidate) candidates.push(...candidate);
    }
  }
  const byStart = new Map();
  for (const c of candidates) {
    if (!byStart.has(c.i)) byStart.set(c.i, []);
    byStart.get(c.i).push(c);
  }
  return byStart;
}

// Let alternative phrase lengths compete before claiming any of their notes.
function planRepeatCandidates(events, byStart, passagePlan) {
  const plans = [], planKeys = new Set();
  for (const seeds of byStart.values()) {
    seeds.sort((a, b) => a.j - b.j);
    const lengths = new Set();
    for (const seed of seeds) {
      if (lengths.has(seed.a)) continue;
      lengths.add(seed.a);
      const model = copyOf(events, seed.i, seed.a), spans = [[seed.i, seed.a]];
      const duration = events[seed.a - 1].beat - events[seed.i].beat;
      let last = seed.a;
      const seen = new Set();
      for (const c of seeds) {
        if (c.j < last || seen.has(c.j)) continue;
        seen.add(c.j);
        // Restrict each occurrence to this candidate's musical length. A longer
        // candidate may contain several iterations of the same shorter riff.
        let end = c.j;
        while (end < events.length && events[end].beat - events[c.j].beat <= duration + BEAT_TOL &&
          (end === c.j || !events[end].breakBefore)) end++;
        const copy = copyOf(events, c.j, end);
        if (!copy.notes.length || attackEvidence(model.notes, copy.notes) /
          Math.max(attackCount(model.notes), attackCount(copy.notes)) < REPEAT_SIMILARITY) continue;
        spans.push([c.j, end]); last = end;
      }
      if (spans.length < 2) continue;
      const key = spans.map(span => span.join(':')).join(',');
      if (planKeys.has(key)) continue;
      planKeys.add(key);
      // Score the actual common passage, rather than rewarding tails that will
      // be trimmed later. Unmatched notes cost evidence instead of adding it.
      const plan = passagePlan(spans);
      if (plan) plans.push(plan);
    }
  }
  return plans;
}

function includeSingletonPassages(out, events, structure, structured, eventOf) {
  // A coherent, substantial region is a passage even without another copy.
  // Prefer it whole when repeats only explain a minority of its attacks. A
  // handful of recycled chords must not turn a unique progression into scraps.
  const singletons = structured ? structure.regions.filter(region => {
    const covered = new Set(out.flatMap(group => group.copies.flatMap(copy => copy.notes.map(e => eventOf.get(e.note))))
      .filter(i => i >= region.from && i < region.to));
    return covered.size < (region.to - region.from) * .65;
  }) : [];
  if (singletons.length) {
    for (let i = out.length - 1; i >= 0; i--) {
      out[i].copies = out[i].copies.filter(copy => {
        const from = eventOf.get(copy.notes[0].note), to = eventOf.get(copy.notes.at(-1).note);
        return singletons.every(region => to < region.from || from >= region.to);
      });
      if (out[i].copies.length < 2) out.splice(i, 1);
    }
    for (const region of singletons) out.push({ copies: [copyOf(events, region.from, region.to)] });
  }
}

export function findRepeats(notes, beatAt = t => t) {
  const pulse = pulsePassages(notes, beatAt);
  if (pulse) return recurringCores(pulse);
  const events = onsetEvents(notes, beatAt);
  const structure = passageStructure(events, beatAt);
  const structured = events.filter(e => e.notes.length >= 3).length >= events.length / 2;
  const boundaries = new Set(structure.blocks.flatMap(b => [b.from, b.to]));
  const inRegion = index => structured && structure.regions.some(r => index >= r.from && index < r.to);
  const allowed = (i, j, a, b) => [i, j].every(k => !inRegion(k) || boundaries.has(k)) &&
    [a, b].every(k => !inRegion(k - 1) || boundaries.has(k));
  const eventOf = new Map(events.flatMap((event, i) => event.notes.map(note => [note, i])));
  const byStart = indexRepeatCandidates(events, allowed);
  const phraseLike = copy => {
    const indices = [...new Set(copy.notes.map(e => eventOf.get(e.note)))];
    if (indices.length < MIN_PHRASE_ONSETS) return false;
    if (new Set(indices.map(i => events[i].pitchKey)).size > 1) return true;
    if (structured && indices.every(i => events[i].notes.length >= 3)) return false;
    const gap = events[indices[1]].beat - events[indices[0]].beat;
    return indices.slice(2).some((i, k) => Math.abs(events[i].beat - events[indices[k + 1]].beat - gap) > BEAT_TOL);
  };
  const passagePlan = spans => {
    const bounded = boundRepeat({ copies: spans.map(span => copyOf(events, ...span)) });
    if (!bounded || bounded.copies.some(copy => !phraseLike(copy))) return null;
    // Chord-based regions may be cut between harmonic blocks, never halfway
    // through one strumming/picking pattern merely because a suffix matches.
    if (bounded.copies.some(copy => {
      const from = eventOf.get(copy.notes[0].note), to = eventOf.get(copy.notes.at(-1).note) + 1;
      return (inRegion(from) && !boundaries.has(from)) || (inRegion(to - 1) && !boundaries.has(to));
    })) return null;
    const first = bounded.copies[0];
    const savings = bounded.copies.slice(1).reduce((score, copy) => {
      const matches = attackEvidence(first.notes, copy.notes);
      const { pairs, substitutions } = alignPassages(first.notes, copy.notes);
      const aligned = new Set([...pairs, ...substitutions].map(([note]) => eventOf.get(note))).size;
      return score + matches + .25 * (aligned - matches) - .25 * (Math.max(attackCount(first.notes), attackCount(copy.notes)) - aligned);
    }, 0);
    return { spans: bounded.copies.map(copy => [eventOf.get(copy.notes[0].note), eventOf.get(copy.notes.at(-1).note) + 1]),
      count: bounded.copies.reduce((sum, copy) => sum + attackCount(copy.notes), 0), savings };
  };
  const plans = planRepeatCandidates(events, byStart, passagePlan);
  const out = [];
  for (const plan of choosePassages(plans, passagePlan)) {
    const model = copyOf(events, ...plan.spans[0]);
    const members = plan.spans.map(span => ({ span, copy: copyOf(events, ...span) })).filter(({ copy }) =>
      attackEvidence(model.notes, copy.notes) / Math.max(attackCount(model.notes), attackCount(copy.notes)) >= REPEAT_SIMILARITY);
    if (members.length < 2) continue;
    const bounded = boundRepeat({ copies: members.map(m => m.copy) });
    if (!bounded || bounded.copies.some(copy => !phraseLike(copy))) continue;
    out.push(bounded);
  }
  includeSingletonPassages(out, events, structure, structured, eventOf);
  return recurringCores(out);
}

const samePlacement = (a, b) => a.pos?.string === b.pos?.string && a.pos?.fret === b.pos?.fret;
const fingerOf = (note, fingers) => {
  const value = fingers?.has(note.id) ? fingers.get(note.id) : note.finger;
  return Number.isInteger(value) && value >= 0 && value <= 4 ? value : null;
};
const samePos = (a, b, fingers) => samePlacement(a, b) && fingerOf(a, fingers) === fingerOf(b, fingers);
const stable = value => {
  if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(k => value[k] != null && value[k] !== false).map(k => [k, stable(value[k])]));
  return value;
};
const techniques = note => {
  const fields = effectiveTechniqueFields(note);
  // An absent flag and an explicitly disabled flag mean the same thing.
  fields.fx = fields.fx || {};
  return JSON.stringify(stable(fields));
};
export function compareCopy(model, copy, beatAt = t => t, fingers = null) {
  const bounded = boundRepeat({ copies: [model, copy] }, { rebase: false });
  if (bounded) [model, copy] = bounded.copies;
  const { pairs, substitutions, source, target } = alignPassages(model.notes, copy.notes);
  const entries = new Map([...model.notes, ...copy.notes].map(entry => [entry.note, entry]));
  const changes = [...pairs, ...substitutions].flatMap(([a, b]) => {
    const fields = [];
    if (a.pitch !== b.pitch) fields.push('pitch');
    if (Math.abs(entries.get(a).beat - entries.get(b).beat) > 1 / 32 + 1e-9) fields.push('timing');
    if (Math.abs((beatAt(a.end) - beatAt(a.start)) - (beatAt(b.end) - beatAt(b.start))) > 1 / 32 + 1e-9) fields.push('length');
    if (techniques(a) !== techniques(b)) fields.push('technique');
    return fields.length ? [{ from: a, to: b, fields }] : [];
  });
  const positionDifferences = pairs.filter(([a, b]) => !samePlacement(a, b));
  const fingerDifferences = pairs.filter(([a, b]) => fingerOf(a, fingers) !== fingerOf(b, fingers));
  const missing = model.notes.filter(({ note }) => !source.has(note));
  const added = copy.notes.filter(({ note }) => !target.has(note));
  const playedDifferently = new Set([...changes.map(c => c.to), ...positionDifferences.map(([, b]) => b)]);
  return { pairs, vary: changes.length + missing.length + added.length,
    differ: pairs.filter(([a, b]) => !samePos(a, b, fingers)).length,
    positionDifferences, fingerDifferences, changes, missing, added, playedDifferently: playedDifferently.size };
}
export const playsDifferently = repeat => repeat.copies.slice(1).some(c => compareCopy(repeat.copies[0], c).differ > 0);
export const copyOrigin = (copy, beatAt = t => t) => beatAt(copy.notes[0].note.start) - copy.notes[0].beat;
export function playLike(repeat, model, fingers = null) {
  let changed = 0;
  for (const copy of repeat.copies) {
    if (copy === model) continue;
    for (const [a, b] of compareCopy(model, copy).pairs) {
      if (!a.pos || samePos(a, b, fingers)) continue;
      b.pos = { ...a.pos };
      const finger = fingerOf(a, fingers);
      if (finger != null) b.finger = finger; else delete b.finger;
      changed++;
    }
  }
  return changed;
}

// Generated names follow the group's place in the song and are renumbered
// whenever groups change; only a name the user gave is kept.
const automaticName = name => /^Group (\d+|[A-Z]+)$/.test(name);

// Groups refer to stable note ids rather than replacing motifs/shapes or adding
// marks inside locked references. All views resolve current objects after undo.
export function resolveRepeatGroups(lane, beatAt = t => t) {
  const byId = new Map(lane.notes.map(n => [n.id, n]));
  const groups = (lane.repeatGroups || []).map(group => ({ ...group,
    copies: group.copies.map((ids, index) => {
      const notes = ids.map(id => byId.get(id)).filter(Boolean).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      const offset = notes[0]?.id === ids[0] ? group.offsets?.[index] || 0 : 0;
      const origin = notes.length ? beatAt(notes[0].start) - offset : 0;
      const entries = notes.map(note => ({ note, beat: beatAt(note.start) - origin }));
      return { ids, ...(group.phraseLength > 0 ? { phraseLength: group.phraseLength } : {}),
        notes: group.phraseLength > 0 ? entries.filter(e => e.beat >= -.06 && e.beat < group.phraseLength - .06) : entries };
    }).filter(copy => copy.notes.length).sort((a, b) => a.notes[0].note.start - b.notes[0].note.start),
  })).filter(group => group.copies.length).map(group => boundRepeat(group)).filter(Boolean);
  // Saved IDs anchor the discovered passages; they are not a frozen inventory.
  // Include new/replacement attacks inside the shared boundaries on every
  // resolution, without widening a passage to capture unrelated outside tails.
  const assigned = new Set((lane.repeatGroups || []).flatMap(group => group.copies.flat()));
  const windows = groups.flatMap(group => group.copies.map(copy => ({ copy,
    from: copyOrigin(copy, beatAt), to: copy.phraseLength > 0 ? copyOrigin(copy, beatAt) + copy.phraseLength : beatAt(copy.notes.at(-1).note.start),
  }))).sort((a, b) => (a.to - a.from) - (b.to - b.from) || a.from - b.from);
  for (const note of lane.notes) {
    if (assigned.has(note.id) || note.gripOnly) continue;
    const beat = beatAt(note.start);
    const window = windows.find(window => window.copy.phraseLength > 0
      ? beat >= window.from - .06 && beat < window.to - .06
      : beat >= window.from - 1e-6 && beat <= window.to + 1e-6);
    if (!window) continue;
    window.copy.notes.push({ note, beat: beat - window.from });
    assigned.add(note.id);
  }
  for (const group of groups) for (const copy of group.copies)
    copy.notes.sort((a, b) => a.note.start - b.note.start || a.note.pitch - b.note.pitch);
  for (const [index, group] of groups.entries()) {
    if (automaticName(group.name)) group.name = `Group ${alphabeticLabel(index)}`;
    group.variations = repeatVariations(group, beatAt);
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

export function normalizeRepeatGroups(value, notes) {
  if (!Array.isArray(value)) return [];
  const valid = new Set(notes.map(n => n.id)), used = new Set(), ids = new Set();
  return value.filter(g => g && typeof g.id === 'string' && Array.isArray(g.copies)).flatMap(g => {
    if (ids.has(g.id)) return [];
    ids.add(g.id);
    const layout = Number.isFinite(g.phraseLength) && g.phraseLength > 0;
    const members = g.copies.flatMap((copy, index) => {
      if (!Array.isArray(copy)) return [];
      const ids = [...new Set(copy)].filter(id => {
        if (!valid.has(id) || used.has(id)) return false;
        used.add(id); return true;
      });
      const offset = layout && ids[0] === copy[0] && Number.isFinite(g.offsets?.[index]) ? g.offsets[index] : 0;
      return ids.length ? [{ ids, offset }] : [];
    });
    const copies = members.map(copy => copy.ids);
    const variants = Array.isArray(g.variations) ? repeatVariations({ copies: copies.map(ids => ({ ids })), variations: g.variations
      .filter(v => v && typeof v.id === 'string' && typeof v.name === 'string' && Array.isArray(v.copies)) }) : [];
    return copies.length ? [{ id: g.id, name: typeof g.name === 'string' ? g.name : 'Group', copies,
      ...(layout ? { phraseLength: g.phraseLength, offsets: members.map(copy => copy.offset) } : {}),
      ...(variants.length > 1 || g.variationMode === 'manual' ? { variations: variants, ...(g.variationMode === 'manual' ? { variationMode: 'manual' } : {}) } : {}) }] : [];
  });
}

// Preserve names/ids on a rescan when the detected group substantially overlaps.
export function groupsFromRepeats(repeats, previous = [], beatAt = t => t) {
  let serial = Math.max(0, ...previous.map(g => Number(g.id.match(/^repeat_(\d+)$/)?.[1]) || 0));
  const available = new Set(previous);
  return repeats.map((repeat, index) => {
    const copies = repeat.copies.map(c => c.notes.map(({ note }) => note.id));
    const layout = repeat.phraseLength > 0 ? { phraseLength: repeat.phraseLength, offsets: repeat.copies.map(c => c.notes[0].beat) } : {};
    const members = new Set(copies.flat());
    const old = [...available].map(g => ({ g, common: g.copies.flat().filter(id => members.has(id)).length }))
      .sort((a, b) => b.common - a.common)[0];
    const preserve = old && old.common / Math.max(members.size, old.g.copies.flat().length) >= .5;
    const manual = preserve && old.g.variationMode === 'manual';
    const variations = repeatVariations({ ...repeat, ...(manual ? { variations: old.g.variations } : {}) }, beatAt);
    const variationLayout = variations.length > 1 || manual ? { variations, ...(manual ? { variationMode: 'manual' } : {}) } : {};
    if (preserve) {
      available.delete(old.g); return { id: old.g.id, name: automaticName(old.g.name) ? `Group ${alphabeticLabel(index)}` : old.g.name, copies, ...layout, ...variationLayout };
    }
    const n = ++serial;
    return { id: `repeat_${n}`, name: `Group ${alphabeticLabel(index)}`, copies, ...layout, ...variationLayout };
  });
}
