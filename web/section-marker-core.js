// Pure section-marker model shared by persistence, Guitar Pro projection, and
// the timeline UI. Section markers are audio-time annotations; exporters map
// them onto their target's bar/phrase boundaries.

export const SECTION_TYPES = [
  ["riff", "Riff"],
  ["intro", "Intro"],
  ["outro", "Outro"],
  ["verse", "Verse"],
  ["chorus", "Chorus"],
  ["bridge", "Bridge"],
  ["solo", "Solo"],
  ["ambient", "Ambient"],
  ["breakdown", "Breakdown"],
  ["interlude", "Interlude"],
  ["prechorus", "Pre Chorus"],
  ["transition", "Transition"],
  ["postchorus", "Post Chorus"],
  ["hook", "Hook"],
  ["fadein", "Fade In"],
  ["fadeout", "Fade Out"],
  ["buildup", "Buildup"],
  ["preverse", "Pre Verse"],
  ["modverse", "Modulated Verse"],
  ["postvs", "Post Verse"],
  ["variation", "Variation"],
  ["modchorus", "Modulated Chorus"],
  ["head", "Head"],
  ["modbridge", "Modulated Bridge"],
  ["melody", "Melody"],
  ["postbrdg", "Post Bridge"],
  ["prebrdg", "Pre Bridge"],
  ["vamp", "Vamp"],
  ["noguitar", "No Guitar"],
  ["silence", "Silence"],
  ["tapping", "Tapping"],
];

// Keep the full list above so imported charts round-trip their original type,
// but expose only the common, beginner-friendly subset in the marker editor.
export const SECTION_GROUPS = [
  ["Main song parts", [
    ["intro", "Intro"],
    ["verse", "Verse"],
    ["bridge", "Bridge"],
    ["solo", "Solo"],
    ["outro", "Outro"],
  ]],
  ["Chorus family", [
    ["prechorus", "Pre Chorus"],
    ["chorus", "Chorus"],
    ["postchorus", "Post Chorus"],
  ]],
  ["Other passages", [
    ["riff", "Riff / general passage"],
    ["hook", "Hook"],
    ["breakdown", "Breakdown"],
    ["interlude", "Interlude"],
    ["buildup", "Buildup"],
    ["transition", "Transition"],
  ]],
  ["Special", [
    ["noguitar", "No Guitar"],
  ]],
];

export const SECTION_HELP = {
  intro: "The opening part before the main verse or riff begins.",
  outro: "The final passage after the last chorus or verse.",
  verse: "A main song passage where lyrics usually change each time it returns.",
  chorus: "The recurring main hook or refrain, usually the most recognizable part.",
  bridge: "A contrasting passage that connects major parts of the song.",
  solo: "A featured instrumental solo.",
  ambient: "A spacious or atmospheric passage with little rhythmic movement.",
  breakdown: "A stripped-down, heavy, or rhythm-focused passage.",
  interlude: "A short instrumental passage between larger sections.",
  prechorus: "A build-up immediately before a chorus.",
  transition: "A short connecting passage that does not need a more specific name.",
  postchorus: "A short recurring passage immediately after a chorus.",
  hook: "A short, memorable musical idea that repeats.",
  riff: "A repeated instrumental figure.",
  fadein: "The opening passage while the music gradually becomes louder.",
  fadeout: "The ending passage while the music gradually becomes quieter.",
  buildup: "A passage that increases energy or tension before the next section.",
  preverse: "A short lead-in immediately before a verse.",
  modverse: "A verse repeated with a noticeable musical or key change.",
  postvs: "A short passage immediately after a verse.",
  variation: "A changed version of an earlier passage.",
  modchorus: "A chorus repeated with a noticeable musical or key change.",
  head: "The main melody of a jazz-style piece, often heard at the start and end.",
  modbridge: "A bridge repeated with a noticeable musical or key change.",
  melody: "A passage centered on a lead melody rather than a solo.",
  postbrdg: "A short passage immediately after a bridge.",
  prebrdg: "A short lead-in immediately before a bridge.",
  vamp: "A short chord or riff pattern repeated for an extended time.",
  noguitar: "A passage with no playable guitar part; practice tools usually skip it.",
  silence: "A deliberately silent passage.",
  tapping: "A passage primarily played with fretboard tapping.",
};

const TYPE_LABELS = new Map(SECTION_TYPES);
const compact = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
const TYPE_ALIASES = new Map(SECTION_TYPES.flatMap(([key, label]) => [
  [compact(key), key], [compact(label), key],
]));

export function validSectionType(value, fallback = "riff") {
  const key = compact(value);
  return TYPE_ALIASES.get(key) || TYPE_ALIASES.get(key.replace(/\d+$/, "")) || fallback;
}

export function sectionTypeLabel(value) {
  const key = validSectionType(value);
  return TYPE_LABELS.get(key) || "Riff";
}

export function normalizeSectionMarkers(markers, duration = Infinity) {
  const limit = Number.isFinite(Number(duration)) ? Math.max(0, Number(duration)) : Infinity;
  const out = [];
  for (const [index, raw] of (Array.isArray(markers) ? markers : []).entries()) {
    const t = Number(raw?.t ?? raw?.seconds);
    if (!Number.isFinite(t)) continue;
    const text = String(raw?.text || raw?.name || raw?.marker || "").trim();
    if (!text) continue;
    // A marker with no stored type infers one from its own text, which is also
    // what recovers the type on a project saved before the field was renamed:
    // the old key is no longer read, and every marker in the projects that had
    // one was named after its section, so the text answers the same question.
    const inferred = validSectionType(raw?.sectionType || text);
    const marker = String(raw?.marker || "").trim();
    out.push({
      id: String(raw?.id || `section_${index}_${Math.round(Math.max(0, t) * 1000)}`),
      t: Math.max(0, Math.min(limit, t)),
      text,
      marker,
      sectionType: inferred,
      custom: raw?.custom == null ? compact(text) !== compact(sectionTypeLabel(inferred)) : !!raw.custom,
    });
  }
  out.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  return out;
}

export function normalizePhraseBoundaries(boundaries, duration = Infinity) {
  const limit = Number.isFinite(Number(duration)) ? Math.max(0, Number(duration)) : Infinity;
  const out = [];
  for (const [index, raw] of (Array.isArray(boundaries) ? boundaries : []).entries()) {
    const t = Number(raw?.t ?? raw?.seconds ?? raw);
    if (!Number.isFinite(t)) continue;
    out.push({
      id: String(raw?.id || `phrase_${index}_${Math.round(Math.max(0, t) * 1000)}`),
      t: Math.max(0, Math.min(limit, t)),
    });
  }
  out.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  return out.filter((boundary, index) =>
    !index || Math.abs(boundary.t - out[index - 1].t) > 1e-6);
}

export function beatStartsFromScoreBars(bars) {
  return (Array.isArray(bars) ? bars : []).flatMap((bar) => {
    const count = Math.max(1, Math.round(Number(bar?.timeSignatureNumerator) || 4));
    const step = (Number(bar?.durationSeconds) || 0) / count;
    return step > 0
      ? Array.from({ length: count }, (_, index) => (Number(bar?.seconds) || 0) + index * step)
      : [Number(bar?.seconds) || 0];
  });
}

export function sectionMarkersFromScoreBars(bars) {
  const markers = [];
  for (const [index, bar] of (Array.isArray(bars) ? bars : []).entries()) {
    if (!bar?.section?.text && !bar?.section?.marker) continue;
    const text = String(bar.section.text || bar.section.marker).trim();
    const type = validSectionType(text);
    const recognized = TYPE_ALIASES.has(compact(text)) || TYPE_ALIASES.has(compact(text).replace(/\d+$/, ""));
    markers.push({
      id: `section_bar_${bar.id || bar.sourceIndex || index}`,
      t: Math.max(0, Number(bar.seconds) || 0),
      text,
      marker: String(bar.section.marker || "").trim(),
      sectionType: type,
      custom: !recognized,
    });
  }
  return normalizeSectionMarkers(markers);
}

// Assign each audio-time marker to the nearest target bar. Existing embedded
// sections are cleared so standalone sectionMarkers remain the one source of truth.
// Section markers live on audio time; every export target wants them on bar
// boundaries, so each one lands on the bar it is nearest. A bar holds at most one
// section, and two markers inside the same bar are reachable — by placing them
// close together, and by `normalizeSectionMarkers` clamping everything past the
// song's end to the same time. The loser used to be overwritten and the export
// came out silently short a section; it now moves to the next free bar and says
// so. Moving it forward rather than back keeps the sections in the order the
// user wrote them.
//
// Returns `{ bars, warnings }`. `applySectionMarkersToBars` is the bars-only
// wrapper for callers that have no way to show a warning.
export function assignSectionsToBars(bars, markers) {
  const out = (Array.isArray(bars) ? bars : []).map((bar) => ({ ...bar, section: null }));
  const warnings = [];
  if (!out.length) return { bars: out, warnings };
  for (const section of normalizeSectionMarkers(markers)) {
    let best = 0, distance = Infinity;
    for (let index = 0; index < out.length; index++) {
      const delta = Math.abs((Number(out[index].seconds) || 0) - section.t);
      if (delta < distance) { best = index; distance = delta; }
    }
    let target = best;
    while (target < out.length && out[target].section) target++;
    if (target >= out.length) {
      warnings.push(`Section “${section.text}” could not be placed: every bar from ${best + 1} on already has one.`);
      continue;
    }
    if (target !== best) {
      warnings.push(`Section “${section.text}” moved to bar ${target + 1}; bar ${best + 1} already has a section.`);
    }
    out[target].section = {
      marker: section.marker || section.text,
      text: section.text,
    };
  }
  return { bars: out, warnings };
}

export function applySectionMarkersToBars(bars, markers) {
  return assignSectionsToBars(bars, markers).bars;
}

export function sectionMarkersForExport(markers) {
  return normalizeSectionMarkers(markers).map(({ t, text, marker, sectionType }) => ({
    t, text, marker, sectionType,
  }));
}
