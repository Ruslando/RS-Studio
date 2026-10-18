import { SOUND_BASES } from "./sound-catalog.js";
import { TONE_CATALOG } from "./tone-gear.js";

export { SOUND_BASES, TONE_CATALOG };
export const cloneSound = value => JSON.parse(JSON.stringify(value));
export const SOUND_LIBRARY_KEY = "cw.soundPresets.v1";
export const MAX_EFFECTS = 4; // Rocksmith's in-game Tone Designer limit.
export const isSoundId = key => /^sound_[a-z0-9_-]{1,80}$/.test(key);
export const GEAR_DATA = Object.fromEntries(TONE_CATALOG.Gear.map(gear => [gear.Key, gear]));
export const DESCRIPTORS = TONE_CATALOG.Descriptors;
export const GEAR = Object.fromEntries(TONE_CATALOG.Gear.map(gear => [gear.Key, {
  Key: gear.Key, Type: gear.Type,
  KnobValues: Object.fromEntries((gear.Knobs || []).map(knob => [knob.Key, knob.DefaultValue])),
}]));
export const gearName = key => GEAR_DATA[key]?.Name.trim() || key;
export const knobDefinition = (key, deviceKey) => GEAR_DATA[deviceKey]?.Knobs?.find(knob => knob.Key === key);
export const knobName = (key, deviceKey) => knobDefinition(key, deviceKey)?.Name || key;
export function knobRange(key, deviceKey) {
  const knob = knobDefinition(key, deviceKey);
  return knob ? [knob.MinValue, knob.MaxValue, knob.ValueStep] : null;
}
export const gearInstrument = key => key.startsWith("Bass_") || key === "DI_Amp_BassDriver" ? "Bass" : key.startsWith("DI_") ? "Direct" : "Guitar";
export const slotPrefix = slot => slot.replace(/\d+$/, "");
export const slotType = slot => slot === "Amp" ? "Amps" : slot === "Cabinet" ? "Cabinets" : slot.startsWith("Rack") ? "Racks" : "Pedals";
export const slotLabel = slot => slot === "Amp" ? "Amplifier" : slot === "Cabinet" ? "Cabinet" : slot.replace("PrePedal", "Pre-amp pedal ").replace("PostPedal", "Loop effect ").replace("Rack", "Rack effect ");
export function knobValueValid(knob, value) {
  return typeof value === "number" && Number.isFinite(value) && value >= knob.MinValue && value <= knob.MaxValue
    && (!knob.EnumValues || Number.isInteger(value));
}
export function knobUnit(knob) {
  return { db: "dB", hz: "Hz", khz: "kHz", ms: "ms", "%": "%" }[knob.UnitType]
    || (/^Pitch\b/.test(knob.Name) ? "st" : knob.Name === "Bit Depth" ? "bit" : "");
}
export function formatKnob(knob, value) {
  if (knob.EnumValues) return knob.EnumValues[value - knob.MinValue] ?? String(value);
  const unit = knobUnit(knob);
  return `${value}${unit ? ` ${unit}` : ""}`;
}
export function soundVolumeValid(value) {
  return (typeof value === "number" || typeof value === "string" && value.trim() !== "")
    && Number.isFinite(Number(value)) && Number(value) >= -36 && Number(value) <= 12;
}

export const MAX_PRESET_FILE_BYTES = 1024 * 1024;
export function parsePresetJSON(text) {
  let raw;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new Error("The file is not valid JSON"); }
  let list;
  if (raw?.format === "rs-studio.sound-presets") {
    if (raw.version !== 1) throw new Error("Unsupported preset library version");
    list = raw.presets;
  } else list = Array.isArray(raw) ? raw : [raw];
  if (!Array.isArray(list) || !list.length || list.length > 100) throw new Error("Choose a tone or a library containing 1–100 presets");
  return list.map((entry, index) => {
    const tone = normalizeSound(entry?.tone ?? entry);
    if (!tone) throw new Error(`Preset ${index + 1} has unsupported gear, missing parameters or invalid values`);
    return tone;
  });
}
export function presetJSON(tones, { library = false } = {}) {
  if (tones.length > 100) throw new Error("Export at most 100 presets per library file");
  const normalized = tones.map(tone => normalizeSound(tone));
  if (!normalized.length || normalized.some(tone => !tone)) throw new Error("Correct the preset values before exporting");
  const data = library ? { format: "rs-studio.sound-presets", version: 1, presets: normalized } : normalized[0];
  return JSON.stringify(data, null, 2) + "\n";
}
export function presetFingerprint(tone) {
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  const normalized = normalizeSound(tone);
  return JSON.stringify(sort(normalized ? { ...normalized, Name: "" } : null));
}

let folderPresets = [], folderLoad = 0;
export async function loadPresetFolderData() {
  const request = ++folderLoad;
  const response = await fetch("/api/sound-presets");
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || "The preset folder could not be read");
  const presets = await Promise.all((data.presets || []).map(async entry => {
    const tone = normalizeSound(entry.tone);
    if (!tone || typeof entry.id !== "string") throw new Error("The folder contains an unsupported preset");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(entry.id));
    const id = "sound_file_" + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return { id, fileId: entry.id, tone };
  }));
  if (request === folderLoad) {
    folderPresets = presets;
    window.dispatchEvent(new Event("sound-presets-changed"));
  }
  return data;
}
export function readAvailableSoundPresets() { return [...folderPresets, ...readSoundLibrary()]; }

// Old finite values are retained for explicit repair on load, never clamped.
export function normalizeSound(raw, { allowOutOfRange = false } = {}) {
  if (!raw || typeof raw !== "object" || !raw.GearList || Array.isArray(raw.GearList)) return null;
  const name = typeof raw.Name === "string" ? raw.Name.trim() : "";
  const volume = Number(raw.Volume);
  if (!name || name.length > 80 || !soundVolumeValid(raw.Volume)) return null;
  const gear = {};
  let effects = 0;
  for (const [slot, device] of Object.entries(raw.GearList)) {
    if (!/^(Amp|Cabinet|PrePedal[1-4]|PostPedal[1-4]|Rack[1-4])$/.test(slot)) return null;
    const definition = GEAR_DATA[device?.Key];
    if (!definition || definition.Type !== slotType(slot) || !device.KnobValues || typeof device.KnobValues !== "object" || Array.isArray(device.KnobValues)) return null;
    const knobs = {}, definitions = definition.Knobs || [];
    if (Object.keys(device.KnobValues).some(key => !definitions.some(knob => knob.Key === key))) return null;
    for (const knob of definitions) {
      const value = device.KnobValues[knob.Key];
      if (typeof value !== "number" || !Number.isFinite(value) || (!allowOutOfRange && !knobValueValid(knob, value))) return null;
      knobs[knob.Key] = value;
    }
    gear[slot] = { Key: definition.Key, Type: definition.Type, KnobValues: knobs };
    if (typeof device.Category === "string") gear[slot].Category = device.Category;
    if (typeof device.Skin === "string") gear[slot].Skin = device.Skin;
    if (Number.isFinite(device.SkinIndex)) gear[slot].SkinIndex = device.SkinIndex;
    if (slot !== "Amp" && slot !== "Cabinet") effects++;
  }
  if (!gear.Amp || !gear.Cabinet || effects > MAX_EFFECTS) return null;
  for (const prefix of ["PrePedal", "PostPedal", "Rack"]) {
    const slots = Object.keys(gear).filter(slot => slot.startsWith(prefix)).sort();
    if (slots.some((slot, i) => slot !== `${prefix}${i + 1}`)) return null;
  }
  const descriptions = raw.ToneDescriptors;
  if (!Array.isArray(descriptions) || !descriptions.length || descriptions.length > 3
    || descriptions.some(value => !DESCRIPTORS.some(description => description.UIName === value))) return null;
  const result = { GearList: gear, Name: name, Key: "Custom", Volume: String(volume),
    ToneDescriptors: [...descriptions], NameSeparator: typeof raw.NameSeparator === "string" ? raw.NameSeparator : " - " };
  if (raw.MacVolume != null) {
    const macVolume = Number(raw.MacVolume);
    if (!soundVolumeValid(raw.MacVolume)) return null;
    result.MacVolume = String(macVolume);
  }
  return result;
}

export function effectBank(gear, prefix) {
  return Object.keys(gear).filter(slot => slot.startsWith(prefix)).sort().map(slot => gear[slot]);
}
function setBank(gear, prefix, bank) {
  for (let i = 1; i <= 4; i++) delete gear[`${prefix}${i}`];
  bank.forEach((device, i) => { gear[`${prefix}${i + 1}`] = device; });
}
export function removeEffect(gear, slot) {
  if (!gear[slot] || !/^(PrePedal|PostPedal|Rack)[1-4]$/.test(slot)) return false;
  const prefix = slotPrefix(slot), bank = effectBank(gear, prefix);
  bank.splice(Number(slot.at(-1)) - 1, 1); setBank(gear, prefix, bank); return true;
}
export function moveEffect(gear, slot, direction) {
  if (![-1, 1].includes(direction) || !/^(PrePedal|PostPedal|Rack)[1-4]$/.test(slot)) return slot;
  const prefix = slotPrefix(slot), bank = effectBank(gear, prefix), index = Number(slot.at(-1)) - 1;
  const target = index + direction;
  if (!bank[index] || target < 0 || target >= bank.length) return slot;
  [bank[index], bank[target]] = [bank[target], bank[index]]; setBank(gear, prefix, bank);
  return `${prefix}${target + 1}`;
}
export function relocateEffect(gear, slot, prefix) {
  if (!gear[slot] || !/^(PrePedal|PostPedal|Rack)[1-4]$/.test(slot) || !["PrePedal", "PostPedal", "Rack"].includes(prefix)) return slot;
  if (slotPrefix(slot) === prefix || (prefix === "Rack") !== (slotPrefix(slot) === "Rack")) return slot;
  const bank = effectBank(gear, prefix);
  if (bank.length >= 4) return slot;
  const device = gear[slot]; removeEffect(gear, slot); bank.push(device); setBank(gear, prefix, bank);
  return `${prefix}${bank.length}`;
}

// Insert before a bank index (or at its end), preserving device objects/values.
export function insertEffect(gear, slot, prefix, index) {
  if (!gear[slot] || !/^(PrePedal|PostPedal|Rack)[1-4]$/.test(slot)
    || !["PrePedal", "PostPedal", "Rack"].includes(prefix)
    || (prefix === "Rack") !== (slotPrefix(slot) === "Rack")) return slot;
  const source = slotPrefix(slot), sourceIndex = Number(slot.at(-1)) - 1;
  const bank = effectBank(gear, prefix);
  if (!Number.isInteger(index) || index < 0 || index > bank.length) return slot;
  const device = gear[slot];
  if (source === prefix) {
    bank.splice(sourceIndex, 1);
    if (index > sourceIndex) index--;
  } else {
    if (bank.length >= MAX_EFFECTS) return slot;
    removeEffect(gear, slot);
  }
  bank.splice(index, 0, device); setBank(gear, prefix, bank);
  return `${prefix}${index + 1}`;
}

export function readSoundLibraryState(storage) {
  let raw = null;
  try {
    storage ||= globalThis.localStorage;
    raw = storage.getItem(SOUND_LIBRARY_KEY);
    const list = JSON.parse(raw ?? "[]");
    if (!Array.isArray(list)) throw new Error("The saved preset library is not a list");
    const presets = [], unavailable = [], ids = new Set();
    for (const entry of list) {
      const tone = isSoundId(entry?.id) && !ids.has(entry.id) ? normalizeSound(entry.tone, { allowOutOfRange: true }) : null;
      if (tone) { presets.push({ id: entry.id, tone }); ids.add(entry.id); }
      else unavailable.push(entry);
    }
    return { presets, unavailable, raw, error: null };
  } catch (error) { return { presets: [], unavailable: [], raw, error }; }
}
export function readSoundLibrary(storage) { return readSoundLibraryState(storage).presets; }
export function writeSoundLibrary(presets, snapshot, storage = globalThis.localStorage) {
  if (snapshot.error) throw new Error("The saved preset library could not be read. Existing data has been kept.");
  if (storage.getItem(SOUND_LIBRARY_KEY) !== snapshot.raw) throw new Error("Presets changed in another window. Reopen Settings before saving to avoid overwriting those changes.");
  // Keep unsupported or damaged entries intact for recovery or a newer app.
  const originalIds = new Set(snapshot.presets.map(entry => entry.id));
  const savedIds = new Set(presets.map(entry => entry.id));
  const unavailable = snapshot.unavailable.filter(entry => !originalIds.has(entry?.id) || savedIds.has(entry.id));
  storage.setItem(SOUND_LIBRARY_KEY, JSON.stringify([...presets, ...unavailable]));
}
