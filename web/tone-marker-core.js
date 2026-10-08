// Per-lane amp tone-switch timeline data. Presets are intentionally
// internal for now; a future tone designer can extend this catalog without
// changing saved marker data.

export const INTERNAL_TONE_PRESETS = [
  ["lead", "Lead"],
  ["clean", "Clean"],
  ["crunch", "Crunch"],
  ["bass", "Bass"],
];

const PRESET_KEYS = new Set(INTERNAL_TONE_PRESETS.map(([key]) => key));

export function tonePresetLabel(key) {
  return INTERNAL_TONE_PRESETS.find(([value]) => value === key)?.[1] || "Lead";
}

export function normalizeToneMarkers(markers, duration = Infinity) {
  const limit = Number.isFinite(Number(duration)) ? Math.max(0, Number(duration)) : Infinity;
  const out = [];
  for (const [index, raw] of (Array.isArray(markers) ? markers : []).entries()) {
    const t = Number(raw?.t ?? raw?.seconds);
    const tone = String(raw?.tone || raw?.preset || "").trim().toLowerCase();
    if (!Number.isFinite(t) || !PRESET_KEYS.has(tone)) continue;
    out.push({
      id: String(raw?.id || `tone_${index}_${Math.round(Math.max(0, t) * 1000)}`),
      t: Math.max(0, Math.min(limit, t)),
      tone,
    });
  }
  out.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  return out.filter((marker, index) => !index || Math.abs(marker.t - out[index - 1].t) > 1e-6);
}
