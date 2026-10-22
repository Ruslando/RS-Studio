import assert from 'node:assert/strict';
import { dockBounds, dockPosition, nearestDock } from '../../web/edge-dock.js';
const bounds = dockBounds(1000, 600, 280, 150);
for (const [x, y, edge] of [[-50,200,'left'],[900,200,'right'],[300,-40,'top'],[300,800,'bottom']]) {
  const dock = nearestDock(bounds, x, y);
  assert.equal(dock.edge, edge);
  const position = dockPosition(bounds, dock.edge, dock.fraction);
  assert.ok(position.x >= bounds.left && position.x <= bounds.right);
  assert.ok(position.y >= bounds.top && position.y <= bounds.bottom);
}
const saved = nearestDock(bounds, 900, 300);
const smaller = dockBounds(700, 400, 280, 150);
const restored = dockPosition(smaller, saved.edge, saved.fraction);
assert.equal(restored.x, smaller.right, 'right dock survives viewport resize');
assert.ok(restored.y >= smaller.top && restored.y <= smaller.bottom);
assert.deepEqual(dockPosition(bounds, 'top', 5), { x: bounds.right, y: bounds.top });
console.log('Spectrogram edge docking stays on the perimeter across resizing');
