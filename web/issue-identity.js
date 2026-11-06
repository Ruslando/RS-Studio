// Saved ignore choices from versions that used display text or export codes.
// IDs describe conditions. Keep these aliases when wording changes.
const legacyIds = {
  "Note out of range": "editor.note.outOfRange",
  "Notes stacked on one pitch": "editor.note.stack",
  "Bend points at the same moment": "editor.note.bendStack",
  "Pick slide not in Rocksmith": "editor.import.pickSlide",
  "Harmonic type not in Rocksmith": "editor.import.harmonic",
  "Left-hand tap not in Rocksmith": "editor.import.leftTap",
  "Ornament not in Rocksmith": "editor.import.ornament",
  "Whammy vibrato not in Rocksmith": "editor.import.barVibrato",
  "Golpe not in Rocksmith": "editor.import.golpe",
  "Rasgueado not in Rocksmith": "editor.import.rasgueado",
  "Dead slapped not in Rocksmith": "editor.import.deadSlapped",
  "Ghost note not in Rocksmith": "editor.effect.ghost",
  "Staccato not in Rocksmith": "editor.effect.staccato",
  "Let ring not in Rocksmith": "editor.effect.letRing",
  "Strum not in Rocksmith": "editor.effect.strum",
  "Pick slide as a muted slide": "editor.adapt.pickSlide",
  "Ghost note is not scored": "editor.adapt.ghost",
  "Trill as hammer-ons and pull-offs": "editor.adapt.trill",
  "Grace note as a short lead-in": "editor.adapt.grace",
  "Whammy as slides": "editor.adapt.whammy",
  "Ornament as hammer-ons and pull-offs": "editor.adapt.ornament",
  "Artificial harmonic as pinch harmonic": "editor.adapt.artificial",
  "No reasonable shape found": "editor.shape.stretch",
  "No valid shape found": "editor.shape.impossible",
  "flag-anchor": "marker.anchor-out-of-reach",
  "flag-tone": "marker.tone-preset-missing",
  "not-exported": "export.compile-failed",
  "slide": "export.slide",
  "late-fx": "export.late-fx",
  "grace": "export.grace",
  "slide-in": "export.slide-in",
  "whammy": "export.whammy",
  "whammy-slide": "export.whammy-slide",
  "trill": "export.trill",
  "ornament": "export.ornament",
  "slide-open": "export.slide-open",
  "fret": "export.fret",
  "unvoiced": "export.unvoiced",
  "finger": "export.finger",
  "hand": "export.hand",
  "shape-grip": "export.shape-grip",
  "shape-mixed": "export.shape-mixed",
  "grip-only": "export.grip-only",
  "phrase-differs": "export.phrase-differs",
  "shape-hand": "export.shape-hand"
};
// Legacy warnings included values in their keys. Match the condition only.
const legacyWarnings = [
  [/^Tuning offset [+-]\d+ octave-reduced to [+-]\d+$/, 'export.tuning-octave'],
  [/^Low bass tuning: exported an octave up at a 220 Hz reference so Rocksmith detects it$/, 'export.bass-reference'],
  [/^Ignored unknown Rocksmith tone preset '/, 'export.tone-unknown'],
  [/^Ignored Rocksmith tone switch outside the song at /, 'export.tone-outside-song'],
  [/^Section '.*' is not recognized by Rocksmith and was exported as riff$/, 'export.section-unknown'],
  [/^Section '.*' was snapped to the nearest measure boundary$/, 'export.section-snapped'],
  [/^Multiple section markers resolved to /, 'export.section-collision'],
  [/^Phrase boundary at .* was snapped to the nearest beat$/, 'export.phrase-snapped'],
];
export const issueId = key => legacyIds[key] || legacyWarnings.find(([pattern]) => pattern.test(key))?.[1] || key;
export function migrateIgnoredIssues(keys) {
  const ids = new Set((keys || []).map(issueId));
  // Old I29 represented both an invalid chord and an export correction.
  if (ids.has('I29')) ids.add('export.chord-dead-note-removed');
  // The old compilation category covered all compilation failure conditions.
  if (ids.has('export.compile-failed')) for (const id of [
    'string-count', 'arrangement-tuning', 'tone-limit', 'beat-grid',
    'no-voiced-notes', 'note-limit',
  ]) ids.add(`export.${id}`);
  return ids;
}
