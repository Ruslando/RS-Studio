// One frame reads the same bars, grid and fingering keys hundreds of times (once
// per note), and nothing edits the song while a frame paints or a pointer
// hit-test runs. paintMemo(fn) answers repeat calls with the same arguments
// from the first one for as long as such a stretch (withMemo) lasts; outside one
// it always calls through. The first argument is matched by identity (a lane),
// the rest by value (a tuning, a count).
let painting = 0, generation = 0;

export function withMemo(read) {
  painting++;
  try { return read(); } finally { if (!--painting) generation++; }
}

export function paintMemo(fn) {
  let at = -1, memo = new Map();
  return (...args) => {
    if (!painting) return fn(...args);
    if (at !== generation) { at = generation; memo = new Map(); }
    const [first = null, ...rest] = args, key = JSON.stringify(rest);
    let byRest = memo.get(first);
    if (!byRest) memo.set(first, byRest = new Map());
    if (!byRest.has(key)) byRest.set(key, fn(...args));
    return byRest.get(key);
  };
}
