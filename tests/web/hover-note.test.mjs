import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

let covered = false, inert = false, referenceLocked = false;
const stage = { getBoundingClientRect: () => ({ left: 0, top: 0 }), closest: () => inert ? {} : null };
const scroll = { scrollLeft: 90, scrollTop: 0 };
const lane = { visible: true, notes: [
  { start: 1, end: 1.2, pitch: 64 }, { start: 2, end: 2.2, pitch: 64 },
] };
const S = { state: { lanes: [lane] }, mouseX: 100, lastPointerX: 10, lastPointerY: 30 };
const saved = globalThis.document;
try {
  globalThis.document = { elementFromPoint: () => covered ? {} : stage };
  const { hoveredStageNote } = await mockImport(new URL('../../web/interaction.js', import.meta.url), {
    './dom.js': { stage, scroll }, './store.js': { S },
    './lanes.js': { activeLane: () => lane },
    './geometry.js': { timeAt: x => x / 100, pitchAt: () => 64 },
    './marker-rails.js': { railsBottom: () => 20 },
    './references.js': { boxOfNote: () => referenceLocked ? { group: { locked: true } } : null },
  });
  assert.equal(hoveredStageNote(), lane.notes[0]);
  scroll.scrollLeft = 190;
  assert.equal(hoveredStageNote(), lane.notes[1], 'scrolling under a stationary pointer updates the target');
  covered = true;
  assert.equal(hoveredStageNote(), null, 'overlays prevent deleting a note behind them');
  covered = false; inert = true;
  assert.equal(hoveredStageNote(), null, 'modal dialogs disable hover deletion');
  inert = false; referenceLocked = true;
  assert.equal(hoveredStageNote(), null, 'locked references cannot be hover-deleted');
  referenceLocked = false; lane.locked = true;
  assert.equal(hoveredStageNote(), null, 'locked lanes cannot be hover-deleted');
  lane.locked = false; S.drag = {};
  assert.equal(hoveredStageNote(), null, 'dragging cannot delete its own notes midway');
  S.drag = null; S.lastPointerY = 10;
  assert.equal(hoveredStageNote(), null, 'marker rails do not expose notes behind them');
  S.lastPointerY = 30; S.mouseX = null;
  assert.equal(hoveredStageNote(), null, 'leaving the stage clears the target');
} finally { globalThis.document = saved; }
console.log('Hover note viewport and editing guards passed');
