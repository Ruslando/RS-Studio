// Settings → Tunings. The list of tunings on the left, the selected one's editor
// on the right. Everything edits a draft: Settings' Apply saves it, Cancel and
// Escape drop it, and no layer or saved tuning changes before then.
//
// Your own tunings change in place. A built-in one never changes: editing it
// starts a copy ("fork") that is kept only through "Save", as a new tuning.
// Leaving an unsaved fork asks first.
//
// A tuning is its open strings, not its name: two tunings with the same strings
// are one tuning. Saving strings that another tuning already has is refused,
// whatever it is called (clashOf).
import { ESC_DEPTH, registerEscapeLayer } from "./escape-stack.js";
import { confirmAction } from "./dialog.js";
import { toast } from "./notify.js";
import { icon } from "./icons.js";
import { renderLayerSettings } from "./lanes.js";
import { refreshSaveState } from "./project.js";
import { draw } from "./repaint.js";
import { S } from "./store.js";
import { TUNINGS, customTunings, laneTuning, newTuningId, parseTuning, refreshTabIfOpen, replaceCustomTunings, tuningKeyFor, tuningToNames } from "./tablature.js";
import { noteName, notesLowToHigh } from "./util.js";

// C0..E6: low enough for a 5/6-string bass (B0 = 23), high enough for any guitar.
const NOTE_MIN = 12, NOTE_MAX = 88;
// Picking an instrument or a string count starts from that standard tuning
// (highest string first, as stored).
const STANDARD = {
  guitar: { 6: [64, 59, 55, 50, 45, 40], 7: [64, 59, 55, 50, 45, 40, 35], 8: [64, 59, 55, 50, 45, 40, 35, 30] },
  bass: { 4: [43, 38, 33, 28], 5: [43, 38, 33, 28, 23], 6: [48, 43, 38, 33, 28, 23] },
};
const DEFAULT_STRINGS = { guitar: 6, bass: 4 };
const INSTRUMENT_LABEL = { guitar: "Guitar", bass: "Bass" };
const standard = (instrument, count) => (STANDARD[instrument][count] || STANDARD[instrument][DEFAULT_STRINGS[instrument]]).slice();
// Tunings saved before the field existed: a top string below D3 is a bass.
const instrumentOf = (t, midis) => t.instrument || (midis[0] < 50 ? "bass" : "guitar");
const builtinInstrument = (key) => (key.startsWith("bass") ? "bass" : "guitar");

const listEl = document.getElementById("tuningList");
const editorEl = document.getElementById("tuningEditor");
const newBtn = document.getElementById("tuningNewBtn");
const STRING_ORDER_KEY = "cw.tuningStringOrder";
let stringOrder = "low-bottom";
try { if (localStorage.getItem(STRING_ORDER_KEY) === "low-top") stringOrder = "low-top"; } catch { /* private mode */ }

let draft = null;   // your tunings as edited: [{ id, name, notes, instrument }]
let sel = null;     // { id } of one of yours, or { key } of a built-in
let fork = null;    // an edited built-in: { key, name, midis, instrument }
let draftBaseline = "";

const builtinName = (key) => TUNINGS[key].label.replace(/\s*\(.*\)$/, "");
const sameMidis = (a, b) => a.length === b.length && a.every((p, i) => p === b[i]);
const allNames = () => [...draft.map((t) => t.name), ...Object.keys(TUNINGS).map(builtinName)]
  .map((n) => n.trim().toLowerCase());
const uniqueName = (base) => {
  const taken = new Set(allNames());
  for (let i = 1; ; i++) { const n = i === 1 ? base : `${base} ${i}`; if (!taken.has(n.toLowerCase())) return n; }
};
// The other tuning with these strings: a built-in, or another of yours. Its name, or null.
function clashOf(midis, exceptId = null) {
  const key = Object.keys(TUNINGS).find((k) => sameMidis(TUNINGS[k].tuning, midis));
  if (key) return builtinName(key);
  return draft.find((t) => t.id !== exceptId && sameMidis(parseTuning(t.notes) || [], midis))?.name || null;
}
const lanesUsing = (id) => (S.state?.editLanes || []).filter((lane) => lane.tuning === id);
const mine = () => (sel?.id ? draft.find((t) => t.id === sel.id) : null);
const forkDirty = () => !!fork && (fork.name !== builtinName(fork.key) || !sameMidis(fork.midis, TUNINGS[fork.key].tuning)
  || fork.instrument !== builtinInstrument(fork.key));

function current() {
  const t = mine();
  if (t) { const midis = parseTuning(t.notes) || standard("guitar", 6); return { name: t.name, midis, instrument: instrumentOf(t, midis) }; }
  if (fork) return { name: fork.name, midis: fork.midis, instrument: fork.instrument };
  return { name: builtinName(sel.key), midis: TUNINGS[sel.key].tuning.slice(), instrument: builtinInstrument(sel.key) };
}

function edit(patch) {
  const t = mine();
  if (t) {
    if (patch.name != null) t.name = patch.name;
    if (patch.midis) t.notes = tuningToNames(patch.midis);
    if (patch.instrument) t.instrument = patch.instrument;
  } else {
    fork = fork || { key: sel.key, ...current() };
    Object.assign(fork, patch);
  }
  window.dispatchEvent(new Event("settings-draft-changed"));
}

// ---- lifecycle (called by the Settings window) ----

export function beginTuningDraft(selectKey) {
  draft = customTunings.map((t) => ({ ...t }));
  draftBaseline = JSON.stringify(draft);
  fork = null;
  sel = draft.some((t) => t.id === selectKey) ? { id: selectKey }
    : TUNINGS[selectKey] ? { key: selectKey }
    : draft[0] ? { id: draft[0].id } : { key: "guitar6" };
  render();
}
export const tuningDraftOpen = () => !!draft;
export const tuningDraftDirty = () => !!draft && (JSON.stringify(draft) !== draftBaseline || forkDirty());
export function dropTuningDraft() { draft = null; fork = null; sel = null; }

// Apply: false when an unsaved built-in edit made the user stay.
export async function saveTuningDraft({ keepOpen = false } = {}) {
  if (!draft) return true;
  if (forkDirty() && !(await confirmDiscard())) return false;
  const twin = draft.find((t) => clashOf(parseTuning(t.notes) || [], t.id));
  if (twin) {
    toast(`“${twin.name}” has the same strings as “${clashOf(parseTuning(twin.notes) || [], twin.id)}”. Change them or delete it.`, 6000, "error");
    if (sel?.id !== twin.id) await select({ id: twin.id });
    return false;
  }
  const before = new Map(customTunings.map((t) => [t.id, t.notes]));
  const after = new Map(draft.map((t) => [t.id, t]));
  const lanes = S.state?.editLanes || [];
  // A deleted tuning a layer still uses keeps its strings as an unnamed tuning
  // rather than falling back to standard. Delete is refused for a tuning in
  // use, so this is the fallback, not the rule.
  for (const lane of lanes)
    if (before.has(lane.tuning) && !after.has(lane.tuning)) {
      lane.customTuning = tuningToNames(laneTuning(lane));
      lane.tuning = "custom";
    }
  replaceCustomTunings(draft);
  for (const lane of lanes) {
    const t = after.get(lane.tuning);
    if (t && before.get(t.id) !== t.notes) { lane.customTuning = t.notes; }
    // Bare strings a tuning now has are that tuning.
    if (lane.tuning === "custom") lane.tuning = tuningKeyFor(laneTuning(lane)) || "custom";
  }
  if (keepOpen) beginTuningDraft(sel?.id || sel?.key); else dropTuningDraft();
  renderLayerSettings(); draw(); refreshTabIfOpen(); refreshSaveState();
  return true;
}

const confirmDiscard = () => confirmAction({
  title: "Discard changes?",
  message: `Your changes to “${builtinName(fork.key)}” are not saved. Built-in tunings stay as they are; use “Save” to keep the changes as your own tuning.`,
  confirmLabel: "Discard", danger: true,
});

async function select(target) {
  if (forkDirty() && !(await confirmDiscard())) return false;
  fork = null;
  sel = target;
  render();
  return true;
}

// ---- actions ----

// A new tuning is always a 6-string guitar in E standard; the editor changes the
// rest. Until its strings differ from every other tuning's, Apply refuses it.
async function newTuning() {
  const t = { id: newTuningId(), name: uniqueName("New tuning"), notes: tuningToNames(standard("guitar", 6)), instrument: "guitar" };
  if (forkDirty() && !(await confirmDiscard())) return;
  fork = null;
  draft.push(t);
  sel = { id: t.id };
  render();
  editorEl.querySelector(".tuning-name")?.select();
}

// An edited built-in becomes a tuning of your own (Save is refused while its
// strings are another tuning's; see syncSave).
function save() {
  const { name, midis, instrument } = current();
  const t = { id: newTuningId(), name: name.trim(), notes: tuningToNames(midis), instrument };
  draft.push(t);
  fork = null;
  sel = { id: t.id };
  render();
}

function remove() {
  const i = draft.findIndex((t) => t.id === sel.id);
  draft.splice(i, 1);
  const next = draft[Math.min(i, draft.length - 1)];
  sel = next ? { id: next.id } : { key: "guitar6" };
  render();
}

// ---- rendering ----

function render() {
  if (!draft) return;
  renderList();
  renderEditor();
  window.dispatchEvent(new Event("settings-draft-changed"));
}

function listItem(target, name, midis, selected) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tuning-item";
  b.setAttribute("role", "option");
  b.setAttribute("aria-selected", String(selected));
  b.tabIndex = selected ? 0 : -1;
  const n = document.createElement("span"); n.className = "tuning-item-name"; n.textContent = name;
  const notes = document.createElement("span"); notes.className = "tuning-item-notes"; notes.textContent = notesLowToHigh(midis);
  b.append(n, notes);
  b.addEventListener("click", () => { if (!selected) select(target); });
  return b;
}

function group(title, items) {
  if (!items.length) return [];
  const h = document.createElement("div");
  h.className = "tuning-group-head";
  h.textContent = title;
  return [h, ...items];
}

function renderList() {
  const yours = draft.map((t) => listItem({ id: t.id }, t.name || "Untitled", parseTuning(t.notes) || [], sel.id === t.id));
  const groups = new Map();   // "Guitar · 6 strings" -> rows, built-ins in table order
  for (const [key, def] of Object.entries(TUNINGS)) {
    const n = def.tuning.length, inst = builtinInstrument(key);
    const title = `${INSTRUMENT_LABEL[inst]} · ${n} strings`;
    if (!groups.has(title)) groups.set(title, { order: (inst === "bass" ? 0 : 100) + n, rows: [] });
    // An edited built-in shows its edits in the list too, so the row matches the editor.
    const midis = fork?.key === key ? fork.midis : def.tuning;
    groups.get(title).rows.push(listItem({ key }, builtinName(key), midis, sel.key === key));
  }
  listEl.replaceChildren(
    ...group("Your tunings", yours),
    ...[...groups].sort(([, a], [, b]) => a.order - b.order).flatMap(([title, g]) => group(title, g.rows)),
  );
}

const stepBtn = (text, title, on, disabled = false) => {
  const b = document.createElement("button");
  b.type = "button"; b.className = "stepper-btn"; b.innerHTML = text;
  b.title = title; b.setAttribute("aria-label", title); b.disabled = disabled;
  b.addEventListener("click", on);
  return b;
};

function selectOf(options, value, onPick, className = "") {
  const s = document.createElement("select");
  if (className) s.className = className;
  for (const [v, label] of options) s.append(new Option(label, String(v)));
  s.value = String(value);
  s.addEventListener("change", () => onPick(s.value));
  return s;
}

// A <label> for one control; a plain group (tag "div") for several. `reset`, when
// given, puts a ↺ beside the caption (shown by the caller when there is a change).
const field = (label, control, tag = "label", reset = null) => {
  const l = document.createElement(tag);
  l.className = "field-group block";
  const head = document.createElement("span");
  head.className = "tuning-field-head";
  head.append(label);
  if (reset) head.append(reset);
  l.append(head, control);
  return l;
};

function resetBtn(title, on, shown) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "field-revert"; b.title = title; b.setAttribute("aria-label", title);
  b.innerHTML = icon("return", 14);
  b.hidden = !shown;
  b.addEventListener("click", (e) => { e.preventDefault(); on(); });
  return b;
}

// What a reset goes back to: the tuning as saved, or the built-in as shipped. A
// tuning added in this session has nothing to go back to.
function original() {
  if (!sel.id) return { name: builtinName(sel.key), midis: TUNINGS[sel.key].tuning.slice(), instrument: builtinInstrument(sel.key) };
  const saved = customTunings.find((c) => c.id === sel.id);
  if (!saved) return null;
  const midis = parseTuning(saved.notes) || standard("guitar", 6);
  return { name: saved.name, midis, instrument: instrumentOf(saved, midis) };
}

function closePitchPicker() {
  const picker = editorEl.querySelector('.tuning-pitch-picker:not([hidden])');
  if (!picker || picker.closest('[hidden]')) return false;
  picker.hidden = true;
  const button = picker.closest('.tuning-string-row').querySelector('.tuning-pitch');
  button.setAttribute('aria-expanded', 'false');
  button.focus({ preventScroll: true });
  return true;
}
registerEscapeLayer(ESC_DEPTH.popover, closePitchPicker);

function renderEditor() {
  const t = mine();
  const { name, midis, instrument } = current();
  const builtin = !t;
  const set = (patch) => { edit(patch); render(); };
  const o = original();

  const nameIn = document.createElement("input");
  nameIn.type = "text"; nameIn.className = "tuning-name"; nameIn.value = name; nameIn.placeholder = "Name";
  const nameReset = resetBtn(`Reset to “${o?.name}”`, () => set({ name: o.name }), o && o.name !== name);
  nameIn.addEventListener("input", () => {
    edit({ name: nameIn.value }); renderList(); syncSave();
    nameReset.hidden = !o || o.name === nameIn.value;
  });

  // Instrument and string count each reset the strings to that standard tuning.
  const counts = new Set([...Object.keys(STANDARD[instrument]).map(Number), midis.length]);
  const shape = document.createElement("div");
  shape.className = "tuning-shape";
  // Instrument and string count reset together with the strings: picking either
  // replaced the strings, so going back has to bring the strings back too.
  const back = () => set({ instrument: o.instrument, midis: o.midis });
  shape.append(
    field("Instrument", selectOf(Object.entries(INSTRUMENT_LABEL), instrument,
      (v) => set({ instrument: v, midis: standard(v, DEFAULT_STRINGS[v]) })),
    "label", resetBtn(`Reset to ${INSTRUMENT_LABEL[o?.instrument]}`, back, o && o.instrument !== instrument)),
    field("Strings", selectOf([...counts].sort((a, b) => a - b).map((n) => [n, String(n)]), midis.length,
      (v) => set({ midis: standard(instrument, Number(v)) })),
    "label", resetBtn(`Reset to ${o?.midis.length} strings`, back, o && o.midis.length !== midis.length)),
  );

  // Keep physical string numbers and storage order independent of display order.
  const strings = document.createElement("div");
  strings.className = "tuning-strings";
  const ordered = midis.map((p, index) => ({ p, index }));
  if (stringOrder === "low-top") ordered.reverse();
  ordered.forEach(({ p, index }) => {
    const number = index + 1;
    const row = document.createElement("div");
    row.className = "tuning-string-row";
    row.dataset.string = String(number);
    const pick = (v, focus, expanded = false) => {
      const m = midis.slice(); m[index] = Math.max(NOTE_MIN, Math.min(NOTE_MAX, v));
      set({ midis: m });
      const next = editorEl.querySelector(`[data-string="${number}"]`);
      if (expanded) next.querySelector('.tuning-pitch').click();
      const target = next.querySelector(focus);
      (target?.disabled ? next.querySelector('.tuning-pitch') : target)?.focus({ preventScroll: true });
    };
    const line = document.createElement("div");
    line.className = "tuning-string-line";
    const label = document.createElement("span");
    label.className = "tuning-string-label";
    const num = document.createElement("span");
    num.className = "tuning-string-number"; num.textContent = String(number);
    label.append(num);
    if (number === 1 || number === midis.length) {
      const end = document.createElement("span");
      end.className = "tuning-string-end"; end.textContent = number === 1 ? "Highest" : "Lowest";
      label.append(end);
    }
    const controls = document.createElement("div");
    controls.className = "tuning-string-controls";
    const down = stepBtn(icon("minus", 14), `String ${number} down a semitone`, () => pick(p - 1, '.tuning-string-down'), p <= NOTE_MIN);
    down.className = "tuning-string-step tuning-string-down";
    const up = stepBtn(icon("plus", 14), `String ${number} up a semitone`, () => pick(p + 1, '.tuning-string-up'), p >= NOTE_MAX);
    up.className = "tuning-string-step tuning-string-up";
    const pitch = document.createElement("button");
    pitch.type = "button"; pitch.className = "tuning-pitch"; pitch.textContent = noteName(p);
    pitch.setAttribute("aria-label", `String ${number}: ${noteName(p)}. Choose pitch`);
    pitch.setAttribute("aria-expanded", "false");
    pitch.setAttribute("aria-controls", `tuningPitch${number}`);
    const picker = document.createElement("div");
    picker.className = "tuning-pitch-picker"; picker.id = `tuningPitch${number}`; picker.hidden = true;
    const octave = Math.floor(p / 12) - 1;
    const noteOptions = Array.from({ length: 12 }, (_, n) => [n, noteName(60 + n).replace(/\d+$/, '')]);
    const note = selectOf(noteOptions, p % 12,
      v => pick((octave + 1) * 12 + Number(v), '.tuning-note', true), 'tuning-note');
    for (const option of note.options) option.disabled = (octave + 1) * 12 + Number(option.value) > NOTE_MAX;
    note.setAttribute('aria-label', `String ${number} note`);
    const oct = selectOf(Array.from({ length: 7 }, (_, n) => [n, String(n)]), octave,
      v => pick((Number(v) + 1) * 12 + p % 12, '.tuning-octave', true), 'tuning-octave');
    for (const option of oct.options) option.disabled = (Number(option.value) + 1) * 12 + p % 12 > NOTE_MAX;
    oct.setAttribute('aria-label', `String ${number} octave`);
    picker.append(field('Note', note), field('Octave', oct));
    pitch.addEventListener('click', () => {
      const open = picker.hidden;
      closePitchPicker();
      picker.hidden = !open;
      pitch.setAttribute('aria-expanded', String(open));
      if (open) note.focus({ preventScroll: true });
    });
    controls.append(down, pitch, up);
    line.append(label, controls);
    row.append(line, picker);
    strings.append(row);
  });

  const shift = (d) => {
    set({ midis: midis.map((p) => Math.max(NOTE_MIN, Math.min(NOTE_MAX, p + d))) });
    const button = editorEl.querySelectorAll('.tuning-whole-btn')[d > 0 ? 1 : 0];
    (button.disabled ? editorEl.querySelector('.tuning-pitch') : button).focus({ preventScroll: true });
  };
  const whole = document.createElement("div");
  whole.className = "tuning-whole";
  const wholeBtn = (text, title, d, disabled) => {
    const b = stepBtn(text, title, () => shift(d), disabled);
    b.className = "tuning-whole-btn";
    return b;
  };
  whole.append(
    wholeBtn("−½ step", "Every string down a semitone", -1, midis.some((p) => p <= NOTE_MIN)),
    wholeBtn("+½ step", "Every string up a semitone", 1, midis.some((p) => p >= NOTE_MAX)),
  );

  // Actions
  const actions = document.createElement("div");
  actions.className = "tuning-actions";
  let saveBtn = null;
  const twin = clashOf(midis, t?.id);
  const syncSave = () => {
    if (!saveBtn) return;
    const n = (fork?.name ?? name).trim();
    saveBtn.disabled = !n || !!twin;
    saveBtn.title = !n ? "Give it a name first"
      : twin ? `“${twin}” already has these strings. Change them to save a tuning of your own.`
      : "Save as your own tuning";
  };
  if (builtin) {
    saveBtn = document.createElement("button");
    saveBtn.type = "button"; saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", save);
    actions.append(saveBtn);
    syncSave();
  } else {
    const users = lanesUsing(t.id);
    const del = document.createElement("button");
    del.type = "button"; del.className = "danger"; del.textContent = "Delete";
    del.disabled = users.length > 0;
    del.title = users.length
      ? `In use by ${users.map((l) => `“${l.name}”`).join(", ")}. Give ${users.length === 1 ? "that layer" : "those layers"} another tuning first.`
      : "Delete this tuning";
    del.addEventListener("click", remove);
    actions.append(del);
  }

  const stringsReset = resetBtn(`Reset to ${o ? notesLowToHigh(o.midis) : ""}`,
    () => set({ instrument: o.instrument, midis: o.midis }), o && !sameMidis(o.midis, midis));
  // One of yours whose strings another tuning has cannot be kept: said where it is.
  const clash = document.createElement("div");
  clash.className = "status-line status-line--warn";
  clash.setAttribute("role", "status");
  clash.textContent = `“${twin}” already has these strings. Change them, or this tuning cannot be kept.`;
  const stringFields = field("Open strings", strings, "div", stringsReset);
  stringFields.classList.add('tuning-string-section');
  const stringHead = document.createElement('div');
  stringHead.className = 'tuning-strings-head';
  const order = selectOf([['low-bottom', 'Lowest at bottom'], ['low-top', 'Lowest at top']], stringOrder, value => {
    stringOrder = value;
    try { localStorage.setItem(STRING_ORDER_KEY, value); } catch { /* private mode / quota */ }
    renderEditor();
    document.getElementById('tuningStringOrder').focus({ preventScroll: true });
  });
  order.id = 'tuningStringOrder';
  order.setAttribute('aria-label', 'String order');
  const tools = document.createElement('div');
  tools.className = 'tuning-string-tools';
  tools.append(order, whole);
  stringHead.append(stringFields.firstElementChild, tools);
  stringFields.prepend(stringHead);
  editorEl.replaceChildren(field("Name", nameIn, "label", nameReset), shape, stringFields,
    ...(twin && !builtin ? [clash] : []), actions);
}

// ↑/↓ walk the list; the editor follows.
listEl.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...listEl.querySelectorAll(".tuning-item")];
  const i = items.findIndex((b) => b.getAttribute("aria-selected") === "true");
  const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
  if (next && next !== items[i]) next.click();
  requestAnimationFrame(() => listEl.querySelector('.tuning-item[aria-selected="true"]')?.focus());
});

newBtn.addEventListener("click", () => newTuning());
