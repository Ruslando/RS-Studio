// Tuning registry and instrument geometry, independent of score/export windows.
import { INSTRUMENTS, instrKey } from "./constants.js";
import { fretboardFor } from "./fretboard-core.js";
import { parseTuning } from "./util.js";
import { TUNINGS } from "./tunings.js";
export { TUNINGS };

// User-defined named tunings (note strings, e.g. "G2 D2 A1 E1"), managed via
// "Manage tunings…" on the layer tuning select. Global, reusable across projects,
// and kept by the server: the desktop window's own storage is wiped on every start.
// The window's storage only carries tunings made before that, into the server once.
const LS = typeof localStorage !== "undefined" ? localStorage : null;   // Limitation: undefined under node test
const OLD_TUNINGS_KEY = "cw.customTunings";
const saveCustomTunings = () => fetch("/api/tunings", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(customTunings) }).catch(() => {});
export let customTunings = [];

export async function loadCustomTunings() {
  try {
    const res = await fetch("/api/tunings");
    customTunings = res.ok ? await res.json() : [];
    const old = JSON.parse(LS?.getItem(OLD_TUNINGS_KEY) || "[]");
    if (old.length && !customTunings.length) { customTunings = old; await saveCustomTunings(); }
    LS?.removeItem(OLD_TUNINGS_KEY);
  } catch { /* offline: no tunings of your own this session */ }
}

export const newTuningId = () => "ct_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// The tuning manager edits a draft and hands the whole list over on Save.
export function replaceCustomTunings(list) {
  customTunings = list.map((t) => ({ id: t.id, name: t.name, notes: t.notes, ...(t.instrument ? { instrument: t.instrument } : {}) }));
  saveCustomTunings();
}
// A tuning IS its open strings: two with the same strings are the same tuning,
// whatever they are called. The built-in or one of yours with these strings, or null.
const sameStrings = (a, b) => a.length === b.length && a.every((p, i) => p === b[i]);
export function tuningKeyFor(midis) {
  if (!midis?.length) return null;
  return Object.keys(TUNINGS).find((key) => sameStrings(TUNINGS[key].tuning, midis))
    || customTunings.find((t) => sameStrings(parseTuning(t.notes) || [], midis))?.id || null;
}
// A lane's `tuning` field resolves against built-ins, a custom-tuning id, or
// (legacy) the literal "custom" sentinel paired with lane.customTuning.
export const isValidTuningKey = (key) =>
  !!(key && (TUNINGS[key] || key === "custom" || customTunings.some((t) => t.id === key)));

// Resolve a lane's tab tuning (open-string MIDI, hi→lo) from its own settings.
export function laneTuning(lane) {
  if (TUNINGS[lane.tuning]) return TUNINGS[lane.tuning].tuning;
  const custom = customTunings.find((t) => t.id === lane.tuning);
  if (custom) return parseTuning(custom.notes) || TUNINGS.guitar6.tuning;
  if (lane.tuning === "custom") return parseTuning(lane.customTuning) || TUNINGS.guitar6.tuning;
  return TUNINGS[INSTRUMENTS[instrKey(lane.instrument)].tuning].tuning;
}

// The tuning positions are counted against: a note's pitch is this open pitch plus
// its fret. Frets count from the capo, as in Guitar Pro (alphaTab's pitch is
// fret + open + capo - transposition), so fret 0 is the capo itself.
export function laneFretTuning(lane) {
  const shift = (Number(lane.capo) || 0) - (Number(lane.transpositionPitch) || 0);
  return laneTuning(lane).map((open) => open + shift);
}

// How many frets there are above the capo: the neck's own, minus the capo's.
export const laneFretCount = (lane) => fretboardFor(lane.instrument).frets - (Number(lane.capo) || 0);
