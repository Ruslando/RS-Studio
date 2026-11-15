import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';

const previous = { window: globalThis.window, localStorage: globalThis.localStorage, requestAnimationFrame: globalThis.requestAnimationFrame };
const frames = [], seeks = [];
globalThis.requestAnimationFrame = callback => { frames.push(callback); };
const values = new Map();
globalThis.window = new EventTarget();
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
try {
  const scroll = new EventTarget();
  scroll.scrollLeft = 160; scroll.scrollTop = 42;
  const speedSel = new EventTarget(); speedSel.value = '0.75';
  const audio = new EventTarget(); audio.getAttribute = () => 'song.opus'; audio.readyState = 0;
  const S = { zoomX: 2, zoomY: 3, state: { job: 'imported', viewKey: 'original', curStem: 'mix',
    editLanes: [{ id: 'a', active: false }, { id: 'b', active: true }] } };
  const view = await mockImport(new URL('../../web/project-view.js', import.meta.url), {
    './dom.js': { audio, scroll, speedSel }, './store.js': { S },
    './playback.js': { playbackTime: () => 12, seekPlayback: time => seeks.push(time) },
  });
  view.initProjectView();
  window.dispatchEvent(new Event('cw-zoom-changed'));
  window.dispatchEvent(new Event('cw-lanes-rendered'));
  await new Promise(resolve => setTimeout(resolve, 550));
  const saved = view.savedView('another-import', 'original');
  assert.equal(saved.zoomX, 2);
  assert.equal(saved.zoomY, 3);
  assert.equal(saved.activeLane, 'b');
  assert.equal(saved.left, 160);
  assert.equal(saved.time, 12);
  assert.equal(view.savedView('unrelated'), null);
  view.beginProjectView();
  scroll.scrollLeft = 0; scroll.scrollTop = 0;
  window.dispatchEvent(new Event('cw-lanes-rendered'));
  window.cwSaveProjectView();
  assert.equal(view.savedView('imported', 'original').left, 160, 'loading cannot overwrite saved scroll');
  const restored = view.restoreView({ ...saved, time: 37 });
  frames.shift()(); await restored;
  assert.equal(scroll.scrollLeft, 160, 'scroll restores without waiting for audio');
  window.cwSaveProjectView();
  assert.equal(view.savedView('imported', 'original').time, 37, 'slow audio cannot overwrite saved playhead');
  view.beginProjectView();
  S.state = { ...S.state, job: 'new', viewKey: 'new' };
  const nextRestored = view.restoreView({ left: 81, time: 0 });
  frames.shift()(); await nextRestored;
  audio.dispatchEvent(new Event('loadedmetadata'));
  assert.deepEqual(seeks, [0], 'late metadata from a previous project cannot seek the new project');
  assert.equal(scroll.scrollLeft, 81);
  S.zoomX = 4;
  window.dispatchEvent(new Event('cw-project-closed'));
  assert.equal(view.savedView('new').zoomX, 4, 'closing flushes the last view');
} finally {
  globalThis.window = previous.window;
  globalThis.localStorage = previous.localStorage;
  globalThis.requestAnimationFrame = previous.requestAnimationFrame;
}
console.log('project view: explicit zoom and layer persistence with stable import identity passed');
