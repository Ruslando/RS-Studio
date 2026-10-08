// Which note techniques physically can't coexist on one note (pure data — no DOM,
// no storage). Deliberately minimal: only the semantically-null case, not musical
// taste. A dead (muted "X") note sounds no pitch, so any pitch-shaping effect on it
// refers to nothing. Combinations that are merely unusual (accented palm-mute, etc.)
// are the player's call — GP stores them and so do we. The editor uses this to strip
// the conflicting effect(s) when you switch one on, so a note can't contradict itself.
// Names span both storage kinds (fx flags and own-field effects); the editor knows
// where each lives — this file only says what fights what.
const CONFLICT_PAIRS = [
  ["dead", "bend"], ["dead", "slide"], ["dead", "harmonic"],
  ["dead", "vibrato"], ["dead", "whammy"], ["dead", "trill"], ["dead", "grace"],
];

// name -> Set of effects it conflicts with (symmetric; built once from the pairs).
const CONFLICTS = (() => {
  const m = {};
  for (const [a, b] of CONFLICT_PAIRS) { (m[a] ??= new Set()).add(b); (m[b] ??= new Set()).add(a); }
  return m;
})();

// The effects that can't coexist with `name` (empty array if it never conflicts).
export const conflictsWith = (name) => [...(CONFLICTS[name] || [])];
