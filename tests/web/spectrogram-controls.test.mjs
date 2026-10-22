import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
class Control extends EventTarget {
  value = ''; hidden = false; disabled = false; checked = true; textContent = '';
  setAttribute() {} matches() { return false; } querySelectorAll() { return []; }
}
const ids = ['spectrogramControls','stageChannel','stageViewButton','stageViewLabel','stageSharp','stageIntensityMin','stageIntensityMax','stageIntensityMinValue','stageIntensityMaxValue','stageChannelStatus','traceSnap','stageChannelButton','stageChannelLabel','stageControlsSummary'];
const controls = Object.fromEntries(ids.map(id => [id, new Control()]));
controls.stageIntensityMin.value = '0'; controls.stageIntensityMax.value = '100';
const a = { id: 'a', channel: 'left' }, b = { id: 'b', channel: 'stereo' };
const S = { state: { curStem: 'a', stems: [a, b] } };
const saved = { window: globalThis.window, document: globalThis.document };
let finish, requested;
try {
  globalThis.window = new EventTarget();
  globalThis.document = { getElementById: id => controls[id], addEventListener() {} };
  const { initSpectrogramControls } = await mockImport(new URL('../../web/spectrogram-controls.js', import.meta.url), {
    './spectrogram-dock.js': { initSpectrogramDock() {} }, './menus.js': { wireMenuAnchors() {}, closeMenus() {} },
    './store.js': { S }, './repaint.js': { draw() {} },
    './spectrogram-intensity.js': { normalizeIntensityRange: (min, max) => [min, max], intensityStatus: () => '' },
    './project.js': { changeStemChannel: (stem, channel) => { requested = [stem, channel]; return new Promise(resolve => { finish = () => { stem.channel = channel; resolve(); }; }); } },
  });
  initSpectrogramControls();
  assert.equal(controls.stageChannel.value, 'left');
  assert.equal(controls.spectrogramControls.hidden, false);
  controls.stageChannel.value = 'right'; controls.stageChannel.dispatchEvent(new Event('change'));
  assert.deepEqual(requested, [a, 'right']);
  assert.equal(controls.stageChannel.disabled, true);
  S.state.curStem = 'b'; window.dispatchEvent(new Event('cw-stem-view-changed'));
  assert.equal(controls.stageChannel.value, 'stereo');
  assert.equal(controls.stageChannel.disabled, false);
  finish(); await Promise.resolve();
  assert.equal(controls.stageChannel.value, 'stereo', 'completion for another stem does not change current selection');
  controls.stageIntensityMin.value = '20'; controls.stageIntensityMin.dispatchEvent(new Event('input'));
  assert.deepEqual(S.state.viewIntensity, [20, 100]);
  assert.equal(controls.stageIntensityMinValue.textContent, '20%');
  controls.stageIntensityMax.value = '10'; controls.stageIntensityMax.dispatchEvent(new Event('input'));
  assert.deepEqual(S.state.viewIntensity, [10, 10], 'crossing bounds keeps the range valid');
  S.state = null; window.dispatchEvent(new Event('cw-project-closed'));
  assert.equal(controls.spectrogramControls.hidden, true);
} finally { Object.assign(globalThis, saved); }
console.log('Spectrogram controls follow the viewed stem and adjust an independent display range');
