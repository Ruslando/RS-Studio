// Keep the panel on the perimeter of the plot, clear of its pitch rulers.
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
export function dockBounds(width, height, panelWidth, panelHeight) {
  const inset = Math.min(52, Math.max(8, (width - panelWidth) / 2));
  return { left: inset, right: Math.max(inset, width - inset - panelWidth),
    top: 8, bottom: Math.max(8, height - 8 - panelHeight) };
}
export function dockPosition(bounds, edge, fraction) {
  fraction = clamp(fraction, 0, 1);
  return { x: edge === 'left' ? bounds.left : edge === 'right' ? bounds.right
    : bounds.left + (bounds.right - bounds.left) * fraction,
  y: edge === 'top' ? bounds.top : edge === 'bottom' ? bounds.bottom
    : bounds.top + (bounds.bottom - bounds.top) * fraction };
}
export function nearestDock(bounds, x, y) {
  x = clamp(x, bounds.left, bounds.right); y = clamp(y, bounds.top, bounds.bottom);
  const distances = [['top', y - bounds.top], ['right', bounds.right - x],
    ['bottom', bounds.bottom - y], ['left', x - bounds.left]];
  const edge = distances.sort((a, b) => a[1] - b[1])[0][0];
  const horizontal = edge === 'top' || edge === 'bottom';
  const fraction = horizontal ? (x - bounds.left) / (bounds.right - bounds.left || 1)
    : (y - bounds.top) / (bounds.bottom - bounds.top || 1);
  return { edge, fraction };
}
