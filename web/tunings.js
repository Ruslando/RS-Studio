// Tuning presets: open-string MIDI in Guitar Pro order (string 1 = highest).
// The 6-string standard/drop presets step down chromatically E→D#→D→C#→C, each
// paired with its drop variant (lowest string dropped a further whole step) —
// the common metal/rock tuning ladder. Bass and 7-string follow the same ladder.
// `label` is shown inside an <optgroup> keyed by string count (see buildTuningOptions),
// so the instrument/count prefix lives on the group — options just name the variant.
// Keys of bass presets start with "bass": the tunings page reads the instrument from it.
export const TUNINGS = {
  bass4:   { label: "Standard (E A D G)",     tuning: [43, 38, 33, 28] },
  bass4_ds_standard: { label: "D# Standard (D# G# C# F#)", tuning: [42, 37, 32, 27] },
  bass4_d_standard:  { label: "D Standard (D G C F)",      tuning: [41, 36, 31, 26] },
  bass4_c_standard:  { label: "C Standard (C F A# D#)",    tuning: [39, 34, 29, 24] },
  bass4_drop_d:      { label: "Drop D (D A D G)",          tuning: [43, 38, 33, 26] },
  bass4_drop_c:      { label: "Drop C (C G C F)",          tuning: [41, 36, 31, 24] },
  bass4_drop_b:      { label: "Drop B (B F# B E)",         tuning: [40, 35, 30, 23] },
  bass5:   { label: "Standard (B E A D G)",   tuning: [43, 38, 33, 28, 23] },
  bass5_high_c:      { label: "High C (E A D G C)",        tuning: [48, 43, 38, 33, 28] },
  bass5_as_standard: { label: "A# Standard (A# D# G# C# F#)", tuning: [42, 37, 32, 27, 22] },
  bass5_a_standard:  { label: "A Standard (A D G C F)",    tuning: [41, 36, 31, 26, 21] },
  bass5_drop_a:      { label: "Drop A (A E A D G)",        tuning: [43, 38, 33, 28, 21] },
  guitar6: { label: "Standard (E A D G B E)", tuning: [64, 59, 55, 50, 45, 40] },
  guitar7: { label: "Standard (B E A D G B E)", tuning: [64, 59, 55, 50, 45, 40, 35] },
  guitar7_as_standard: { label: "A# Standard (A# D# G# C# F# A# D#)", tuning: [63, 58, 54, 49, 44, 39, 34] },
  guitar7_a_standard:  { label: "A Standard (A D G C F A D)",          tuning: [62, 57, 53, 48, 43, 38, 33] },
  guitar7_drop_a:      { label: "Drop A (A E A D G B E)",              tuning: [64, 59, 55, 50, 45, 40, 33] },
  guitar7_drop_gs:     { label: "Drop G# (G# D# G# C# F# A# D#)",      tuning: [63, 58, 54, 49, 44, 39, 32] },
  ds_standard: { label: "D# Standard (D# G# C# F# A# D#)", tuning: [63, 58, 54, 49, 44, 39] },
  d_standard:  { label: "D Standard (D G C F A D)",        tuning: [62, 57, 53, 48, 43, 38] },
  cs_standard: { label: "C# Standard (C# F# B E G# C#)",   tuning: [61, 56, 52, 47, 42, 37] },
  c_standard:  { label: "C Standard (C F A# D# G C)",      tuning: [60, 55, 51, 46, 41, 36] },
  drop_d:  { label: "Drop D (D A D G B E)",         tuning: [64, 59, 55, 50, 45, 38] },
  drop_cs: { label: "Drop C# (C# G# C# F# A# D#)",  tuning: [63, 58, 54, 49, 44, 37] },
  drop_c:  { label: "Drop C (C G C F A D)",         tuning: [62, 57, 53, 48, 43, 36] },
  drop_b:  { label: "Drop B (B F# B E G# C#)",      tuning: [61, 56, 52, 47, 42, 35] },
  drop_as: { label: "Drop A# (A# F A# D# G C)",     tuning: [60, 55, 51, 46, 41, 34] },
};
