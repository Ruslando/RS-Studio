// Native tone authoring. Projects reference the app library; unavailable
// imported tones remain editable as project-local presets.
import { SOUND_BASES, GEAR, GEAR_DATA, DESCRIPTORS, MAX_EFFECTS, cloneSound, gearName, gearInstrument,
  slotType, slotPrefix, slotLabel, knobValueValid, knobUnit, formatKnob, soundVolumeValid, normalizeSound, readSoundLibraryState, writeSoundLibrary, effectBank, removeEffect, moveEffect } from "./sound-presets-core.js";
import { $ } from "./dom.js";
import { toast, downloadProjectBlob } from "./notify.js";
import { confirmAction } from "./dialog.js";
import { insertEffect } from "./sound-presets-core.js";
import { parameterSlider } from "./parameter-slider.js";
import { dial, fader, eqGraph, segmented } from "./sound-controls.js";
import { MAX_PRESET_FILE_BYTES, parsePresetJSON, presetJSON, presetFingerprint, loadPresetFolderData, readAvailableSoundPresets } from "./sound-presets-core.js";
import { projectSoundPresets, projectSoundDirty, prepareProjectSoundEdits } from './project-sound-presets.js';
import { S } from './store.js';
import { snapshotEdit, commitStructure } from './edit.js';
import { initCollapsibleSections, setSection } from './collapsible-sections.js';

let library = null, selected = "clean", sound = null, activeSlot = "Amp";
let filter = "", category = "all";
let pendingBank = null, pickerKey = null;
let librarySnapshot = null, libraryBaseline = "";
let draggedSlot = null;
let startingPoints = SOUND_BASES, fileRequest = 0, loadingFiles = false;
let projectLibrary = [], projectState = null;
let linkedAppPreset = null;
export const soundDraftDirty = () => !!library && (JSON.stringify(library) !== libraryBaseline || projectSoundDirty(projectLibrary));
// The preset as it was when opened; each control can return to its value.
let baseline = null;
const own = () => library?.find(entry => entry.id === selected);
const projectOwn = () => projectLibrary.find(entry => entry.id === selected);
const entry = () => own() || projectOwn() || (linkedAppPreset?.id === selected ? linkedAppPreset : null);
const remember = () => { if (entry()) entry().tone = cloneSound(sound); };
function copyName(name) {
  const base = name.replace(/ copy(?: \d+)?$/, "").slice(0, 65);
  const names = new Set(library.map(entry => entry.tone.Name));
  let result = `${base} copy`, i = 2;
  while (names.has(result)) result = `${base} copy ${i++}`;
  return result;
}
// Collapsed sections are a per-viewer layout preference.
const SECTIONS_KEY = "rs-studio.sound-sections.collapsed";
function changed({ keepName = false } = {}) {
  if (linkedAppPreset?.id === selected && !own()) library.push({ id: selected, tone: cloneSound(sound) });
  if (!entry()) {
    // `sound` is already a private draft. Keep its object and device references
    // intact so the first slider drag or text edit can continue uninterrupted.
    if (!keepName) sound.Name = copyName(sound.Name);
    selected = `sound_${crypto.randomUUID()}`;
    library.push({ id: selected, tone: cloneSound(sound) });
    if (document.activeElement !== $("soundName")) $("soundName").value = sound.Name;
    $("soundDelete").disabled = false;
    $("soundDelete").title = "Delete preset";
    renderPresets();
  }
  remember(); refreshStatus();
}
function choose(key) {
  remember(); selected = key;
  sound = cloneSound(entry()?.tone || startingPoints[key]); baseline = cloneSound(sound); activeSlot = "Amp";
  filter = ""; category = "all"; render();
}
export function beginSoundDraft() {
  if (library) return;
  librarySnapshot = readSoundLibraryState(); library = cloneSound(librarySnapshot.presets);
  projectState = S.state; projectLibrary = projectSoundPresets(projectState);
  libraryBaseline = JSON.stringify(library); selected = library[0]?.id || "clean";
  sound = cloneSound(own()?.tone || SOUND_BASES[selected]); baseline = cloneSound(sound); activeSlot = "Amp";
  filter = ""; category = "all"; render();
  loadPresetFolder({ initial: true });
}
export function selectToneSound(laneId, markerId) {
  const marker = S.state?.editLanes.find(lane => lane.id === laneId)?.toneMarkers?.find(marker => marker.id === markerId);
  const appPreset = readAvailableSoundPresets().find(preset => preset.id === marker?.tone);
  if (appPreset) {
    if (!library.some(entry => entry.id === appPreset.id)) linkedAppPreset = cloneSound(appPreset);
    choose(appPreset.id);
    setSection(document.querySelector('[data-section="preset"]'), true);
    return true;
  }
  const preset = projectLibrary.find(entry => entry.targets.some(target => target.lane === laneId && target.marker === markerId));
  if (!preset) return false;
  choose(preset.id);
  setSection(document.querySelector('[data-section="preset"]'), true);
  return true;
}
export function dropSoundDraft() {
  fileRequest++; loadingFiles = false; $("spSounds").inert = false;
  $("soundPreset").disabled = false;
  $("soundGearDialog").close(); $("soundDeviceDialog").close(); library = null; sound = null; librarySnapshot = null;
  projectLibrary = []; projectState = null;
  linkedAppPreset = null;
}
export function saveSoundDraft() {
  if (loadingFiles) { toast("Wait for the presets to finish loading"); return false; }
  if (!library) return true;
  remember();
  if (!soundDraftDirty()) return true;
  const libraryDirty = JSON.stringify(library) !== libraryBaseline;
  const projectDirty = projectSoundDirty(projectLibrary);
  const normalized = library.map(entry => ({ id: entry.id, tone: normalizeSound(entry.tone) }));
  const invalid = (libraryDirty && normalized.find(entry => !entry.tone))
    || projectLibrary.find(entry => JSON.stringify(entry.tone) !== entry.source && !normalizeSound(entry.tone));
  if (invalid) {
    selected = invalid.id; sound = cloneSound(entry().tone);
    activeSlot = Object.keys(sound.GearList).find(slot => (GEAR_DATA[sound.GearList[slot].Key]?.Knobs || [])
      .some(knob => !knobValueValid(knob, sound.GearList[slot].KnobValues[knob.Key]))) || "Amp";
    render();
    // Settings may reveal this pane only after Save returns false.
    requestAnimationFrame(() => {
      if (!sound) return;
      const input = !sound.Name.trim() ? $("soundName") : !soundVolumeValid(sound.Volume) ? $("soundVolumeNumber")
        : $("soundDevices").querySelector('[aria-invalid="true"]');
      const section = input?.closest(".sound-section");
      if (section) setSection(section, true);
      input?.focus();
    });
    toast("Check the highlighted preset and parameter values"); return false;
  }
  let applyProjectEdits;
  try {
    if (projectDirty && projectState !== S.state) throw new Error('The open project changed. Reopen the designer');
    applyProjectEdits = prepareProjectSoundEdits(projectLibrary, S.state);
    if (libraryDirty) writeSoundLibrary(normalized, librarySnapshot);
  }
  catch (error) { toast(`Presets could not be saved: ${error.message}`); return false; }
  if (projectDirty) {
    const previous = snapshotEdit();
    applyProjectEdits();
    commitStructure(previous);
  }
  librarySnapshot = readSoundLibraryState();
  if (libraryDirty) library = cloneSound(normalized);
  libraryBaseline = JSON.stringify(library);
  sound = cloneSound(entry()?.tone || sound); baseline = cloneSound(sound);
  render();
  window.dispatchEvent(new Event("sound-presets-changed")); return true;
}
function duplicate() {
  remember();
  const name = copyName(sound.Name);
  selected = `sound_${crypto.randomUUID()}`; sound = { ...cloneSound(sound), Name: name }; baseline = cloneSound(sound);
  library.push({ id: selected, tone: cloneSound(sound) }); render(); $("soundName").focus(); $("soundName").select();
}
function newPreset() {
  remember();
  sound = cloneSound(SOUND_BASES.clean);
  sound.GearList = { Amp: sound.GearList.Amp, Cabinet: sound.GearList.Cabinet };
  const names = new Set(library.map(entry => entry.tone.Name));
  let name = "Untitled preset", suffix = 2;
  while (names.has(name)) name = `Untitled preset ${suffix++}`;
  sound.Name = name; selected = `sound_${crypto.randomUUID()}`; baseline = cloneSound(sound);
  library.push({ id: selected, tone: cloneSound(sound) });
  activeSlot = "Amp"; filter = ""; category = "all";
  render(); $("soundName").focus(); $("soundName").select();
}
function renderPresets() {
  const select = $("soundPreset"); select.replaceChildren();
  const builtins = document.createElement("optgroup"); builtins.label = "Starting points";
  const available = readAvailableSoundPresets();
  for (const [key, tone] of Object.entries(startingPoints)) {
    const preset = available.find(preset => preset.fileId === key);
    if (preset && library.some(entry => entry.id === preset.id)) continue;
    builtins.append(new Option(tone.Name, preset && linkedAppPreset?.id === preset.id ? preset.id : key));
  }
  if (linkedAppPreset && !library.some(entry => entry.id === linkedAppPreset.id)
      && ![...builtins.children].some(option => option.value === linkedAppPreset.id)) {
    builtins.append(new Option(linkedAppPreset.tone.Name, linkedAppPreset.id));
  }
  const mine = document.createElement("optgroup"); mine.label = "Your presets";
  for (const entry of library) mine.append(new Option(entry.tone.Name, entry.id));
  const project = document.createElement('optgroup'); project.label = 'Project presets';
  const names = new Map();
  for (const entry of projectLibrary) {
    const count = (names.get(entry.tone.Name) || 0) + 1; names.set(entry.tone.Name, count);
    project.append(new Option(`${entry.tone.Name}${count > 1 ? ` · ${count}` : ''}`, entry.id));
  }
  select.append(builtins, mine);
  if (projectLibrary.length) select.append(project);
  select.value = selected;
}
function fileStatus(messages) {
  $("soundFileStatus").textContent = messages.join(" ");
  $("soundFileStatus").hidden = !messages.length;
}
async function loadPresetFolder({ initial = false } = {}) {
  const request = ++fileRequest;
  loadingFiles = true; $("spSounds").inert = true;
  $("soundPreset").disabled = true;
  fileStatus(["Reading preset folder…"]);
  try {
    const data = await loadPresetFolderData();
    if (request !== fileRequest || !library) return;
    const entries = (data.presets || []).map(entry => [entry.id, normalizeSound(entry.tone)]);
    if (entries.some(([, tone]) => !tone)) throw new Error("The folder contains an unsupported preset");
    startingPoints = entries.length ? Object.fromEntries(entries) : SOUND_BASES;
    fileStatus([...(data.errors || []).map(error => `${error.file}: ${error.error}`),
      ...(!entries.length ? ["No usable JSON presets found. Showing legacy starting points."] : [])]);
    if (!entry()) {
      selected = (!initial && startingPoints[selected]) ? selected
        : (startingPoints["file:guitar-clean.json"] ? "file:guitar-clean.json" : Object.keys(startingPoints)[0]);
      sound = cloneSound(startingPoints[selected]); baseline = cloneSound(sound); activeSlot = "Amp";
    }
    render();
  } catch (error) {
    if (request === fileRequest && library) fileStatus([error.message]);
  } finally {
    if (request === fileRequest) { loadingFiles = false; $("spSounds").inert = false; $("soundPreset").disabled = false; }
  }
}
async function importPresetFiles(files) {
  if (!library || loadingFiles) return;
  const draft = library, messages = [], imported = [];
  remember();
  const fingerprints = new Set(library.map(entry => presetFingerprint(entry.tone)));
  loadingFiles = true; $("spSounds").inert = true; $("soundPreset").disabled = true;
  fileStatus(["Reading JSON presets…"]);
  for (const file of files) {
    try {
      if (!/\.json$/i.test(file.name)) throw new Error("Only JSON preset files are supported");
      if (file.size > MAX_PRESET_FILE_BYTES) throw new Error("File exceeds the 1 MiB limit");
      const tones = parsePresetJSON(await file.text());
      if (library !== draft) return;
      for (const tone of tones) {
        const fingerprint = presetFingerprint(tone);
        if (fingerprints.has(fingerprint)) { messages.push(`${file.name}: duplicate preset skipped (${tone.Name}).`); continue; }
        fingerprints.add(fingerprint);
        if (library.some(entry => entry.tone.Name === tone.Name)) tone.Name = copyName(tone.Name);
        const entry = { id: `sound_${crypto.randomUUID()}`, tone };
        library.push(entry); imported.push(entry);
      }
    } catch (error) { messages.push(`${file.name}: ${error.message}.`); }
  }
  if (library !== draft) return;
  loadingFiles = false; $("spSounds").inert = false; $("soundPreset").disabled = false;
  if (imported.length) {
    selected = imported[0].id; sound = cloneSound(imported[0].tone); baseline = cloneSound(sound); activeSlot = "Amp";
    render(); messages.unshift(`Imported ${imported.length} preset(s). Choose Apply to keep them.`);
  }
  fileStatus(messages);
  $("soundImportFiles").value = "";
}
function exportPresets() {
  if (!library || loadingFiles) return;
  remember();
  try {
    const text = presetJSON([sound]);
    const name = sound.Name.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 70) || "preset";
    downloadProjectBlob(new Blob([text], { type: "application/json" }), `${name}.json`);
  } catch (error) { fileStatus([error.message]); }
}
function field(label, control) {
  const wrap = document.createElement("label"); wrap.className = "field-group block";
  const text = document.createElement("span"); text.textContent = label;
  wrap.append(text, control); return wrap;
}
function button(text, action, disabled = false) {
  const el = document.createElement("button"); el.type = "button"; el.className = "btn--compact";
  el.textContent = text; el.disabled = disabled; el.addEventListener("click", action); return el;
}
function pickSlot(slot) {
  activeSlot = slot; filter = ""; category = "all";
  $("soundGearSearch").value = "";
  // Keep the focused card in place when switching controls.
  for (const item of $("soundChain").querySelectorAll(".sound-chain-item")) {
    const on = String(item.dataset.slot === slot);
    item.setAttribute("aria-pressed", on); item.dataset.selected = on;
  }
  renderDevice({ resetScroll: true });
  const card = $("soundChain").querySelector(`[data-slot="${activeSlot}"]`);
  card?.focus({ preventScroll: true }); card?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function focusActiveCard() {
  $("soundChain").querySelector(`[data-slot="${activeSlot}"]`)?.focus({ preventScroll: true });
}
const DEVICE_SHAPES = {
  Amp: '<rect x="3" y="7" width="26" height="18" rx="2"/><path d="M11 7V4h10v3M3 14h26M7 21h18"/><circle cx="8" cy="10.5" r=".6"/><circle cx="13" cy="10.5" r=".6"/><circle cx="18" cy="10.5" r=".6"/>',
  Cabinet: '<rect x="5" y="2" width="22" height="28" rx="2"/><circle cx="16" cy="10" r="5"/><circle cx="16" cy="23" r="5"/>',
  Pedal: '<rect x="8" y="2" width="16" height="28" rx="2"/><circle cx="12" cy="8" r="1.5"/><circle cx="20" cy="8" r="1.5"/><path d="M11 17h10v9H11Z"/>',
  Rack: '<rect x="2" y="7" width="28" height="18" rx="2"/><path d="M6 7v18M26 7v18M10 13h9m-9 5h5"/><circle cx="22" cy="18" r="1.5"/>'
};
function deviceIcon(type) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 32 32"); svg.setAttribute("aria-hidden", "true");
  svg.classList.add("sound-device-icon");
  svg.innerHTML = DEVICE_SHAPES[type]; return svg;
}
function deleteChainEffect(slot) {
  const selectedDevice = sound.GearList[activeSlot];
  if (!removeEffect(sound.GearList, slot)) return;
  activeSlot = Object.keys(sound.GearList).find(key => sound.GearList[key] === selectedDevice) || "Amp";
  changed(); render(); focusActiveCard();
}
function canDrop(prefix) {
  return draggedSlot && ["PrePedal", "PostPedal", "Rack"].includes(prefix)
    && (prefix === "Rack") === draggedSlot.startsWith("Rack");
}
function dropEffect(event, prefix, index) {
  if (!canDrop(prefix)) return;
  event.preventDefault(); event.stopPropagation();
  activeSlot = insertEffect(sound.GearList, draggedSlot, prefix, index);
  draggedSlot = null; changed(); render(); focusActiveCard();
}
function renderChain() {
  const chain = $("soundChain"), scroll = chain.scrollLeft; chain.replaceChildren();
  $("soundEffectCount").textContent = `${effectCount()} / ${MAX_EFFECTS} effects`;
  for (const prefix of ["PrePedal", "Amp", "PostPedal", "Cabinet", "Rack"]) {
    const group = document.createElement("div"); group.className = "sound-chain-group";
    group.dataset.bank = prefix;
    group.addEventListener("dragover", event => {
      if (!canDrop(prefix)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = "move";
      group.dataset.drop = "true";
    });
    group.addEventListener("dragleave", event => { if (!group.contains(event.relatedTarget)) delete group.dataset.drop; });
    group.addEventListener("drop", event => dropEffect(event, prefix, effectBank(sound.GearList, prefix).length));
    const heading = document.createElement("div"); heading.className = "section-head";
    const bankLabel = { PrePedal: "Pre effects", Amp: "Amplifier", PostPedal: "Loop effects", Cabinet: "Cabinet", Rack: "Rack effects" }[prefix];
    heading.textContent = { PrePedal: "Pre-amp pedals", PostPedal: "Effects loop" }[prefix] || bankLabel;
    group.append(heading);
    const devices = document.createElement("div"); devices.className = "sound-chain-devices"; group.append(devices);
    const slots = Object.keys(sound.GearList).filter(slot => slotPrefix(slot) === prefix).sort();
    for (const slot of slots) {
      const device = sound.GearList[slot], definition = GEAR_DATA[device.Key];
      const card = document.createElement("div"); card.className = "sound-chain-card";
      const select = document.createElement("button"); select.type = "button"; select.className = "sound-chain-item";
      select.dataset.slot = slot; select.setAttribute("aria-label", `${slotLabel(slot)}: ${gearName(device.Key)}`);
      select.setAttribute("aria-pressed", String(activeSlot === slot)); select.dataset.selected = String(activeSlot === slot);
      const title = document.createElement("span"); title.className = "sound-chain-name"; title.textContent = gearName(device.Key);
      select.title = `${slotLabel(slot)}: ${gearName(device.Key)}; click the selected card to replace it`;
      const subtitle = document.createElement("span"); subtitle.className = "sound-chain-subtitle";
      subtitle.textContent = slot === "Cabinet" ? definition.Category : slot === "Amp" ? gearInstrument(device.Key) : `${slot.at(-1)} · ${definition.Category}`;
      select.append(deviceIcon(prefix === "Amp" || prefix === "Cabinet" || prefix === "Rack" ? prefix : "Pedal"), title, subtitle);
      select.addEventListener("click", () => slot === activeSlot ? openGearPicker() : pickSlot(slot)); card.append(select);
      if (!["Amp", "Cabinet"].includes(slot)) {
        card.draggable = true;
        const grip = document.createElement("span"); grip.className = "sound-drag-grip"; grip.textContent = "⠿";
        grip.setAttribute("aria-hidden", "true"); card.append(grip);
        const remove = button("×", () => deleteChainEffect(slot)); remove.className = "sound-chain-remove";
        remove.setAttribute("aria-label", `Remove ${gearName(device.Key)} from chain`); remove.title = "Remove effect (Delete)";
        card.append(remove);
        card.addEventListener("dragstart", event => {
          draggedSlot = slot; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", slot);
          card.dataset.dragging = "true";
        });
        card.addEventListener("dragend", () => {
          draggedSlot = null;
          chain.querySelectorAll('[data-drop], [data-dragging]').forEach(el => { delete el.dataset.drop; delete el.dataset.dragging; });
        });
        card.addEventListener("dragover", event => {
          if (!canDrop(prefix)) return;
          event.preventDefault(); event.stopPropagation();
          card.dataset.drop = event.clientX < card.getBoundingClientRect().left + card.clientWidth / 2 ? "before" : "after";
        });
        card.addEventListener("dragleave", event => { if (!card.contains(event.relatedTarget)) delete card.dataset.drop; });
        card.addEventListener("drop", event => {
          const after = event.clientX >= card.getBoundingClientRect().left + card.clientWidth / 2;
          dropEffect(event, prefix, Number(slot.at(-1)) - 1 + Number(after));
        });
        select.title += "; drag or Alt+←/→ to move, Delete to remove";
        select.addEventListener("keydown", event => {
          if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) keyMove(slot, event.key === "ArrowLeft" ? -1 : 1);
          else if (["Delete", "Backspace"].includes(event.key) && !event.altKey) deleteChainEffect(slot);
          else return;
          event.preventDefault(); event.stopPropagation();
        });
      }
      devices.append(card);
    }
    if (!["Amp", "Cabinet"].includes(prefix)) {
      const add = button(slots.length ? "+" : "+ Add effect", () => addEffect(prefix), effectCount() >= MAX_EFFECTS);
      add.classList.add("sound-chain-add");
      if (slots.length) add.classList.add("sound-chain-add--side");
      add.setAttribute("aria-label", `Add ${bankLabel.toLowerCase()}`);
      add.title = add.disabled ? "Rocksmith Tone Designer supports four effects in total" : "Add effect";
      (slots.length ? devices : group).append(add);
    }
    chain.append(group);
  }
  chain.scrollLeft = scroll;
  const card = chain.querySelector(`[data-slot="${activeSlot}"]`);
  if (card && chain.clientWidth) {
    const bounds = chain.getBoundingClientRect(), target = card.getBoundingClientRect();
    if (target.left < bounds.left) chain.scrollLeft -= bounds.left - target.left;
    else if (target.right > bounds.right) chain.scrollLeft += target.right - bounds.right;
  }
  chainOverflow();
}
// Offer the large view only while the controls do not fit where they are.
function deviceOverflow() {
  const bench = $("soundDeviceEditor").closest(".sound-workbench"), button = $("soundExpandDevice");
  button.hidden = !$("soundWorkbenchHome").contains(bench) || button.closest(".sound-section").hasAttribute("data-collapsed")
    || (bench.scrollHeight <= bench.clientHeight + 1 && bench.scrollWidth <= bench.clientWidth + 1);
}
function sizeDeviceDialog() {
  const rect = $("settingsModal").querySelector(".settings-layout > .dialog-body").getBoundingClientRect();
  Object.assign($("soundDeviceDialog").style, {
    left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
  });
}
function chainOverflow() {
  const chain = $("soundChain"), more = [];
  if (chain.scrollLeft > 1) more.push("start");
  if (chain.scrollLeft + chain.clientWidth < chain.scrollWidth - 1) more.push("end");
  chain.dataset.more = more.join(" ");
}
// Keyboard reordering: within a bank, then across the amp between pedal banks.
function keyMove(slot, direction) {
  const prefix = slotPrefix(slot);
  let next = moveEffect(sound.GearList, slot, direction);
  if (next === slot && prefix !== "Rack" && (direction > 0) === (prefix === "PrePedal")) {
    const other = prefix === "PrePedal" ? "PostPedal" : "PrePedal";
    next = insertEffect(sound.GearList, slot, other, direction > 0 ? 0 : effectBank(sound.GearList, other).length);
  }
  if (next === slot) return;
  activeSlot = next; changed(); render(); focusActiveCard();
}
function effectCount() { return Object.keys(sound.GearList).length - 2; }
function addEffect(prefix) {
  if (effectCount() >= MAX_EFFECTS) return;
  openGearPicker(prefix);
}
function openGearPicker(bank = null) {
  pendingBank = bank; filter = ""; category = "all";
  pickerKey = bank ? bank === "Rack" ? "Rack_StudioChamber" : "Pedal_GermaniumDrive" : sound.GearList[activeSlot].Key;
  $("soundGearSearch").value = "";
  $("soundGearDialogTitle").textContent = bank ? "Add effect" : `Replace ${slotLabel(activeSlot).toLowerCase()}`;
  $("soundGearApply").textContent = "Apply";
  renderGearOptions(); $("soundGearDialog").showModal(); $("soundGearSearch").focus();
}

// Devices get controls shaped like their hardware: dials for amps and effects,
// faders for fixed-band graphic EQs and a curve for parametric EQs.
const BAND = /^\d+(\.\d+)?\s*k?hz$/i;
function eqBands(knobs) {
  return knobs.filter(knob => knob.UnitType === "db").map(gainKnob => ({ gainKnob,
    freqKnob: knobs.find(knob => [`${gainKnob.Name} Freq.`, `${gainKnob.Name} Frequency`].includes(knob.Name)),
    qKnob: knobs.find(knob => knob.Name === `${gainKnob.Name} "Q"`) })).filter(band => band.freqKnob);
}
function deviceLayout(definition) {
  const knobs = definition.Knobs || [];
  if (knobs.length > 2 && knobs.every(knob => BAND.test(knob.Name))) return "graphic";
  if (definition.Type === "Racks" && eqBands(knobs).length > 1) return "parametric";
  return "dial";
}
function knobControl(knob, device, view) {
  const value = device.KnobValues[knob.Key];
  if (knob.EnumValues) {
    // Short, valid choices become a switch; anything else keeps the select,
    // which can also show an invalid legacy value for correction.
    if (knobValueValid(knob, value) && knob.EnumValues.length <= 5 && knob.EnumValues.every(text => text.length <= 12)) {
      return segmented(knob.Name, `${activeSlot} ${knob.Name}`, knob.EnumValues.map((text, i) => ({
        text, value: knob.MinValue + i, checked: value === knob.MinValue + i, isDefault: knob.DefaultValue === knob.MinValue + i,
      })), next => { device.KnobValues[knob.Key] = next; changed(); });
    }
    const select = document.createElement("select"); select.setAttribute("aria-label", `${activeSlot} ${knob.Name}`);
    knob.EnumValues.forEach((text, i) => select.append(new Option(text, String(knob.MinValue + i))));
    if (!knobValueValid(knob, value)) select.append(new Option(`Invalid: ${value}`, String(value)));
    select.value = String(value);
    select.setAttribute("aria-invalid", String(!knobValueValid(knob, value)));
    select.addEventListener("change", () => {
      device.KnobValues[knob.Key] = Number(select.value); select.setAttribute("aria-invalid", "false"); changed();
    });
    return field(knob.Name, select);
  }
  // Two or three integer positions (e.g. Bright 0/1) are switches, not dials.
  if (knob.ValueStep === 1 && knob.MaxValue - knob.MinValue <= 2 && Number.isInteger(value) && knobValueValid(knob, value)) {
    const labels = knob.MaxValue - knob.MinValue === 1 && knob.MinValue === 0 ? ["Off", "On"] : null;
    return segmented(knob.Name, `${activeSlot} ${knob.Name}`, Array.from({ length: knob.MaxValue - knob.MinValue + 1 }, (_, i) => ({
      text: labels?.[i] ?? String(knob.MinValue + i), value: knob.MinValue + i, checked: value === knob.MinValue + i, isDefault: knob.DefaultValue === knob.MinValue + i,
    })), next => { device.KnobValues[knob.Key] = next; changed(); });
  }
  const row = document.createElement("div"); row.className = `sound-parameter sound-parameter--${view}`;
  const slider = document.createElement("input"); slider.type = "range";
  Object.assign(slider, { min: knob.MinValue, max: knob.MaxValue, step: knob.ValueStep, value });
  slider.setAttribute("aria-label", `${activeSlot} ${knob.Name}`);
  const number = document.createElement("input"); number.type = "number"; number.className = "sound-knob-value";
  // Native presets and DLC Builder's manual entry may sit between slider steps.
  Object.assign(number, { min: knob.MinValue, max: knob.MaxValue, step: "any", value });
  number.setAttribute("aria-label", `${activeSlot} ${knob.Name} value`);
  number.id = `sound-knob-${knob.Key}`;
  const label = document.createElement("label"); label.className = "sound-control-name";
  label.textContent = knob.Name; label.title = knob.Name; label.htmlFor = number.id;
  const unit = document.createElement("span"); unit.className = "sound-unit"; unit.textContent = knobUnit(knob);
  let visual = null;
  const update = raw => {
    const next = raw === "" ? NaN : Number(raw);
    number.setAttribute("aria-invalid", String(!knobValueValid(knob, next)));
    // Keep invalid finite input in the draft so Save cannot silently ignore it.
    device.KnobValues[knob.Key] = Number.isFinite(next) ? next : null;
    visual?.sync(); syncRevert(); $("soundDevices").querySelector(".sound-eq-graph")?.sync(); changed();
  };
  number.setAttribute("aria-invalid", String(!knobValueValid(knob, value)));
  slider.addEventListener("input", () => { number.value = slider.value; update(slider.value); });
  number.addEventListener("input", () => { if (number.value !== "") slider.value = number.value; update(number.value); });
  const range = `${knob.MinValue}–${knob.MaxValue}${unit.textContent ? ` ${unit.textContent}` : ""}; step ${knob.ValueStep}; default ${formatKnob(knob, knob.DefaultValue)}`;
  slider.title = range; number.title = range;
  const original = presetValue(knob, device);
  const revert = document.createElement("button"); revert.type = "button"; revert.className = "sound-revert"; revert.textContent = "↺";
  revert.title = `Back to the preset's ${original}${unit.textContent ? ` ${unit.textContent}` : ""}`;
  revert.setAttribute("aria-label", `${activeSlot} ${knob.Name} back to preset value`);
  revert.addEventListener("click", () => { slider.value = original; number.value = original; update(String(original)); });
  const syncRevert = () => revert.toggleAttribute("data-changed", !(number.value !== "" && Number(number.value) === original));
  const readout = document.createElement("div"); readout.className = "sound-readout"; readout.append(number, unit, revert);
  syncRevert();
  if (view === "field") { row.append(label, readout); return row; }
  const options = {
    min: knob.MinValue, max: knob.MaxValue, defaultValue: knob.DefaultValue,
    onDefault: () => { slider.value = knob.DefaultValue; number.value = knob.DefaultValue; update(String(knob.DefaultValue)); },
  };
  visual = view === "fader" ? fader(slider, options) : dial(slider, options);
  if (view === "fader") row.append(readout, visual, label); else row.append(label, visual, readout);
  return row;
}
function presetValue(knob, device) {
  const before = baseline.GearList[activeSlot];
  const match = before?.Key === device.Key ? before : Object.values(baseline.GearList).find(item => item.Key === device.Key);
  return match && knobValueValid(knob, match.KnobValues[knob.Key]) ? match.KnobValues[knob.Key] : knob.DefaultValue;
}
function cabinetControls(device, definition) {
  // Variants are "<Microphone> <Position>" (e.g. "Ribbon Off Axis"); a few are a single name like "PA".
  const parse = category => {
    const match = /^(.*?) (Cone|Edge|Off Axis)$/.exec(category || "Direct");
    return match ? { mic: match[1], position: match[2] } : { mic: category || "Direct", position: "" };
  };
  const variants = Object.values(GEAR_DATA).filter(gear => gear.Type === "Cabinets" && gear.Name === definition.Name)
    .map(gear => ({ key: gear.Key, ...parse(gear.Category) }));
  const current = variants.find(variant => variant.key === device.Key);
  const choose = variant => { sound.GearList.Cabinet = cloneSound(GEAR[variant.key]); changed(); renderChain(); renderDevice(); };
  const mics = [...new Set(variants.map(variant => variant.mic))];
  const positions = variants.filter(variant => variant.mic === current.mic && variant.position);
  const wrap = document.createElement("div"); wrap.className = "sound-cabinet";
  wrap.append(segmented("Microphone", "Cabinet microphone", mics.map(mic => ({ text: mic, value: mic, checked: mic === current.mic })), mic =>
    choose(variants.find(variant => variant.mic === mic && variant.position === current.position) || variants.find(variant => variant.mic === mic))));
  if (positions.length) wrap.append(segmented("Position", "Microphone position", positions.map(variant => ({
    text: variant.position, value: variant.key, checked: variant.key === device.Key })), key => choose(variants.find(variant => variant.key === key))));
  return wrap;
}

function optionsForDevice() {
  const type = slotType(pendingBank ? `${pendingBank}1` : activeSlot);
  const all = Object.values(GEAR_DATA).filter(gear => gear.Type === type);
  return type === "Cabinets" ? all.filter((gear, i) => all.findIndex(other => other.Name === gear.Name) === i) : all;
}
function renderGearOptions() {
  const current = GEAR_DATA[pickerKey || sound.GearList[activeSlot].Key];
  const select = $("soundGearSelect"); select.replaceChildren();
  select.setAttribute("aria-label", pendingBank ? "New effect" : slotLabel(activeSlot));
  const categories = $("soundGearCategory"); categories.replaceChildren(new Option("All categories", "all"));
  const all = optionsForDevice();
  const groupOf = gear => ["Amps", "Cabinets"].includes(gear.Type) ? gearInstrument(gear.Key) : `${gearInstrument(gear.Key)} · ${gear.Category}`;
  for (const name of [...new Set(all.map(groupOf))].sort()) categories.append(new Option(name, name));
  if (![...categories.options].some(option => option.value === category)) category = "all";
  categories.value = category;
  const currentKey = current.Type === "Cabinets" ? all.find(gear => gear.Name === current.Name).Key : current.Key;
  const matches = all.filter(gear => (category === "all" || groupOf(gear) === category)
    && `${gear.Name} ${gear.Category} ${gear.Key}`.toLowerCase().includes(filter.toLowerCase()));
  const groups = new Map();
  if (!matches.some(gear => gear.Key === currentKey)) {
    const kept = document.createElement("optgroup"); kept.label = "Current device";
    kept.append(new Option(current.Name.trim(), currentKey)); select.append(kept);
  }
  for (const gear of matches.sort((a, b) => groupOf(a).localeCompare(groupOf(b)) || a.Name.localeCompare(b.Name))) {
    const group = groupOf(gear);
    if (!groups.has(group)) { const el = document.createElement("optgroup"); el.label = group; groups.set(group, el); select.append(el); }
    groups.get(group).append(new Option(gear.Name.trim(), gear.Key));
  }
  select.value = currentKey; select.selectedOptions[0]?.scrollIntoView({ block: "nearest" });
  $("soundGearMatches").textContent = `${matches.length} devices`;
  syncGearApply();
}
function syncGearApply() {
  const key = $("soundGearSelect").value, current = sound?.GearList[activeSlot]?.Key;
  $("soundGearApply").hidden = !key || (!pendingBank && (key === current
    || activeSlot === "Cabinet" && GEAR_DATA[key]?.Name === GEAR_DATA[current]?.Name));
}
function renderDevice({ resetScroll = false } = {}) {
  const device = sound.GearList[activeSlot], definition = GEAR_DATA[device.Key];
  pickerKey = device.Key; $("soundGearSearch").value = filter; renderGearOptions();
  const controls = $("soundDevices"); controls.replaceChildren();
  if (activeSlot === "Cabinet") {
    controls.dataset.layout = "cabinet"; controls.append(cabinetControls(device, definition));
  } else {
    const knobs = definition.Knobs || [], layout = deviceLayout(definition);
    controls.dataset.layout = layout;
    if (layout === "parametric") {
      const rows = new Map(knobs.map(knob => [knob.Key, knobControl(knob, device, "field")]));
      const input = knob => rows.get(knob.Key).querySelector(".sound-knob-value");
      const bands = eqBands(knobs);
      controls.append(eqGraph(bands.map(band => ({ ...band, gain: input(band.gainKnob), freq: input(band.freqKnob),
        scale: band.freqKnob.UnitType === "khz" ? 1000 : 1,
        q: band.qKnob && (() => band.qKnob.EnumValues[device.KnobValues[band.qKnob.Key] - band.qKnob.MinValue] === "Narrow" ? 2 : .7),
      }))));
      // One column per band (numbered like its point on the curve), then anything left over.
      const grid = document.createElement("div"); grid.className = "sound-eq-bands";
      bands.forEach((band, i) => {
        const column = document.createElement("div"); column.className = "sound-eq-band"; column.dataset.band = i + 1;
        const heading = document.createElement("div"); heading.className = "sound-eq-band-title";
        const badge = document.createElement("span"); badge.textContent = i + 1;
        heading.append(badge, document.createTextNode(band.gainKnob.Name)); column.append(heading);
        for (const [knob, label] of [[band.gainKnob, "Gain"], [band.freqKnob, "Frequency"], [band.qKnob, "Q"]]) {
          if (knob) rows.get(knob.Key).querySelector(".sound-control-name").textContent = label;
        }
        for (const knob of [band.gainKnob, band.freqKnob, band.qKnob].filter(Boolean)) { column.append(rows.get(knob.Key)); rows.delete(knob.Key); }
        grid.append(column);
      });
      grid.append(...rows.values()); controls.append(grid);
    } else {
      for (const knob of knobs) controls.append(knobControl(knob, device, layout === "graphic" ? "fader" : "dial"));
    }
  }
  $("soundDeviceEditor").setAttribute("aria-label", `${slotLabel(activeSlot)}: ${gearName(device.Key)}`);
  $("soundDeviceDialogTitle").textContent = `${slotLabel(activeSlot)} · ${gearName(device.Key)}`;
  if (resetScroll) $("soundDevices").closest(".sound-workbench").scrollTop = 0;
  requestAnimationFrame(deviceOverflow);
}
function renderDescriptors() {
  const container = $("soundDescriptors"); container.replaceChildren();
  sound.ToneDescriptors.forEach((value, i) => {
    const tag = document.createElement("span"); tag.className = "sound-tag";
    const select = document.createElement("select"); select.setAttribute("aria-label", `Tone description ${i + 1}`);
    for (const description of DESCRIPTORS) select.append(new Option(description.Name, description.UIName));
    select.value = value;
    select.addEventListener("change", () => { sound.ToneDescriptors[i] = select.value; changed(); });
    const remove = button("×", () => { sound.ToneDescriptors.splice(i, 1); changed(); renderDescriptors(); $("soundAddDescription").focus(); },
      sound.ToneDescriptors.length <= 1);
    remove.className = "sound-tag-remove"; remove.setAttribute("aria-label", `Remove tone description ${i + 1}`);
    remove.title = remove.disabled ? "A tone needs at least one description" : "Remove description";
    tag.append(select, remove); container.append(tag);
  });
  // Three is the native maximum; the add button disappears rather than sitting disabled.
  $("soundAddDescription").hidden = sound.ToneDescriptors.length >= 3;
}
function refreshStatus() {
  const dirty = soundDraftDirty();
  $("soundPresetSummary").textContent = sound.Name;
  $("soundDraftStatus").textContent = dirty ? "Unsaved changes" : "";
  $("soundDraftStatus").dataset.dirty = String(dirty);
  const errors = [];
  if (!sound.Name.trim()) errors.push("Enter a preset name.");
  const volumeValid = soundVolumeValid(sound.Volume);
  if (!volumeValid) errors.push("Volume must be within −12–36.");
  $("soundVolumeNumber").setAttribute("aria-invalid", String(!volumeValid));
  for (const [slot, device] of Object.entries(sound.GearList)) for (const knob of GEAR_DATA[device.Key].Knobs || []) {
    if (!knobValueValid(knob, device.KnobValues[knob.Key])) errors.push(`${slotLabel(slot)}: ${knob.Name} must be ${knob.EnumValues ? "a listed option" : `${knob.MinValue}–${knob.MaxValue}`}.`);
  }
  $("soundValidation").textContent = errors.join(" "); $("soundValidation").hidden = !errors.length;
  window.dispatchEvent(new Event("settings-draft-changed"));
}
function render() {
  renderPresets();
  $("soundName").value = sound.Name;
  $("soundVolume").value = sound.Volume == null ? "0" : String(-Number(sound.Volume));
  $("soundVolumeNumber").value = sound.Volume == null ? "" : String(-Number(sound.Volume));
  $("soundLibraryWarning").hidden = !librarySnapshot.error && !librarySnapshot.unavailable.length;
  $("soundLibraryWarning").textContent = librarySnapshot.error ? "The saved preset library could not be read. Existing data will be protected." : "Some saved presets could not be loaded. Their stored data will be preserved.";
  $("soundDelete").disabled = !own();
  $("soundDelete").title = own() ? "Delete preset" : projectOwn() ? "Remove project presets at their tone switches" : "Only your own presets can be deleted";
  if (!sound.GearList[activeSlot]) activeSlot = "Amp";
  renderDescriptors(); renderChain(); renderDevice({ resetScroll: true });
  refreshStatus();
}

export function init_sound_designer() {
  $("soundImport").addEventListener("click", () => $("soundImportFiles").click());
  $("soundImportFiles").addEventListener("change", () => importPresetFiles([...$("soundImportFiles").files]));
  $("soundExport").addEventListener("click", () => exportPresets());
  initCollapsibleSections($("spSounds"), SECTIONS_KEY);
  const volume = $("soundVolume"); volume.setAttribute("aria-label", "Tone volume");
  const volumeScale = parameterSlider(volume.cloneNode(), {
    min: -12, max: 36, step: 0.1, defaultValue: 0, format: value => `${value} dB`,
    onDefault: () => { $("soundVolume").value = "0"; $("soundVolume").dispatchEvent(new Event("input")); },
  });
  volume.replaceWith(volumeScale);
  $("soundGearDialog").addEventListener("close", () => { pendingBank = null; pickerKey = null; });
  // The large view borrows the workbench and returns it on close.
  $("soundExpandDevice").addEventListener("click", () => {
    $("soundDeviceDialogTitle").textContent = `${slotLabel(activeSlot)} · ${gearName(sound.GearList[activeSlot].Key)}`;
    $("soundDeviceDialogBody").append($("soundDeviceEditor").closest(".sound-workbench"));
    sizeDeviceDialog(); $("soundDeviceDialog").showModal(); $("soundDeviceDialogClose").focus();
  });
  $("soundDeviceDialogClose").addEventListener("click", () => $("soundDeviceDialog").close());
  $("soundDeviceDialog").addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); $("soundDeviceDialog").close(); }
  });
  $("soundDeviceDialog").addEventListener("close", () => {
    $("soundWorkbenchHome").append($("soundDeviceEditor").closest(".sound-workbench")); deviceOverflow();
    $("soundExpandDevice").hidden || $("soundExpandDevice").focus();
  });
  const resizeDeviceDialog = () => { if ($("soundDeviceDialog").open) sizeDeviceDialog(); };
  new ResizeObserver(resizeDeviceDialog).observe($("settingsModal").querySelector(".settings-layout > .dialog-body"));
  window.addEventListener("resize", resizeDeviceDialog);
  const overflow = new ResizeObserver(deviceOverflow);
  overflow.observe($("soundDeviceEditor").closest(".sound-workbench")); overflow.observe($("soundDevices"));
  overflow.observe($("spSounds"));
  $("spSounds").addEventListener("scroll", deviceOverflow, { passive: true });
  $("soundChain").addEventListener("scroll", chainOverflow, { passive: true });
  new ResizeObserver(chainOverflow).observe($("soundChain"));
  $("soundGearClose").addEventListener("click", () => $("soundGearDialog").close());
  $("soundGearDialog").addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); $("soundGearDialog").close(); }
  });
  $("soundGearSelect").addEventListener("change", () => { pickerKey = $("soundGearSelect").value; syncGearApply(); });
  $("soundGearSelect").addEventListener("dblclick", event => { if (event.target.closest("option")) $("soundGearApply").click(); });
  $("soundGearSelect").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); $("soundGearApply").click(); } });
  $("soundGearApply").addEventListener("click", () => {
    const key = $("soundGearSelect").value;
    if (!key) return;
    const bank = pendingBank;
    if (bank) {
      if (effectCount() >= MAX_EFFECTS) return;
      activeSlot = `${bank}${effectBank(sound.GearList, bank).length + 1}`;
    } else if (key === sound.GearList[activeSlot].Key || activeSlot === "Cabinet" && GEAR_DATA[key].Name === GEAR_DATA[sound.GearList.Cabinet.Key].Name) {
      $("soundGearDialog").close(); return;
    }
    sound.GearList[activeSlot] = cloneSound(GEAR[key]); pendingBank = null;
    $("soundGearDialog").close(); changed(); render(); focusActiveCard();
  });
  $("soundNew").addEventListener("click", newPreset);
  $("soundPreset").addEventListener("change", () => choose($("soundPreset").value));
  $("soundDuplicate").addEventListener("click", duplicate);
  $("soundName").addEventListener("input", () => { if (!sound) return; sound.Name = $("soundName").value; changed({ keepName: true }); renderPresets(); });
  $("soundVolume").addEventListener("input", () => {
    if (!sound) return;
    sound.Volume = String(-Number($("soundVolume").value)); $("soundVolumeNumber").value = $("soundVolume").value; changed();
  });
  $("soundVolumeNumber").addEventListener("input", () => {
    if (!sound) return;
    const input = $("soundVolumeNumber");
    sound.Volume = input.value === "" ? null : String(-Number(input.value));
    input.setAttribute("aria-invalid", String(!input.validity.valid || input.value === ""));
    $("soundVolume").value = input.value; changed();
  });
  $("soundGearSearch").addEventListener("input", () => { filter = $("soundGearSearch").value; renderGearOptions(); });
  $("soundDevices").addEventListener("input", () => $("soundDevices").querySelector(".sound-eq-graph")?.sync());
  $("soundGearCategory").addEventListener("change", () => { category = $("soundGearCategory").value; renderGearOptions(); });
  $("soundAddDescription").addEventListener("click", () => {
    const unused = DESCRIPTORS.find(description => !sound.ToneDescriptors.includes(description.UIName));
    sound.ToneDescriptors.push(unused?.UIName || "$[35724]LEAD"); changed(); renderDescriptors();
    $("soundDescriptors").querySelector(".sound-tag:last-child select").focus();
  });
  $("soundDelete").addEventListener("click", async () => {
    const entry = own();
    if (!entry || !await confirmAction({ title: "Delete preset?", message: `Delete “${entry.tone.Name}” from your library? Project copies are kept.`, confirmLabel: "Delete preset", danger: true })) return;
    library = library.filter(item => item.id !== entry.id);
    selected = library[0]?.id || Object.keys(startingPoints)[0]; sound = cloneSound(own()?.tone || startingPoints[selected]); baseline = cloneSound(sound); activeSlot = "Amp"; render();
  });
}
