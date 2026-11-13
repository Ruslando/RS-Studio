import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

const painted = [], noop = () => {};
const ctx = new Proxy({ fillText: (text, x, y) => painted.push({ text, x, y }) }, {
  get: (target, key) => key in target ? target[key] : noop,
});
const { collectStacks, drawStackBadges } = await mockImport(new URL('../../web/note-render.js', import.meta.url), {
  './store.js': { S: { state: { rowH: 20 } } },
  './dom.js': { sctx: ctx },
  './geometry.js': { xOf: t => t * 100, yOf: () => 40 },
  './stage-paint.js': { PAINT: {}, veil: () => '#000' },
}, { './constants.js': true, './note-issues.js': true });

const first = { start: 0, end: 2, pitch: 40 }, second = { start: 1, end: 4, pitch: 40 };
const counts = new Map(), badges = [];
collectStacks({ notes: [second, first] }, counts, badges);
assert.equal(counts.get(first), 2);
assert.equal(counts.get(second), 2);
assert.equal(badges.length, 1);
drawStackBadges(badges, 0, 500);
assert.deepEqual(painted.pop(), { text: '2', x: 9, y: 50.5 });
drawStackBadges(badges, 250, 500);
assert.deepEqual(painted.pop(), { text: '2', x: 259, y: 50.5 },
  'the count stays visible when the cluster starts before the viewport');
drawStackBadges(badges, 450, 600);
drawStackBadges(badges, -200, -100);
assert.equal(painted.length, 0, 'clusters outside the viewport are culled');
const unison = [
  { start: 1, end: 2, pitch: 40, pos: { string: 1 } },
  { start: 1.5, end: 2.5, pitch: 40, pos: { string: 2 } },
];
const unisonCounts = new Map(), unisonBadges = [];
collectStacks({ notes: unison }, unisonCounts, unisonBadges);
assert.equal(unisonCounts.size, 0, 'a playable unison is not a warning');
assert.equal(unisonBadges.length, 1, 'separate strings still receive a visual overlap badge');
assert.equal(unisonBadges[0].count, 2);
const touchingBadges = [];
collectStacks({ notes: [{ start: 1, end: 2, pitch: 40 }, { start: 2, end: 3, pitch: 40 }] }, new Map(), touchingBadges);
assert.equal(touchingBadges.length, 0, 'adjacent repeated notes are not overlaps');
console.log('Overlap badge counts and viewport visibility passed');
