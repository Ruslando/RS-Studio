import assert from "node:assert/strict";
import { SOUND_BASES, GEAR, GEAR_DATA, TONE_CATALOG, DESCRIPTORS, cloneSound, normalizeSound, readSoundLibrary, readSoundLibraryState, writeSoundLibrary, moveEffect, relocateEffect, removeEffect } from "../../web/sound-presets-core.js";
import { normalizeToneMarkers, tonePresetLabel } from "../../web/tone-marker-core.js";
import { insertEffect } from "../../web/sound-presets-core.js";
import { formatKnob } from "../../web/sound-presets-core.js";
import { parsePresetJSON, presetJSON, presetFingerprint, loadPresetFolderData, readAvailableSoundPresets, isSoundId } from "../../web/sound-presets-core.js";
import { readFileSync, readdirSync } from "node:fs";

const presetFolder = new URL('../../presets/sounds/', import.meta.url);
const fileTones = readdirSync(presetFolder).filter(name => name.endsWith('.json')).map(name =>
  parsePresetJSON(readFileSync(new URL(name, presetFolder), 'utf8'))[0]);
assert.equal(fileTones.length, 6);
assert.deepEqual(parsePresetJSON(presetJSON(fileTones, { library: true })), fileTones);
assert.deepEqual(parsePresetJSON(presetJSON([fileTones[0]])), [fileTones[0]]);
assert.equal(presetFingerprint(fileTones[0]), presetFingerprint({ ...fileTones[0], Name: 'Copy' }));
assert.throws(() => parsePresetJSON('not JSON'), /valid JSON/);
assert.throws(() => parsePresetJSON(JSON.stringify([fileTones[0], {}])), /Preset 2/);
assert.throws(() => parsePresetJSON(JSON.stringify({format:'rs-studio.sound-presets',version:2,presets:fileTones})), /version/);

assert.equal(formatKnob({ Name: "Pitch 1", UnitType: "number" }, -5), "-5 st");
assert.equal(formatKnob({ Name: "Bit Depth", UnitType: "number" }, 8), "8 bit");
assert.equal(formatKnob({ Name: "Gain", UnitType: "db" }, 2), "2 dB");
assert.equal(formatKnob({ Name: "Frequency", UnitType: "khz" }, 2), "2 kHz");
assert.equal(formatKnob({ Name: "Tone", UnitType: "number" }, 60), "60");

{
  const rig = cloneSound(SOUND_BASES.lead.GearList);
  const first = rig.Rack1, second = rig.Rack2, drive = rig.PrePedal1;
  assert.equal(insertEffect(rig, "Rack1", "Rack", 2), "Rack2");
  assert.equal(rig.Rack1, second); assert.equal(rig.Rack2, first);
  assert.equal(insertEffect(rig, "PrePedal1", "PostPedal", 0), "PostPedal1");
  assert.equal(rig.PostPedal1, drive); assert.equal(rig.PrePedal1, undefined);
  const unchanged = cloneSound(rig);
  insertEffect(rig, "Rack1", "PrePedal", 0);
  insertEffect(rig, "PostPedal1", "PostPedal", -1);
  assert.deepEqual(rig, unchanged);
}

for (const tone of Object.values(SOUND_BASES)) assert.ok(normalizeSound(tone), `${tone.Name} remains editable`);
const tone = cloneSound(SOUND_BASES.lead);
tone.Name = "My solo";
tone.GearList.Amp.KnobValues.Amp_MarshallPlexi_Loudness1 = 42;
const marker = { id: "m", t: 12, tone: "sound_test", toneData: tone };
const loaded = normalizeToneMarkers(JSON.parse(JSON.stringify([marker])));
assert.equal(loaded.length, 1);
assert.equal(tonePresetLabel(loaded[0].tone, loaded[0].toneData), "My solo");
assert.equal(loaded[0].toneData.GearList.Amp.KnobValues.Amp_MarshallPlexi_Loudness1, 42);
loaded[0].toneData.Name = "Different";
assert.equal(tone.Name, "My solo", "project normalization owns its snapshot");
assert.deepEqual(normalizeToneMarkers([{ tone: "sound_missing", t: 3 }]), []);
const broken = cloneSound(tone); broken.GearList.Amp.Key = "unknown";
assert.equal(normalizeSound(broken), null);
const loud = cloneSound(tone); loud.Volume = "Infinity";
assert.equal(normalizeSound(loud), null);
assert.equal(readSoundLibrary({ getItem: () => "broken" }).length, 0);
assert.deepEqual(readSoundLibrary({ getItem: () => JSON.stringify([{ id: "sound_test", tone }, { id: "sound_bad", tone: broken }]) }).map(item => item.id), ["sound_test"]);
assert.equal(TONE_CATALOG.Gear.length, 613);
assert.equal(DESCRIPTORS.length, 32);
// Every native model, all original defaults and numeric endpoints survive.
for (const definition of TONE_CATALOG.Gear) {
  for (const endpoint of [null, "MinValue", "MaxValue"]) {
    const native = cloneSound(SOUND_BASES.clean);
    const slot = { Amps: "Amp", Cabinets: "Cabinet", Pedals: "PrePedal1", Racks: "Rack1" }[definition.Type];
    const device = cloneSound(GEAR[definition.Key]);
    if (endpoint) for (const knob of definition.Knobs || []) device.KnobValues[knob.Key] = knob[endpoint];
    native.GearList[slot] = device;
    assert.ok(normalizeSound(native), `${definition.Key} ${endpoint || "defaults"}`);
  }
}
const unknownKnob = cloneSound(tone); unknownKnob.GearList.Amp.KnobValues.Unknown = 10;
assert.equal(normalizeSound(unknownKnob), null, "unknown parameters cannot be silently discarded");
const legacy = cloneSound(tone); legacy.GearList.Amp.KnobValues.Amp_MarshallPlexi_Bass = 0;
assert.equal(normalizeSound(legacy), null);
assert.equal(readSoundLibrary({ getItem: () => JSON.stringify([{ id: "sound_legacy", tone: legacy }]) })[0].tone.GearList.Amp.KnobValues.Amp_MarshallPlexi_Bass, 0, "old values load intact for explicit repair");
const chain = cloneSound(SOUND_BASES.lead.GearList);
const before = cloneSound(chain.Rack1), after = cloneSound(chain.Rack2);
assert.equal(moveEffect(chain, "Rack2", -1), "Rack1");
assert.deepEqual(chain.Rack1, after); assert.deepEqual(chain.Rack2, before);
const drive = cloneSound(chain.PrePedal1);
assert.equal(relocateEffect(chain, "PrePedal1", "PostPedal"), "PostPedal2");
assert.deepEqual(chain.PostPedal2, drive); assert.equal(chain.PrePedal1, undefined);
removeEffect(chain, "PostPedal1"); assert.deepEqual(chain.PostPedal1, drive); assert.equal(chain.PostPedal2, undefined);
assert.equal(relocateEffect(chain, "Rack1", "PrePedal"), "Rack1", "rack units stay in rack slots");
const enumTone = cloneSound(SOUND_BASES.bass);
enumTone.GearList.Rack1.KnobValues.Rack_StudioCompressor_Ratio = 1.5;
assert.equal(normalizeSound(enumTone), null);
for (const value of ["", " ", true, false, [], {}, null]) {
  assert.equal(normalizeSound({ ...tone, Volume: value }), null, `reject malformed volume ${JSON.stringify(value)}`);
  assert.equal(normalizeSound({ ...tone, MacVolume: value === null ? true : value }), null);
}
const badMove = cloneSound(chain);
for (const invalid of [true, 1, "cabinet"]) {
  const malformed = cloneSound(tone); malformed.GearList.Cabinet.KnobValues = invalid;
  assert.equal(normalizeSound(malformed), null);
}
moveEffect(badMove, "Rack1", 0.5);
assert.deepEqual(badMove, chain);
assert.equal(removeEffect(badMove, "PostPedal4"), false);
assert.deepEqual(badMove, chain);
{
  const unknown = { id: "sound_future", tone: { Name: "Future preset", GearList: {} } };
  let raw = JSON.stringify([{ id: "sound_test", tone }, unknown]);
  const storage = { getItem: () => raw, setItem: (_, value) => { raw = value; } };
  const state = readSoundLibraryState(storage);
  assert.deepEqual(state.unavailable, [unknown]);
  writeSoundLibrary([{ id: "sound_test", tone: { ...tone, Name: "Renamed" } }], state, storage);
  assert.deepEqual(JSON.parse(raw)[1], unknown, "saving valid presets preserves unavailable entries");
  assert.throws(() => writeSoundLibrary([], state, storage), /another window/, "stale drafts cannot overwrite newer saves");
  raw = "invalid JSON";
  assert.throws(() => writeSoundLibrary([], readSoundLibraryState(storage), storage), /could not be read/);
  assert.equal(raw, "invalid JSON");
  raw = JSON.stringify([{ id: "sound_test", tone }, { id: "sound_test", tone }]);
  writeSoundLibrary([], readSoundLibraryState(storage), storage);
  assert.deepEqual(JSON.parse(raw), [], "duplicate records cannot resurrect a deleted preset");
}
console.log("sound presets: full catalogue, chain edits, validation and safe storage ok");

{
  const previousFetch = globalThis.fetch, previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  globalThis.fetch = async () => ({ok:true, json:async () => ({folder:'presets', errors:[],
    presets:fileTones.map((tone,i) => ({id:`file:${i}.json`,tone}))})});
  try {
    await loadPresetFolderData();
    const first = readAvailableSoundPresets().filter(p => p.id.startsWith('sound_file_'));
    assert.equal(first.length, 6);
    assert.ok(first.every(p => isSoundId(p.id)));
    await loadPresetFolderData();
    assert.deepEqual(readAvailableSoundPresets().filter(p => p.id.startsWith('sound_file_')), first);
    console.log('file presets: stable project IDs and native snapshots ok');
  } finally { globalThis.fetch = previousFetch; globalThis.window = previousWindow; }
}
