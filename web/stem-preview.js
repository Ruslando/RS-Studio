// The audio-preview scrubber, shared by the two places
// that show a stem: the New Project stem cards and the stem-settings panel.
//
// Those two implemented the same three-state widget against the same CSS classes
// and had drifted into near-identical copies of six functions — identical apart
// from where the state lived (`card._pos` in one, `stemEditPos` in the other),
// which is why a plain duplication scan never spotted it. Both call these now.
//
// The state stays with the caller. A widget here is a `root` element plus two
// accessors, so a card can keep its state on the element and the panel can keep
// its state in module variables, without either shape leaking into the other.

// Play / pause glyphs for a preview button.
export function previewIcon(mode) {
  return mode === "play"
    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>';
}

export function fmtPreviewTime(s) {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
}

/**
 * Repaint the scrub bar from the caller's current position/duration.
 * @param {Element} root  the element holding .sc-scrub / .sc-scrub-fill / .sc-scrub-handle / .sc-time
 * @param {number} pos    seconds
 * @param {number} dur    seconds, or NaN before metadata loads
 */
export function syncScrub(root, pos, dur) {
  const scrubEl = root.querySelector(".sc-scrub");
  const fill = root.querySelector(".sc-scrub-fill");
  const handle = root.querySelector(".sc-scrub-handle");
  const time = root.querySelector(".sc-time");
  const at = pos || 0;
  const pct = Number.isFinite(dur) && dur > 0 ? Math.min(100, (at / dur) * 100) : 0;
  if (fill) fill.style.width = pct + "%";
  if (handle) handle.style.left = pct + "%";
  if (time) time.textContent = fmtPreviewTime(at) + " / " + fmtPreviewTime(dur);
  if (scrubEl && Number.isFinite(dur)) {
    scrubEl.setAttribute("aria-valuemax", String(Math.round(dur)));
    scrubEl.setAttribute("aria-valuenow", String(Math.round(at)));
  }
}

/**
 * Wire pointer drag and arrow keys on the scrub bar.
 * @param {Element} root
 * @param {() => number} duration   current duration, in seconds
 * @param {() => number} position   current position, in seconds
 * @param {(seconds: number) => void} seek  move to a position; the caller repaints
 */
export function wireScrub(root, duration, position, seek) {
  const scrubEl = root.querySelector(".sc-scrub");
  if (!scrubEl) return;
  const seekFrac = (frac) => {
    const dur = duration();
    if (!Number.isFinite(dur) || dur <= 0) return;
    seek(Math.min(dur, Math.max(0, frac * dur)));
  };
  const fracFromEvent = (e) => {
    const r = scrubEl.getBoundingClientRect();
    return r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
  };
  const onMove = (e) => seekFrac(fracFromEvent(e));
  scrubEl.addEventListener("pointerdown", (e) => {
    // Pointer capture keeps the drag alive when the cursor leaves the 6px-tall bar.
    scrubEl.setPointerCapture(e.pointerId);
    seekFrac(fracFromEvent(e));
    scrubEl.addEventListener("pointermove", onMove);
  });
  const endDrag = (e) => {
    scrubEl.removeEventListener("pointermove", onMove);
    if (scrubEl.hasPointerCapture(e.pointerId)) scrubEl.releasePointerCapture(e.pointerId);
  };
  scrubEl.addEventListener("pointerup", endDrag);
  scrubEl.addEventListener("pointercancel", endDrag);
  scrubEl.addEventListener("keydown", (e) => {
    const dur = duration();
    if (!Number.isFinite(dur)) return;
    if (e.key === "ArrowRight") { e.preventDefault(); seekFrac((position() + 1) / dur); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); seekFrac((position() - 1) / dur); }
  });
}

