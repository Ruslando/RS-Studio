import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
const noop = () => {};
class Element extends EventTarget { hidden = false; textContent = ''; value = '18'; }
const elements = Object.fromEntries(['matchNavigator', 'matchPosition', 'matchPrevious', 'matchNext'].map(id => [id, new Element()]));
const ctx = new Proxy({ measureText: () => ({ width: 30 }) }, { get: (t, k) => t[k] || noop });
const saved = globalThis.document;
const note = { start: 0, end: 1, pitch: 65 }, lane = { notes: [note], visible: true };
const S = { state: { lanes: [lane], duration: 20, spec: { midi_low: 60, midi_high: 72 }, rowH: 10 },
  selection: new Set([note]), spectImg: { width: 20, height: 12 }, spectPixels: [],
  matches: [], matchHover: -1, matchFocus: -1, stageHeight: 120 };
const scroll = { scrollLeft: 0, scrollTop: 0, clientWidth: 200 };
const seeks = []; let hasResults = true, unlocks = 0, refHit = null;
try {
  globalThis.document = { getElementById: id => elements[id], querySelectorAll: () => [],
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  const tracing = await mockImport(new URL('../../web/tracing.js', import.meta.url), {
    './store.js': { S, setSelection: noop }, './ids.js': { nid: () => 'n' }, './dom.js': { scroll, sctx: ctx, traceThresholdInput: new Element(), traceRangeSel: null, traceSnapInput: null },
    './repaint.js': { draw: () => tracing.drawMatches() },
    './lanes.js': { laneOf: () => lane, targetLane: () => lane, renderLanes: noop, refreshCounts: noop },
    './references.js': { boxOfNote: () => refHit, laneClock: () => ({ beatAt: t => t * 2, timeAt: b => b / 2 }) },
    './geometry.js': { xOf: t => t * 100, yOf: p => (72 - p) * 10, contentH: () => 120,
      songWidth: () => 2000, timeAt: x => x / 100 },
    './similar-core.js': { similarScores: () => { const scores = new Float64Array(20); if (hasResults) { scores[5] = .99; scores[12] = .98; } return scores; } },
    './edit.js': { copyEffects: (source, target) => target, snapshotEdit: noop, commit: noop,
      clipOf: notes => notes.map(n => ({ ...n, beat0: n.start * 2 })), placeClip: (clip, l, at) => clip.map(c => ({ start: at + c.start - clip[0].start, end: at + c.end - clip[0].start })) },
    './playback.js': { ensureTone: () => { unlocks++; return new Promise(noop); },
      seekPlayback: t => seeks.push(t), cancelPassagePreview: noop, clearPreview: noop },
    './notify.js': { toast: noop }, './stage-paint.js': { PAINT: { trace: '#ff0088', ground: '#000000' } },
  }, { './constants.js': true, './util.js': true });
  tracing.init_tracing();
  assert.equal(elements.matchNavigator.hidden, true);
  tracing.runFindSimilar();
  assert.equal(S.matches.length, 2);
  assert.equal(S.matchFocus, 0, 'search immediately focuses the first chronological result');
  assert.equal(seeks.at(-1), 5);
  assert.equal(scroll.scrollLeft, 450, 'first result is centered in the viewport');
  assert.equal(elements.matchNavigator.hidden, false);
  assert.equal(elements.matchPosition.textContent, '1 / 2');
  assert.equal(unlocks, 1, 'initial jump does not automatically start audio playback');
  elements.matchNext.dispatchEvent(new Event('click'));
  assert.equal(S.matchFocus, 1);
  assert.equal(elements.matchPosition.textContent, '2 / 2');
  elements.matchNext.dispatchEvent(new Event('click'));
  assert.equal(S.matchFocus, 0, 'navigation wraps');
  elements.matchPrevious.dispatchEvent(new Event('click'));
  assert.equal(S.matchFocus, 1);
  S.matchFocus = 0; tracing.acceptMatch(0);
  assert.equal(S.matches.length, 1, 'placing a match removes it from the results');
  assert.equal(S.matchFocus, 0);
  assert.equal(scroll.scrollLeft, 1150, 'the view moves on to the next result');
  assert.equal(lane.notes.length, 2, 'the match was pasted as a copy');
  // A reference match gets a box as many beats ahead of its first note as the source's.
  const group = { anchors: [-0.5] };
  lane.refBoxes = { 1: group }; lane.notes = [note];
  refHit = { lane, ref: 1, group, i: 0 };
  tracing.runFindSimilar();
  tracing.acceptMatch(1, 'reference');
  assert.deepEqual(group.anchors, [-0.5, 11.5]);
  refHit = null;
  tracing.clearMatches();
  assert.equal(elements.matchNavigator.hidden, true, 'clearing results removes navigation immediately');
  hasResults = false; tracing.runFindSimilar();
  assert.equal(elements.matchNavigator.hidden, true, 'empty search keeps navigation hidden');
} finally { globalThis.document = saved; }
console.log('Similar search jumps to its first result and exposes persistent result navigation');
