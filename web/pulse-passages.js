// Phrase candidates for a continuous single-note accompaniment. Repeated
// pedal tones establish a pulse; pitch movement and rhythm distinguish whole
// phrases even when their fills have few exact note counterparts.
const PC = pitch => ((pitch % 12) + 12) % 12;
const EDGE = .06;
const overlap = (a, b) => a.reduce((sum, value, i) => sum + Math.min(value, b[i]), 0);
const normalize = values => { const sum = values.reduce((a, b) => a + b, 0); return values.map(v => sum ? v / sum : 0); };

function pulseOrigin(ns) {
  // Infer phase from sustained attacks, rather than assuming the first note is
  // a phrase start. Pickups and short fills should not move the accompaniment.
  const phases = new Map();
  for (const n of ns) {
    const phase = Math.round((((n.b % 8) + 8) % 8) * 8) % 64;
    phases.set(phase, (phases.get(phase) || 0) + Math.min(2, n.e - n.b));
  }
  const phase = [...phases].sort((a, b) => b[1] - a[1])[0][0] / 8;
  return phase + Math.ceil((ns[0].b - phase - EDGE) / 8) * 8;
}

function pulseFrames(ns, origin) {
  const frames = [];
  for (let start = origin; start <= ns.at(-1).b + EDGE; start += 8) {
    const attacks = ns.filter(n => n.b >= start - EDGE && n.b < start + 8 - EDGE);
    const sounding = ns.filter(n => n.b < start + 8 - EDGE && n.e > start + EDGE);
    const hist = Array(12).fill(0);
    for (const n of sounding) hist[PC(n.note.pitch)] += Math.max(0, Math.min(n.e, start + 8) - Math.max(n.b, start));
    const roots = [0, 4].map(offset => {
      const at = start + offset;
      const attack = attacks.find(n => n.b >= at - EDGE && n.b <= at + 1);
      const held = sounding.findLast(n => n.b < at && n.e > at);
      return attack || held ? PC((attack || held).note.pitch) : null;
    });
    const held = sounding.some(n => Math.min(n.e, start + 8) - Math.max(n.b, start) >= 4 - EDGE);
    const pedal = attacks.filter(n => PC(n.note.pitch) === roots[0]);
    const core = roots[0] === roots[1] && pedal.length >= 4 && pedal.length >= attacks.length * .5 ? pedal : null;
    frames.push({ start, attacks, hist: normalize(hist), roots, held, core });
  }
  return frames;
}

function pulseSimilarity(a, b) {
  // Match a repeated pedal's principal hits separately from its optional
  // fills. Their durations can vary without changing the underlying groove.
  const useCore = a.core && b.core && a.roots[0] === b.roots[0];
  const aa = useCore ? a.core : a.attacks, bb = useCore ? b.core : b.attacks;
  if (!aa.length || !bb.length) return overlap(a.hist, b.hist);
  let matched = 0, timed = 0;
  const used = new Set();
  for (const n of aa) {
    const distance = m => Math.abs(n.b - a.start - (m.b - b.start));
    const other = bb.filter(m => !used.has(m) && distance(m) <= .13).sort((m, q) => distance(m) - distance(q))[0];
    if (other) { used.add(other); timed++; if (PC(n.note.pitch) === PC(other.note.pitch)) matched++; }
  }
  const denom = Math.min(aa.length, bb.length);
  const roots = a.roots.filter((r, i) => r != null && r === b.roots[i]).length / 2;
  return .25 * roots + .4 * Math.min(1, matched / denom) + .2 * overlap(a.hist, b.hist) + .15 * Math.min(1, timed / denom);
}

function comparePulseFrames(frames, i, j, length) {
  let roots = 0, score = 0;
  for (let k = 0; k < length; k++) {
    const a = frames[i + k], b = frames[j + k];
    roots += a.roots.filter((r, t) => r != null && r === b.roots[t]).length;
    score += pulseSimilarity(a, b);
  }
  // Reject a sustained change of density locally, even when a long window's
  // overall match would conceal a sparse replacement of half the phrase.
  let na = 0, nb = 0;
  for (let k = 0; k < length; k++) {
    const a = frames[i + k], b = frames[j + k], core = a.core && b.core && a.roots[0] === b.roots[0];
    const ca = (core ? a.core : a.attacks).length, cb = (core ? b.core : b.attacks).length;
    if (!a.held && Math.min(ca, cb) < Math.max(ca, cb) * .5) return 0;
    na += ca; nb += cb;
  }
  if (Math.min(na, nb) < Math.max(na, nb) * .65 || roots < length * 2 * .75) return 0;
  return score / length;
}

function pulseCandidates(frames) {
  const count = (i, length) => frames.slice(i, i + length).reduce((sum, f) => sum + f.attacks.length, 0);
  const candidates = [];
  for (const length of [1, 2, 4, 8]) for (let i = 0; i + length <= frames.length; i++) {
    const phrase = frames.slice(i, i + length);
    if (count(i, length) < 4 || phrase.some(f => !f.attacks.length && !f.hist.some(Boolean))) continue;
    if (phrase.some(f => f.held) && !phrase.every(f => f.held)) continue;
    if (length > 1 && phrase.every(f => f.core) && new Set(phrase.map(f => f.roots[0])).size === 1) continue;
    const copies = [i]; let quality = 0;
    for (let j = i + length; j + length <= frames.length; j++) {
      if (frames.slice(j, j + length).some((f, k) => f.held !== frames[i + k].held)) continue;
      const score = comparePulseFrames(frames, i, j, length);
      if (score < .74) continue;
      copies.push(j); quality += score; j += length - 1;
    }
    if (copies.length > 1) candidates.push({ length, copies, quality: quality / (copies.length - 1) });
  }
  return candidates;
}

function selectPulseCandidates(candidates) {
  const value = c => c.length * 8 * (c.copies.length + (c.copies.length - 1) * c.quality) - c.copies.length * 4;
  // Coverage rewards complete passages; reuse rewards repetition. Charging
  // each occurrence's boundaries prevents short matching hooks from winning
  // by leaving the differing endings and connecting notes unaccounted for.
  const available = (used) => candidates.map(c => ({ ...c, copies: c.copies.filter(i =>
    Array.from({ length: c.length }, (_, k) => i + k).every(k => !used.has(k))) })).filter(c => c.copies.length > 1)
    .sort((a, b) => value(b) - value(a) || b.length - a.length);
  let beam = [{ used: new Set(), selected: [], score: 0 }], best = null;
  while (beam.length) {
    const next = new Map();
    for (const state of beam) {
      const options = available(state.used);
      if (!options.length) { if (!best || state.score > best.score) best = state; continue; }
      // Keep different phrase lengths alive; shifted versions of one long
      // candidate must not crowd every shorter, reusable progression out.
      const alternatives = [...options.slice(0, 2), ...[1, 2, 4, 8].map(length => options.find(c => c.length === length))].filter(Boolean);
      for (const option of alternatives) {
        const used = new Set(state.used);
        for (const i of option.copies) for (let k = 0; k < option.length; k++) used.add(i + k);
        const key = [...used].sort((a, b) => a - b).join(',');
        const branch = { used, selected: [...state.selected, option], score: state.score + value(option) };
        if (!next.has(key) || branch.score > next.get(key).score) next.set(key, branch);
      }
    }
    beam = [...next.values()].sort((a, b) => b.score - a.score).slice(0, 8);
  }
  return best;
}

function buildPulseGroups(frames, best) {
  const { used, selected } = best;
  if (selected.length < 2 || used.size < frames.length / 2) return null;
  const makeGroup = (starts, length, phraseLength = length * 8) => ({ phraseLength,
    copies: starts.map(i => ({ phraseLength, notes: frames.slice(i, i + length)
      .flatMap(f => f.attacks).map(n => ({ note: n.note, beat: n.b - frames[i].start })) })),
  });
  const groups = selected.map(c => makeGroup(c.copies, c.length));
  // Unclaimed, complete spans remain one-off passages. A short pickup or
  // connecting fill is not sufficient; the terminal held note is a cadence.
  for (let i = 0; i < frames.length;) {
    const f = frames[i];
    const complete = frame => frame.attacks.length >= 2 && frame.attacks[0].b <= frame.start + 1;
    if (used.has(i) || !complete(f)) { i++; continue; }
    let end = i + 1;
    while (end < frames.length && !used.has(end) && complete(frames[end])) end++;
    if (end - i >= 2) groups.push(makeGroup([i], end - i));
    i = end;
  }
  const last = frames.at(-1);
  if (!used.has(frames.length - 1) && last.held && last.attacks.length === 1)
    groups.push(makeGroup([frames.length - 1], 1, last.attacks[0].e - last.start));
  return groups.sort((a, b) => a.copies[0].notes[0].note.start - b.copies[0].notes[0].note.start);
}

export function pulsePassages(notes, beatAt = t => t) {
  const ns = notes.filter(n => !n.gripOnly).map(note => ({ note, b: beatAt(note.start), e: beatAt(note.end) }))
    .sort((a, b) => a.b - b.b || a.note.pitch - b.note.pitch);
  if (ns.length < 32) return null;
  const sameOnset = ns.slice(1).filter((n, i) => Math.abs(n.b - ns[i].b) < 1e-4).length;
  const pedals = ns.slice(1).filter((n, i) => PC(n.note.pitch) === PC(ns[i].note.pitch)).length;
  // Apply the accompaniment model only with evidence of a single voice and
  // recurring pedal tones. Other melodies retain the note-based discovery path.
  if (sameOnset > ns.length * .1 || pedals < ns.length * .2) return null;
  const origin = pulseOrigin(ns);
  const frames = pulseFrames(ns, origin);
  const candidates = pulseCandidates(frames);
  return buildPulseGroups(frames, selectPulseCandidates(candidates));
}
