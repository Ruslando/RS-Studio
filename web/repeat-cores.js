// A group holds only what recurs. Each found passage is divided into half-bar
// units; material played in no other instance (a fill, a one-off ending) is a
// variation and leaves the group, since it needs defining only once. Runs
// shared by the same instances become groups, and runs of the same material
// found in different passages join one group.
// ponytail: units count beats from each instance's origin and assume 4/4. Use
// the lane's bar lines if other meters cut phrases in the wrong place.
const UNIT = 2, EDGE = .06, TOL = .125, SAME = .75, ORNAMENT = 1, MIN_ATTACKS = 4, MIN_BEATS = 4;

// Octave variants stay in their group; the comparison reports them.
const pitchClass = pitch => ((pitch % 12) + 12) % 12;

// Beats (within the units) of the notes either side plays without a counterpart.
function unmatched(a, b) {
  const used = new Set(), out = [];
  for (const x of a) {
    const k = b.findIndex((y, i) => !used.has(i) && pitchClass(y.note.pitch) === pitchClass(x.note.pitch) && Math.abs(y.beat - x.beat) <= TOL);
    if (k >= 0) used.add(k); else out.push(x.beat);
  }
  return out.concat(b.filter((_, i) => !used.has(i)).map(y => y.beat));
}
const missesOf = (a, b) => Math.max(a.length, b.length) - (a.length + b.length - unmatched(a, b).length) / 2;
// One stray, missing or changed note is a difference to review, not material.
const minor = (a, b) => missesOf(a, b) <= 1;
function same(a, b) {
  const longer = Math.max(a.length, b.length);
  return !longer || minor(a, b) || 1 - missesOf(a, b) / longer >= SAME;
}

const attacks = entries => new Set(entries.map(e => Math.round(e.beat * 1e4))).size;
const start = copy => copy.notes[0]?.note.start ?? Infinity;

function unitsOf(repeat) {
  const length = repeat.phraseLength || Math.max(...repeat.copies.flatMap(c => c.notes.map(e => e.beat))) + EDGE;
  const count = Math.max(1, Math.ceil(length / UNIT - 1e-6));
  return repeat.copies.map(copy => {
    const out = Array.from({ length: count }, () => []);
    for (const e of copy.notes) {
      const k = Math.min(count - 1, Math.max(0, Math.floor((e.beat + EDGE) / UNIT)));
      out[k].push({ note: e.note, beat: e.beat - k * UNIT });
    }
    return out;
  });
}

// shares[i][j][k]: instances i and j play the same material in unit k.
// A one-off departure is a difference to review: a similar unit, or a brief
// gap between shared units (an ornament spanning under a beat; edges are never
// bridged). A departure other instances repeat on both sides is a variation:
// each version recurs, so each forms its own group.
function sharedUnits(units) {
  const n = units.length, count = units[0].length;
  const close = units.map(a => units.map(b => a.map((unit, k) => minor(unit, b[k]))));
  const recurs = (i, j, k) => {
    const others = Array.from({ length: n }, (_, m) => m).filter(m => m !== i && m !== j);
    return others.some(m => close[m][i][k] && !close[m][j][k]) && others.some(m => close[m][j][k] && !close[m][i][k]);
  };
  return units.map((a, i) => units.map((b, j) => {
    const row = a.map((unit, k) => i === j || close[i][j][k] || (!recurs(i, j, k) && same(unit, b[k])));
    for (let k = 1; k < count - 1; k++) {
      if (row[k]) continue;
      let to = k;
      while (to < count && !row[to]) to++;
      const beats = [];
      for (let u = k; u < to; u++) beats.push(...unmatched(a[u], b[u]).map(beat => beat + u * UNIT));
      let oneOff = true;
      for (let u = k; u < to; u++) if (recurs(i, j, u)) oneOff = false;
      if (oneOff && row[k - 1] && to < count && Math.max(...beats) - Math.min(...beats) < ORNAMENT) row.fill(true, k, to);
      k = to;
    }
    return row;
  }));
}

// Claim the run that saves the most comparison first: shared length times the
// instances beyond the first. A long pair beats a brief trio, so a third
// instance matching here and there cannot shred a common passage.
function claimRuns(units, shares) {
  const n = units.length, count = units[0].length, used = units.map(() => new Array(count).fill(false)), runs = [];
  const membersOn = (i, from, to) => units.map((_, m) => m).filter(m => {
    for (let k = from; k < to; k++) if (used[m][k] || !shares[i][m][k]) return false;
    return true;
  });
  // Maximal stretches inside from..to where instances i and m share each unit.
  const stretches = (i, m, from, to, each) => {
    for (let k = from; k < to;) {
      if (used[i][k] || used[m][k] || !shares[i][m][k]) { k++; continue; }
      let end = k;
      while (end < to && !used[i][end] && !used[m][end] && shares[i][m][end]) end++;
      each(k, end); k = end;
    }
  };
  for (;;) {
    let best = null;
    const offer = (from, to, set) => {
      const score = (set.length - 1) * (to - from);
      if (set.length > 1 && (!best || score > best.score)) best = { from, to, set, score };
    };
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) stretches(i, j, 0, count, (from, to) => {
      offer(from, to, membersOn(i, from, to));
      // Larger sets on part of the stretch compete as well.
      for (let m = 0; m < n; m++) if (m !== i && m !== j) stretches(i, m, from, to, (x, y) => offer(x, y, membersOn(i, x, y)));
    });
    if (!best || (best.to - best.from) * UNIT < MIN_BEATS) return runs;
    for (const i of best.set) used[i].fill(true, best.from, best.to);
    runs.push(best);
  }
}

export function recurringCores(repeats) {
  const kept = [], groups = [];
  for (const repeat of repeats) {
    if (repeat.copies.length < 2) { kept.push(repeat); continue; }
    const units = unitsOf(repeat), shares = sharedUnits(units);
    // All instances share every unit: the passage stands as found.
    if (shares.every(row => row.every(units => units.every(Boolean)))) { kept.push(repeat); continue; }
    for (const run of claimRuns(units, shares)) {
      const phraseLength = (run.to - run.from) * UNIT, model = units[run.set[0]].slice(run.from, run.to);
      let group = groups.find(g => g.phraseLength === phraseLength && g.model.every((unit, k) => same(unit, model[k])));
      if (!group) groups.push(group = { phraseLength, model, copies: [] });
      for (const i of run.set) group.copies.push({ phraseLength,
        notes: units[i].slice(run.from, run.to).flatMap((unit, k) => unit.map(e => ({ note: e.note, beat: e.beat + k * UNIT }))) });
    }
  }
  const cores = groups.map(({ phraseLength, copies }) => ({ phraseLength, copies: copies.filter(c => c.notes.length).sort((a, b) => start(a) - start(b)) }))
    .filter(g => g.copies.length > 1 && attacks(g.copies[0].notes) >= MIN_ATTACKS);
  return [...kept, ...cores].sort((a, b) => start(a.copies[0]) - start(b.copies[0]));
}
