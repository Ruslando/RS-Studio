import { isSoundId, normalizeSound } from "./sound-presets-core.js";
// Per-lane amp tone-switch timeline data. Custom markers embed a native tone
// snapshot, so projects remain portable and library edits never rewrite songs.

export const INTERNAL_TONE_PRESETS = [
  ["lead", "Lead"],
  ["clean", "Clean"],
  ["crunch", "Crunch"],
  ["bass", "Bass"],
];

const PRESET_KEYS = new Set(INTERNAL_TONE_PRESETS.map(([key]) => key));

export function tonePresetLabel(key, toneData = null) {
  if (isSoundId(key) && toneData?.Name) return toneData.Name;
  return INTERNAL_TONE_PRESETS.find(([value]) => value === key)?.[1] || "Lead";
}

export function normalizeToneMarkers(markers, duration = Infinity) {
  const limit = Number.isFinite(Number(duration)) ? Math.max(0, Number(duration)) : Infinity;
  const out = [];
  for (const [index, raw] of (Array.isArray(markers) ? markers : []).entries()) {
    const t = Number(raw?.t ?? raw?.seconds);
    const tone = String(raw?.tone || raw?.preset || "").trim().toLowerCase();
    const toneData = isSoundId(tone) ? normalizeSound(raw.toneData, { allowOutOfRange: true }) : null;
    if (!Number.isFinite(t) || (!PRESET_KEYS.has(tone) && !toneData)) continue;
    out.push({
      id: String(raw?.id || `tone_${index}_${Math.round(Math.max(0, t) * 1000)}`),
      t: Math.max(0, Math.min(limit, t)),
      tone,
      ...(toneData ? { toneData } : {}),
    });
  }
  out.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  return out.filter((marker, index) => !index || Math.abs(marker.t - out[index - 1].t) > 1e-6);
}

// EVERY LANE STARTS ON A TONE, and says which. A lane with no marker at its very
// start gets one: crunch for a guitar part, lead or rhythm alike, and clean for a
// bass. It is an ordinary marker — click it to pick another preset — and it is what
// the Rocksmith export reads as the arrangement's base tone, so the tone a song
// starts on is on the rail to be seen instead of being a default buried in the
// exporter (which keeps the same two answers for a spec that arrives without one).
export const startTone = (lane) =>
  (/bass/i.test(lane?.rocksmithArrangement || "") || (!lane?.rocksmithArrangement && /bass/i.test(lane?.instrument || ""))
    ? "clean" : "crunch");

export function withStartTone(markers, lane) {
  const list = Array.isArray(markers) ? markers : [];
  return list.some((marker) => Number(marker.t) <= 1e-6)
    ? list : [{ id: "tone_start", t: 0, tone: startTone(lane) }, ...list];
}
