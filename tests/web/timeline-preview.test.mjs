import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

class Target extends EventTarget { matches() { return false; } }
const ctx = new Proxy({}, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => { target[key] = value; return true; } });
const cards = [new Target(), new Target()];
const canvases = ['page', 'follow'].map((mode, index) => ({ clientWidth: 300, dataset: { scrollPreview: mode },
  getContext: () => ctx, closest: () => cards[index] }));
const documentTarget = Object.assign(new Target(), { hidden: false, querySelectorAll: () => canvases });
const reduced = Object.assign(new Target(), { matches: false });
const frames = new Map(); let nextFrame = 0;
const notes = []; const lines = []; const bars = [];
const saved = Object.fromEntries(['document', 'window', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, globalThis[key]]));
try {
  Object.assign(globalThis, { document: documentTarget, window: { innerWidth: 900 }, matchMedia: () => reduced,
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id) });
  const preview = await mockImport(new URL('../../web/timeline-scroll-preview.js', import.meta.url), {
    './timeline-paint.js': {
      paintNoteRow: (ctx,x,y,width,height) => notes.push({x,y,width,height}),
      paintTimeGridLine: (ctx,x,top,bottom,kind) => lines.push({x,top,bottom,kind}),
      paintBarNumber: (ctx,x,bottom,label) => bars.push({x,label}),
    },
    './dom.js': { scroll: { clientWidth: 900 } }, './stage-paint.js': { PAINT: {} },
    './util.js': { dpr: () => 1, playheadScrollLeft: () => 0 }, './constants.js': { stageMono: () => '10px monospace' },
  });
  preview.initTimelineScrollPreview(); preview.setTimelineScrollPreviewVisible(true);
  assert.ok(notes.length > 0);
  for (const note of notes) {
    assert.equal(note.x % 20, 0, 'attacks land on a beat');
    assert.equal(note.width % 20, 0, 'releases land on a beat');
    assert.equal((note.y - 6) % note.height, 0, 'notes stay on pitch rows');
    assert.ok(note.y + note.height <= 76, 'no notes overflow the preview');
  }
  assert.ok(lines.some(line => line.kind === 'bar'));
  assert.ok(bars.length && bars.every(bar => lines.some(line => line.kind === 'bar' && line.x === bar.x)),
    'bar numbers sit on the bar lines, as on the stage');
  for (const [id, fn] of [...frames]) { frames.delete(id); fn(0); }
  assert.equal(frames.size, 0, 'idle settings do not run animation frames');
  assert.deepEqual(canvases.map(canvas => canvas.dataset.running), ['false', 'false']);
  cards[0].dispatchEvent(new Event('mouseenter'));
  assert.deepEqual(canvases.map(canvas => canvas.dataset.running), ['true', 'false'], 'only the hovered preview runs');
  assert.equal(frames.size, 1);
  cards[0].dispatchEvent(new Event('mouseleave'));
  assert.equal(frames.size, 0, 'leaving the card stops its animation');
  cards[1].dispatchEvent(new Event('mouseenter'));
  assert.deepEqual(canvases.map(canvas => canvas.dataset.running), ['false', 'true']);
  documentTarget.hidden = true; documentTarget.dispatchEvent(new Event('visibilitychange'));
  assert.equal(frames.size, 0, 'background tabs stop animation');
  documentTarget.hidden = false; reduced.matches = true; reduced.dispatchEvent(new Event('change'));
  assert.equal(frames.size, 0, 'reduced motion leaves the preview static');
  preview.setTimelineScrollPreviewVisible(false);
  assert.deepEqual(canvases.map(canvas => canvas.dataset.running), ['false', 'false']);
} finally { Object.assign(globalThis, saved); }
console.log('Timeline previews animate only on hover');
