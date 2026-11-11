// All live editors use the same click anchor and viewport gutter.
export function floatingBounds(x, y, width, height, viewportWidth, viewportHeight, gap = 6) {
  const gutter = 8;
  return {
    left: Math.max(gutter, Math.min(x, viewportWidth - width - gutter)),
    top: Math.max(gutter, Math.min(y + gap, viewportHeight - height - gutter)),
  };
}

// Place a comparison card around the notes it describes. Both note versions
// stay protected, so changing the preview does not move the card onto either.
export function avoidingBounds(rects, width, height, viewportWidth, viewportHeight, region = null, previous = null) {
  const viewport = { left: 8, top: 8, right: viewportWidth - 8, bottom: viewportHeight - 8 };
  const area = region ? { left: Math.max(8, region.left), top: Math.max(8, region.top),
    right: Math.min(viewport.right, region.right), bottom: Math.min(viewport.bottom, region.bottom) } : viewport;
  const visible = rects.filter(r => r.right > viewport.left && r.left < viewport.right && r.bottom > viewport.top && r.top < viewport.bottom);
  if (!visible.length) return floatingBounds(area.left, area.top, width, height, viewportWidth, viewportHeight, 0);
  const union = { left: Math.min(...visible.map(r => r.left)), right: Math.max(...visible.map(r => r.right)),
    top: Math.min(...visible.map(r => r.top)), bottom: Math.max(...visible.map(r => r.bottom)) };
  const gap = 10, candidates = previous ? [previous] : [];
  const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
  for (const box of [union, ...visible]) {
    for (const [x, y] of [
      [box.right + gap, box.top], [box.left - width - gap, box.top],
      [box.left, box.bottom + gap], [box.left, box.top - height - gap],
      [box.right - width, box.bottom + gap], [box.right - width, box.top - height - gap],
    ]) for (const bounds of [area, viewport]) candidates.push({
      left: clamp(x, bounds.left, bounds.right - width), top: clamp(y, bounds.top, bounds.bottom - height),
    });
  }
  const intersection = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const scored = candidates.map((point, order) => {
    const left = clamp(point.left, viewport.left, viewport.right - width), top = clamp(point.top, viewport.top, viewport.bottom - height);
    const box = { left, top, right: left + width, bottom: top + height };
    return { left, top, overlap: visible.reduce((sum, note) => sum + intersection(box, note), 0),
      outside: width * height - intersection(box, area), order };
  }).sort((a, b) => a.overlap - b.overlap || a.outside - b.outside || a.order - b.order);
  return { left: scored[0].left, top: scored[0].top };
}

const anchors = new Map();
let observer;
function position(panel) {
  if (!panel.isConnected) {
    observer?.unobserve(panel);
    anchors.delete(panel);
    return;
  }
  if (panel.hidden) return;
  const anchor = anchors.get(panel);
  const { x, y, gap } = anchor;
  const avoidance = anchor.avoidance?.();
  const { left, top } = avoidance
    ? avoidingBounds(avoidance.rects, panel.offsetWidth, panel.offsetHeight, window.innerWidth, window.innerHeight, avoidance.region, anchor.last)
    : floatingBounds(x, y, panel.offsetWidth, panel.offsetHeight, window.innerWidth, window.innerHeight, gap);
  anchor.last = { left, top };
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}
export function placeFloating(panel, x, y, gap = 6) {
  anchors.set(panel, { x, y, gap });
  watch(panel);
}
export function placeFloatingAvoiding(panel, avoidance, { reset = false } = {}) {
  anchors.set(panel, { avoidance, last: reset ? null : anchors.get(panel)?.last });
  watch(panel);
}
function watch(panel) {
  if (!observer) {
    observer = new ResizeObserver((entries) => entries.forEach(({ target }) => position(target)));
    window.addEventListener('resize', () => anchors.forEach((_, element) => position(element)));
  }
  observer.observe(panel);
  position(panel);
}
