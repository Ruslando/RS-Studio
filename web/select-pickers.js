// Open native dropdowns on a completed click rather than on mouse-down.
// This avoids press-and-hold behaviour in the Windows desktop webview.
export function initSelectPickers() {
  let pendingPicker = null;
  const nativePicker = (target) => target?.closest?.("select");
  document.addEventListener("mousedown", (event) => {
    pendingPicker = null;
    const select = nativePicker(event.target);
    if (event.button !== 0 || !select || select.disabled || select.multiple || select.size > 1 ||
        typeof select.showPicker !== "function") return;
    pendingPicker = select;
    event.preventDefault();
    select.focus({ preventScroll: true });
  });
  document.addEventListener("click", (event) => {
    const select = nativePicker(event.target);
    const pending = pendingPicker;
    pendingPicker = null;
    if (pending !== select || event.button !== 0 || event.detail === 0 || !select || select.disabled || select.multiple ||
        select.size > 1 || typeof select.showPicker !== "function") return;
    event.preventDefault();
    try { select.showPicker(); } catch { /* keyboard access remains available */ }
  });
}
