// Snapshot and restore live settings through their original input/change events.
export const snapshotInputs = (root) => [...root.querySelectorAll("input, select")]
  .filter((el) => !el.closest("[hidden]") && !el.closest("#spTunings, #spSounds, #soundGearDialog, #soundFileActions, #spModels"))
  .map((el) => ({ el, v: ["checkbox", "radio"].includes(el.type) ? el.checked : el.value }));

// Put each value back and re-fire the event that applied it, so persistence and
// live preview walk backwards together — no second code path to keep in sync.
export function revertInputs(snap) {
  for (const { el, v } of snap || []) {
    const checked = ["checkbox", "radio"].includes(el.type);
    if ((checked ? el.checked : el.value) === v) continue;
    if (checked) el.checked = v; else el.value = v;
    for (const type of ["input", "change"]) el.dispatchEvent(new Event(type, { bubbles: true }));
  }
}

export const inputsDirty = snapshot => (snapshot || []).some(({ el, v }) =>
  (["checkbox", "radio"].includes(el.type) ? el.checked : el.value) !== v);
