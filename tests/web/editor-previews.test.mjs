import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

const noop = () => {}, text = [], frames = new Map(); let frameId = 0;
class Canvas extends EventTarget {
  clientWidth = 420; hovered = false; hiddenParent = false;
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  closest() { return this.hiddenParent ? {} : null; }
  matches() { return this.hovered; }
  getContext() { return ctx; }
}
const ctx = new Proxy({ measureText(text) { return { width: text.length * parseFloat(this.font.match(/[\d.]+(?=px)/)[0]) * 0.5 }; }, fillText: value => text.push(value) }, { get: (target, key) => target[key] || noop });
const note = new Canvas(), board = new Canvas();
const controls = { noteAppearancePreview: note, fretboardSettingsPreview: board, spTrace: {},
  spectrogramNoteNames: { value: 'off' }, spectrogramPositions: { value: 'hover' },
  spectrogramEffects: { value: 'hover' }, fretNumbering: { value: 'capo' }, fretboardAnimations: { checked: true } };
const doc = Object.assign(new EventTarget(), { hidden: false, getElementById: id => controls[id] });
const reduced = Object.assign(new EventTarget(), { matches: false });
const saved = Object.fromEntries(['document', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'].map(key => [key, globalThis[key]]));
try {
  Object.assign(globalThis, { document: doc, matchMedia: () => reduced,
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id), ResizeObserver: class { observe() {} } });
  const painter = await mockImport(new URL('../../web/note-label-paint.js', import.meta.url), {
    './stage-paint.js': { PAINT: { text: '#fff' }, halo: () => '#000' },
  }, { './constants.js': true, './spectrogram-labels.js': true });
  const previews = await mockImport(new URL('../../web/editor-previews.js', import.meta.url), {
    './dom.js': { $: id => controls[id] }, './timeline-paint.js': { paintNoteRow: noop, paintTimeGridLine: noop }, './store.js': { S: { state: null } },
    './note-label-paint.js': painter, './stage-paint.js': { PAINT: {} }, './util.js': { dpr: () => 1 },
    './fretboard.js': { drawFretboardSettingsPreview: noop },
  }, { './spectrogram-labels.js': true, './editor-preview-layout.js': true, './note-effects.js': true });
  previews.initEditorPreviews();
  assert.equal(text.length, 0, 'preview obeys hidden and hover-only settings while idle');
  const mouse = new Event('mousemove'); mouse.clientX = 90; mouse.clientY = 82;
  note.hovered = true; note.dispatchEvent(mouse);
  assert.deepEqual(text, ['S2:F5', '↗'], 'preview shows the same position and slide labels when hovered');
  text.length = 0; note.hovered = false; note.dispatchEvent(new Event('mouseleave'));
  assert.equal(text.length, 0);
  controls.spectrogramNoteNames.value = 'always'; previews.refreshEditorPreviews();
  assert.deepEqual(text, ['E4', 'G4'], 'preference changes immediately update the preview');
  assert.equal(frames.size, 0, 'idle board preview does not animate');
  board.hovered = true; board.dispatchEvent(new Event('mouseenter'));
  assert.equal(frames.size, 1);
  controls.fretboardAnimations.checked = false;
  previews.refreshEditorPreviews();
  assert.equal(frames.size, 1, 'disabling transitions does not stop the preview clock');
  const tick = [...frames.values()][0]; frames.clear(); tick(1000);
  assert.equal(frames.size, 1, 'note changes keep running without animated transitions');
  board.hiddenParent = true; previews.refreshEditorPreviews();
  assert.equal(frames.size, 0, 'closing settings cancels the board animation');
  board.hiddenParent = false; board.hovered = false; previews.refreshEditorPreviews();
  assert.equal(frames.size, 0, 'reopening without hover leaves the board static');
} finally { Object.assign(globalThis, saved); }
console.log('Editor previews reflect labels and stop hidden animations');
