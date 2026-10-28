import { WHAMMY_TAG } from "./whammy.js";

// Note-attached metadata shared by editing, references, tracing, and export.
// Keep this module DOM-free so copying/signature behavior can be tested directly.

// Everything copy/paste, references and undo carry along with a note.
export const EFFECT_FIELDS = [
  "slide", "fx", "bend", "bendPoints", "harmonic", "grace", "trill", "tremPick", "slap",
  "stroke", "whammy", "pos", "arrangement", "slideStart", "vibratoStart", "slideEnd", "slideFrets",
  // How Rocksmith draws the chord the note is in: "full" or "repeat" (chart._chord_display).
  // Not in the signatures below: Guitar Pro has no such thing, so changing it must
  // not take a note off the source-preserving Guitar Pro path.
  "chordDisplay",
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
// here (or to LATE_SIGNATURE_FIELDS).
export const SIGNATURE_EFFECT_FIELDS = [
  "slide", "bend", "bendPoints", "harmonic", "grace", "trill", "tremPick",
  "slap", "stroke", "whammy", "fx",
];
// Fields added after projects already stored signatures. They join the signature
// only when set, so a note without them hashes as it always did.
export const LATE_SIGNATURE_FIELDS = ["slideStart", "vibratoStart", "slideEnd", "slideFrets"];

// `{ slide: …, bend: …, … }` with an explicit null for anything absent, so a
// removed effect changes the signature as surely as an added one does. Three
// call sites in guitar-pro-core.js wrote this list out by hand.
export const effectSignatureFields = (note) => ({
  ...Object.fromEntries(SIGNATURE_EFFECT_FIELDS.map((key) => [key, note[key] ?? null])),
  ...Object.fromEntries(LATE_SIGNATURE_FIELDS.filter((key) => note[key] != null).map((key) => [key, note[key]])),
});

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

export const HARMONIC_TAG = { natural: "◎", pinch: "Pnch. harm." };

export const SLAP_TAG = { tap: "tap", slap: "slap", pop: "pop" };

// The compact text marks drawn above a note. Slide, bend and harmonic have their
// own shape renderers; everything else appears here as a tag.
// Whether a note shows and plays an fx flag. A Guitar Pro hammer "origin" is the
// note a hammer-on starts from: it is played normally, so it shows no hammer. The
// role stays stored for the voicer and the Guitar Pro export.
export const fxOn = (n, key) => key === "hammer"
  ? !!n?.fx?.hammer && n.fx.hammer !== "origin" : !!n?.fx?.[key];

// The value a flag gets switched on or off: a hammer keeps an imported origin role.
export const fxValue = (n, key, on) => key !== "hammer" ? (on || undefined)
  : on ? (n.fx?.hammer === "origin" ? "both" : n.fx?.hammer || true)
  : (n.fx?.hammer === "origin" || n.fx?.hammer === "both" ? "origin" : undefined);

export function noteMarks(n) {
  const m = [];
  if (n.fx) for (const k of FX_KEYS) if (fxOn(n, k)) m.push(FX_GLYPHS[k]);
  if (n.grace) m.push("Grace note");
  if (n.trill) m.push("Trill");
  if (n.tremPick) m.push("≣");
  if (n.slap) m.push(SLAP_TAG[n.slap]);
  if (n.stroke) m.push(n.stroke === "up" ? "⤴" : "⤵");
  if (WHAMMY_TAG[n.whammy]) m.push(WHAMMY_TAG[n.whammy]);
  return m;
}

export const hasNoteEffects = (n) => !!(n.slide || n.bend || n.harmonic || noteMarks(n).length);

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
