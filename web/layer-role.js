// Tablature participation is independent of editor visibility and playback.
// Keep the compatibility default in one pure module so project migration and
// every output path agree without invoking the fingering engine.

export function inferTablatureEnabled(lane) {
  if (typeof lane?.tablatureEnabled === "boolean") return lane.tablatureEnabled;
  // Before the dedicated role existed, eye visibility was the output gate.
  // Copy that state once during migration; afterwards both controls diverge.
  //
  // A save this old could also be sniffed for a Kong piano transcription — every
  // note carried the name of the tool that made it, and a piano reference is never
  // a tab track. That was the only thing in the app that ever read `note.source`,
  // and it cost the field on every note in every project to keep. detect.js has set
  // the flag outright on a fresh Kong layer since the flag existed, so what it
  // covered was the window between two releases.
  return lane?.visible !== false;
}

export function isTablatureLane(lane) {
  if (lane?.rocksmithArrangement === "none") return false;
  return lane?.tablatureEnabled !== false;
}

// The editor eye is deliberately absent from this decision. Tablature preview
// follows the selected layer, including when that layer is hidden in the
// spectrogram, and renders nothing when the selected layer is reference-only.
export function selectedTablatureLane(lanes) {
  const selected = (lanes || []).find((lane) => lane.active) || null;
  return isTablatureLane(selected) ? selected : null;
}

export const RS_KIND_OPTIONS = [
  ["lead", "Lead"],
  ["rhythm", "Rhythm"],
  ["alt_lead", "Alt Lead"],
  ["alt_rhythm", "Alt Rhythm"],
  ["bonus_lead", "Bonus Lead"],
  ["bonus_rhythm", "Bonus Rhythm"],
  ["bass", "Bass"],
  ["alt_bass", "Alt Bass"],
  ["bonus_bass", "Bonus Bass"],
];

// The order a layer without an arrangement is given one: what a band has first
// (lead, rhythm, bass), then the rest of the list from the top.
const RS_KIND_ORDER = ["lead", "rhythm", "bass",
  ...RS_KIND_OPTIONS.map(([kind]) => kind).filter((kind) => !["lead", "rhythm", "bass"].includes(kind))];
const isRsKind = (kind) => RS_KIND_OPTIONS.some(([known]) => known === kind);
const isBassTuning = (tuning) => tuning.length === 4 || (tuning.length === 5 && Math.max(...tuning) < 52);

// A bass arrangement needs a bass neck and a guitar one a guitar neck: Rocksmith
// loads nothing else, so a kind that does not fit is never offered or assigned.
export const rsKindFits = (kind, tuning) => kind.includes("bass") === isBassTuning(tuning || []);

// The first free kind for this neck. The export dialog uses it for a layer that
// has none of its own (tablature switched off, ticked there anyway).
export function defaultRsKind(track, used) {
  if (isRsKind(track.arrangement)) {
    used.add(track.arrangement);
    return track.arrangement;
  }
  const order = RS_KIND_ORDER.filter((kind) => rsKindFits(kind, track.tuning));
  const kind = order.find((k) => !used.has(k)) || order[0];
  used.add(kind);
  return kind;
}

// EVERY LAYER HAS ONE ARRANGEMENT, AND NO TWO THE SAME. A layer keeps the one it
// has while it is free and fits its neck; a layer without one (new, or from a
// project saved when "Auto" existed), with one another layer holds already, or
// with one its neck cannot play, takes the first free in RS_KIND_ORDER. When the
// game has no kind left for it, it is "none": not exported.
//
// The staves of one Guitar Pro track are one part and share theirs. Returns true
// when a layer changed.
export function assignRsKinds(lanes, tuningOf) {
  const partOf = (lane) => (lane.sourceTrackIndex == null ? lane : `track:${lane.sourceTrackIndex}`);
  const kinds = new Map(), used = new Set(), waiting = [];
  for (const lane of lanes) {
    const part = partOf(lane), kind = lane.rocksmithArrangement;
    if (kinds.has(part)) continue;
    if (kind === "none" || (kind == null && lane.tablatureEnabled === false)) kinds.set(part, "none");
    else if (isRsKind(kind) && rsKindFits(kind, tuningOf(lane)) && !used.has(kind)) { kinds.set(part, kind); used.add(kind); }
    else { kinds.set(part, null); waiting.push(lane); }
  }
  for (const lane of waiting) {
    const kind = RS_KIND_ORDER.find((k) => rsKindFits(k, tuningOf(lane)) && !used.has(k)) || "none";
    kinds.set(partOf(lane), kind);
    used.add(kind);
  }
  let changed = false;
  for (const lane of lanes) {
    const kind = kinds.get(partOf(lane));
    if (lane.rocksmithArrangement === kind) continue;
    lane.rocksmithArrangement = kind;
    if (kind === "none") lane.tablatureEnabled = false;
    changed = true;
  }
  return changed;
}
