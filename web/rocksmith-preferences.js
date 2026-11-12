// Shared export timing preferences. Live diagnostics read these without
// loading the export dialog and its issue-list dependencies.
// Silence in front of the song, in seconds. Rocksmith starts the track the moment the
// song loads, so a first note in the first second cannot be seen coming; five seconds
// is the room the note highway needs. Remembered across exports, 0 to 30.
export const LS_LEAD_IN = "cw.rsLeadIn";
const LEAD_IN_DEFAULT = 10;

export function leadIn(raw) {
  const value = raw === null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) ? Math.min(30, Math.max(0, value)) : LEAD_IN_DEFAULT;
}

// The leading silence the next export will use: the live check times its
// issues the same way (a first note needs an empty first phrase before it).
export function rsLeadIn() {
  let stored = null;
  try { stored = localStorage.getItem(LS_LEAD_IN); } catch { /* storage blocked: the default */ }
  return leadIn(stored);
}

