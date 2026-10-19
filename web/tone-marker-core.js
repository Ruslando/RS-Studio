import { cloneSound, isSoundId, normalizeSound, readAvailableSoundPresets } from "./sound-presets-core.js";
// Available app presets are references. Only unavailable imported tones carry
// project-local definitions.

export function tonePresetMissing(key, presets = readAvailableSoundPresets(), toneData = null) {
  return !presets.some(preset => preset.id === key) && !normalizeSound(toneData, { allowOutOfRange: true });
}

export function tonePresetLabel(key, toneData = null, presets = null) {
  return (presets || readAvailableSoundPresets()).find(preset => preset.id === key)?.tone.Name || toneData?.Name || key || "Missing preset";
}

export function normalizeToneMarkers(markers, duration = Infinity, presets = readAvailableSoundPresets()) {
  const limit = Number.isFinite(Number(duration)) ? Math.max(0, Number(duration)) : Infinity;
  const out = [];
  for (const [index, raw] of (Array.isArray(markers) ? markers : []).entries()) {
    const t = Number(raw?.t ?? raw?.seconds);
    const tone = String(raw?.tone || raw?.preset || "").trim().toLowerCase();
    const available = presets.some(preset => preset.id === tone);
    const toneData = !available && isSoundId(tone) ? normalizeSound(raw.toneData, { allowOutOfRange: true }) : null;
    if (!Number.isFinite(t) || !tone) continue;
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

// Materialize references only at export boundaries, without changing the project.
export function toneMarkersForExport(markers, presets = readAvailableSoundPresets()) {
  return (markers || []).map(marker => {
    const tone = presets.find(preset => preset.id === marker.tone)?.tone || marker.toneData;
    return { ...marker, ...(tone ? { toneData: cloneSound(tone) } : {}) };
  });
}

// New lanes use a current library preset. Existing references are never mapped
// to replacement presets, including references to removed built-in tones.
export function startTone(lane, presets = readAvailableSoundPresets()) {
  const bass = /bass/i.test(lane?.rocksmithArrangement || "")
    || (!lane?.rocksmithArrangement && /bass/i.test(lane?.instrument || ""));
  const file = bass ? "file:bass-clean.json" : "file:guitar-crunch.json";
  return presets.find(preset => preset.fileId === file)?.id
    || presets.find(preset => /^(Bass_|DI_Amp_BassDriver)/.test(preset.tone.GearList.Amp.Key) === !!bass)?.id || null;
}

export function withStartTone(markers, lane, presets = readAvailableSoundPresets(), at = 0) {
  const list = Array.isArray(markers) ? markers : [];
  if (list.some(marker => Number(marker.t) <= at + 1e-6)) return list;
  const tone = startTone(lane, presets);
  const preset = presets.find(entry => entry.id === tone);
  return preset ? [{ id: "tone_start", t: at, tone }, ...list] : list;
}
