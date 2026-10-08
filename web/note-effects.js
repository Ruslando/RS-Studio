// Note-attached metadata shared by editing, references, tracing, and export.
// Keep this module DOM-free so copying/signature behavior can be tested directly.

// Everything copy/paste, references and undo carry along with a note.
export const EFFECT_FIELDS = [
  "slide", "fx", "bend", "bendPoints", "harmonic", "grace", "trill", "tremPick", "slap",
  "stroke", "whammy", "pos", "arrangement",
];

// The subset that goes into a change-detection signature — EFFECT_FIELDS minus
// `pos` and `arrangement`, which every caller spells out separately because they
// carry string/fret rather than an effect.
//
// TWO THINGS ARE LOAD-BEARING HERE.
//
// The ORDER: a signature is a hash of JSON.stringify over these keys, and a
// project stores the signature it was imported with. Reordering this list makes
// every previously-imported project compare unequal and fall off the
// source-preserving export path.
//
// The COMPLETENESS: an effect missing from this list is invisible to change
// detection, so editing it looks like no edit at all and a source-preserving
// export silently drops it. Add an effect to EFFECT_FIELDS and you must add it
// here — `tests/layer-role.test.mjs` fails if you don't.
export const SIGNATURE_EFFECT_FIELDS = [
  "slide", "bend", "bendPoints", "harmonic", "grace", "trill", "tremPick",
  "slap", "stroke", "whammy", "fx",
];

// `{ slide: …, bend: …, … }` with an explicit null for anything absent, so a
// removed effect changes the signature as surely as an added one does. Three
// call sites in guitar-pro-core.js wrote this list out by hand.
export const effectSignatureFields = (note) =>
  Object.fromEntries(SIGNATURE_EFFECT_FIELDS.map((key) => [key, note[key] ?? null]));

// ---- the effect vocabulary ----
// Boolean articulations live as flags in note.fx; tab.py maps each to the
// matching Guitar Pro NoteEffect. Adding one means: a key here, a label, a
// glyph, the Guitar Pro mapping in tab.py, and a conflict rule in effects.js if
// it physically fights another.
export const FX_KEYS = ["hammer", "palmMute", "ghost", "letRing", "vibrato", "staccato", "accent", "dead"];

// Every flag above is a plain boolean except `hammer`, which carries which END of
// the hammer-on/pull-off a note is: "origin", "dest" or "both" when it came from a
// Guitar Pro import, and plain `true` when the user toggled it (the editor has no
// way to author a role). Always truthy, so every reader that only asks "is there
// one" is unaffected; only the voicer looks at the value, to tell a real pair from
// two adjacent notes that happen to end and begin two different runs.

export const FX_LABELS = {
  hammer: "Hammer-on / pull-off", palmMute: "Palm mute",
  ghost: "Ghost note", letRing: "Let ring", vibrato: "Vibrato",
  staccato: "Staccato", accent: "Accent", dead: "Dead / muted note",
};

export const FX_GLYPHS = { hammer: "H", palmMute: "PM", ghost: "( )", letRing: "LR", vibrato: "~", staccato: "·", accent: ">", dead: "X" };

export const HARMONIC_TAG = { natural: "◇", pinch: "P.H." };

export const SLAP_TAG = { tap: "tap", slap: "slap", pop: "pop" };

// The compact text marks drawn above a note. Slide, bend and harmonic have their
// own shape renderers; everything else appears here as a tag.
export function noteMarks(n) {
  const m = [];
  if (n.fx) for (const k of FX_KEYS) if (n.fx[k]) m.push(FX_GLYPHS[k]);
  if (n.grace) m.push("gr");
  if (n.trill) m.push("tr");
  if (n.tremPick) m.push("≣");
  if (n.slap) m.push(SLAP_TAG[n.slap]);
  if (n.stroke) m.push(n.stroke === "up" ? "⤴" : "⤵");
  if (n.whammy) m.push("w");
  return m;
}

export const cloneFx = (fx) => (fx ? { ...fx } : undefined);

export const cloneArrangement = (arrangement) => {
  if (!arrangement) return undefined;
  return {
    ...arrangement,
    notes: Array.isArray(arrangement.notes)
      ? arrangement.notes.map((note) => ({ ...note }))
      : arrangement.notes,
  };
};

// Copy a note's present effects onto `dst`; nested mutable values are cloned so
// reference siblings and clipboard copies never share override objects.
export function copyEffects(src, dst = {}) {
  for (const key of EFFECT_FIELDS) {
    if (src[key] == null) continue;
    if (key === "fx") dst[key] = cloneFx(src[key]);
    else if (key === "bendPoints") dst[key] = src[key].map((point) => [...point]);
    else if (key === "pos") dst[key] = { ...src[key] };
    else if (key === "arrangement") dst[key] = cloneArrangement(src[key]);
    else dst[key] = src[key];
  }
  return dst;
}
