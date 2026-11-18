// Open native dropdowns on a completed click rather than on mouse-down.
// This avoids press-and-hold behaviour in the Windows desktop webview.
export function initSelectPickers() {
  let pendingPicker = null, wasOpen = null, pointerSelect = null, closing = null;
  const nativePicker = (target) => target?.closest?.("select");
  const onOption = (target) => !!target?.closest?.("option");   // a row of an open styled popup
  // A styled popup (base-select) lives in the page: a press on its open select is
  // the browser's to close it, so mouse-down leaves that press alone.
  const isOpen = (select) => { try { return select.matches(":open"); } catch { return false; } };
  document.addEventListener("pointerdown", (event) => {
    const select = nativePicker(event.target);
    wasOpen = select && !onOption(event.target) && isOpen(select) ? select : null;
    pointerSelect = select;
  }, true);
  // A dropdown used with the pointer hands focus back once it has done its job, so
  // the editor's keys (note traversal) work again; one reached with Tab keeps it.
  const release = (select) => {
    if (select === pointerSelect && select.contains(document.activeElement)) { select.blur(); pointerSelect = null; }
  };
  document.addEventListener("keydown", (event) => { if (event.key === "Tab") pointerSelect = null; }, true);
  // A chosen row hands focus back to its select as the popup closes: release after that.
  document.addEventListener("change", (event) => { const select = nativePicker(event.target); if (select) setTimeout(() => release(select)); });
  document.addEventListener("mousedown", (event) => {
    pendingPicker = null;
    if (onOption(event.target)) return;   // choosing a row is the browser's
    const select = nativePicker(event.target);
    closing = null;
    if (select && select === wasOpen) { closing = select; return; }   // the browser closes it
    if (event.button !== 0 || !select || select.disabled || select.multiple || select.size > 1 ||
        typeof select.showPicker !== "function") return;
    pendingPicker = select;
    event.preventDefault();
    select.focus({ preventScroll: true });
  });
  document.addEventListener("click", (event) => {
    const select = nativePicker(event.target);
    // A row chosen with the pointer, even the one already chosen (no change event).
    if (onOption(event.target)) { setTimeout(() => release(select)); return; }
    const pending = pendingPicker;
    pendingPicker = null;
    // After the browser's own mouse-down focus, so the release holds.
    if (closing && closing === select) { closing = null; release(select); return; }
    if (pending !== select || event.button !== 0 || event.detail === 0 || !select || select.disabled || select.multiple ||
        select.size > 1 || typeof select.showPicker !== "function") return;
    event.preventDefault();
    try { select.showPicker(); } catch { /* keyboard access remains available */ }
  });
}
