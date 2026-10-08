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
