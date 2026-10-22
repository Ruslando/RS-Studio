import { initSpectrogramDock } from './spectrogram-dock.js';
import { wireMenuAnchors, closeMenus } from './menus.js';
import { S } from './store.js';
import { changeStemChannel } from './project.js';
import { draw } from './repaint.js';
import { intensityStatus, normalizeIntensityRange } from './spectrogram-intensity.js';

export function initSpectrogramControls() {
  const panel = document.getElementById('spectrogramControls');
  const channel = document.getElementById('stageChannel');
  const min = document.getElementById('stageIntensityMin'), max = document.getElementById('stageIntensityMax');
  const minValue = document.getElementById('stageIntensityMinValue'), maxValue = document.getElementById('stageIntensityMaxValue');
  const status = document.getElementById('stageChannelStatus');
  const currentStem = () => S.state?.stems.find(stem => stem.id === S.state.curStem);
  let pending = null;
  const channelButton = document.getElementById('stageChannelButton');
  const channelLabel = document.getElementById('stageChannelLabel');
  const summary = document.getElementById('stageControlsSummary');
  const options = [...panel.querySelectorAll('[data-channel]')];
  wireMenuAnchors(panel);
  initSpectrogramDock(panel);
  for (const option of options) option.addEventListener('click', () => {
    channel.value = option.dataset.channel;
    channel.dispatchEvent(new Event('change'));
    channelButton.focus({ preventScroll: true });
  });
  document.addEventListener('pointerdown', event => {
    if (!panel.contains(event.target) && channelButton.getAttribute('aria-expanded') === 'true') closeMenus();
  });
  function sync() {
    const stem = currentStem();
    panel.hidden = !stem;
    channel.value = stem?.channel || 'stereo';
    channel.disabled = !!stem && pending === stem;
    channelButton.disabled = channel.disabled;
    const name = { stereo: 'Stereo', left: 'Left', right: 'Right' }[channel.value] || 'Stereo';
    channelLabel.textContent = name;
    for (const option of options) {
      const checked = option.dataset.channel === channel.value;
      option.disabled = channel.disabled;
      option.setAttribute('aria-checked', String(checked));
      option.querySelector('.chkmark').textContent = checked ? '✓' : '';
    }
    const range = normalizeIntensityRange(...(S.state?.viewIntensity || [0, 100]));
    status.textContent = channel.disabled ? 'Loading channel…'
      : range[0] === 0 && range[1] === 100 ? '' : intensityStatus(S.spectImg);
    summary.textContent = `${name} · ${range[0]}–${range[1]}%`;
    min.value = String(range[0]); max.value = String(range[1]);
    minValue.textContent = `${range[0]}%`; maxValue.textContent = `${range[1]}%`;
    min.setAttribute('aria-valuetext', minValue.textContent);
    max.setAttribute('aria-valuetext', maxValue.textContent);
  }
  channel.addEventListener('change', async () => {
    const stem = currentStem();
    if (!stem) return;
    const selected = channel.value;
    pending = stem; sync();
    try { await changeStemChannel(stem, selected); }
    finally { if (pending === stem) pending = null; sync(); }
  });
  for (const control of [min, max]) control.addEventListener('input', () => {
    if (!S.state) return;
    let lo = Number(min.value), hi = Number(max.value);
    if (lo > hi) { if (control === min) hi = lo; else lo = hi; }
    S.state.viewIntensity = normalizeIntensityRange(lo, hi);
    sync(); draw();
  });
  panel.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) event.stopPropagation();
  });
  for (const event of ['cw-stem-view-changed', 'cw-project-opened', 'cw-project-closed', 'cw-intensity-status']) window.addEventListener(event, sync);
  sync();
}
