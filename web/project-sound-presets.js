import { cloneSound, normalizeSound, readAvailableSoundPresets } from './sound-presets-core.js';

// Only unavailable imported tones are project-local. Available tones are app
// references and never appear here, even if an imported file carried a definition.
export function projectSoundPresets(state, presets = readAvailableSoundPresets()) {
  const groups = new Map();
  for (const lane of state?.editLanes || []) for (const marker of lane.toneMarkers || []) {
    if (presets.some(preset => preset.id === marker.tone)) continue;
    const tone = normalizeSound(marker.toneData, { allowOutOfRange: true });
    if (!tone) continue;
    const source = JSON.stringify(tone), key = JSON.stringify([marker.tone, source]);
    if (!groups.has(key)) groups.set(key, {
      id: `project:${lane.id}:${marker.id}`, presetId: marker.tone, tone,
      source, targets: [],
    });
    groups.get(key).targets.push({ lane: lane.id, marker: marker.id });
  }
  return [...groups.values()];
}

export const projectSoundDirty = entries => entries.some(entry => JSON.stringify(entry.tone) !== entry.source);

// Validate every target before committing anything, including library edits.
export function prepareProjectSoundEdits(entries, state, presets = readAvailableSoundPresets()) {
  const changes = [];
  for (const entry of entries) {
    if (JSON.stringify(entry.tone) === entry.source) continue;
    if (presets.some(preset => preset.id === entry.presetId)) {
      throw new Error('This preset now exists in the app library. Reopen the designer');
    }
    const tone = normalizeSound(entry.tone);
    if (!tone) throw new Error('Correct the project preset values before applying');
    for (const target of entry.targets) {
      const lane = state?.editLanes?.find(lane => lane.id === target.lane);
      const marker = lane?.toneMarkers?.find(marker => marker.id === target.marker);
      const current = normalizeSound(marker?.toneData, { allowOutOfRange: true });
      if (!marker || marker.tone !== entry.presetId || JSON.stringify(current) !== entry.source) {
        throw new Error('Project tone switches changed. Reopen the designer before applying');
      }
      changes.push({ marker, tone, entry });
    }
  }
  return () => {
    for (const { marker, tone, entry } of changes) {
      marker.toneData = cloneSound(tone);
      entry.tone = cloneSound(tone);
    }
    for (const entry of entries) entry.source = JSON.stringify(entry.tone);
    return changes.length;
  };
}
