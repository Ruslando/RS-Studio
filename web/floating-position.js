// All live editors use the same click anchor and viewport gutter.
export function floatingBounds(x, y, width, height, viewportWidth, viewportHeight, gap = 6) {
  const gutter = 8;
  return {
    left: Math.max(gutter, Math.min(x, viewportWidth - width - gutter)),
    top: Math.max(gutter, Math.min(y + gap, viewportHeight - height - gutter)),
  };
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
  const { x, y, gap } = anchors.get(panel);
  const { left, top } = floatingBounds(x, y, panel.offsetWidth, panel.offsetHeight, window.innerWidth, window.innerHeight, gap);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}
export function placeFloating(panel, x, y, gap = 6) {
  anchors.set(panel, { x, y, gap });
  if (!observer) {
    observer = new ResizeObserver((entries) => entries.forEach(({ target }) => position(target)));
    window.addEventListener('resize', () => anchors.forEach((_, element) => position(element)));
  }
  observer.observe(panel);
  position(panel);
}
