// Numeric, 16-bit display intensity tiles. Colors and display cutoffs never
// modify the original PNG or the samples used by drawing and analysis.
import { draw } from './repaint.js';

const SIZE = 1024, LIMIT = 24;
const cache = new Map();
let epoch = 0, active = 0, revision = 0;
export const intensityRevision = () => revision;
const queue = [];
const stops = [[0,0,0,4],[.15,28,16,68],[.30,79,18,123],[.45,129,37,129],
  [.60,181,54,122],[.75,229,80,100],[.88,251,135,97],[1,252,253,191]];
const palette = new Uint8ClampedArray(65536 * 4);
for (let i = 0, segment = 0; i < 65536; i++) {
  const value = i / 65535;
  while (segment < stops.length - 2 && value > stops[segment + 1][0]) segment++;
  const a = stops[segment], b = stops[segment + 1], t = (value - a[0]) / (b[0] - a[0]);
  for (let c = 0; c < 3; c++) palette[i * 4 + c] = Math.floor(a[c + 1] + (b[c + 1] - a[c + 1]) * t);
  palette[i * 4 + 3] = 255;
}
export function normalizeIntensityRange(min = 0, max = 100) {
  min = Math.min(100, Math.max(0, Number(min) || 0));
  max = Number(max); max = Number.isFinite(max) ? Math.min(100, Math.max(0, max)) : 100;
  return [min, Math.max(min, max)];
}
export function colorIntensity(values, min, max) {
  const out = new Uint8ClampedArray(values.length * 4);
  const low = Math.ceil(min / 100 * 65535), high = Math.floor(max / 100 * 65535);
  for (let i = 0; i < values.length; i++) {
    const v = values[i], dst = i * 4;
    if (v < low || v > high) continue; // transparent: reveal the stage ground
    out[dst] = palette[v * 4]; out[dst + 1] = palette[v * 4 + 1];
    out[dst + 2] = palette[v * 4 + 2]; out[dst + 3] = 255;
  }
  return out;
}
function notify() { revision++; window.dispatchEvent(new Event('cw-intensity-status')); draw(); }
export function clearIntensityCache() {
  epoch++; cache.clear(); queue.length = 0;
}
window.addEventListener('cw-project-closed', clearIntensityCache);
window.addEventListener('cw-project-opened', clearIntensityCache);
function pump() {
  while (active < 3 && queue.length) {
    const tile = queue.shift();
    if (tile.epoch !== epoch || !cache.has(tile.key)) continue;
    active++;
    fetch(tile.url).then(async response => {
      if (!response.ok) throw new Error('Intensity data unavailable');
      const buffer = await response.arrayBuffer(), header = new DataView(buffer);
      const width = header.getUint32(0, true), height = header.getUint32(4, true);
      if (!width || width > SIZE || height !== tile.height || buffer.byteLength !== 8 + width * height * 2)
        throw new Error('Invalid intensity data');
      tile.width = width;
      tile.values = new Uint16Array(width * height);
      for (let i = 0; i < tile.values.length; i++) tile.values[i] = header.getUint16(8 + i * 2, true);
    }).catch(() => { tile.error = true; }).finally(() => {
      active--; if (tile.epoch === epoch) notify(); pump();
    });
  }
}
function getTile(image, start, stride) {
  const url = new URL(image.src, location.href);
  const match = url.pathname.match(/^\/api\/spectrogram\/([^/]+)\/([^/]+)\.png$/);
  if (!match) return null;
  url.pathname = `/api/intensity/${match[1]}/${match[2]}`;
  url.searchParams.set('start', start); url.searchParams.set('count', SIZE); url.searchParams.set('stride', stride);
  const key = url.href;
  let tile = cache.get(key);
  if (tile) { cache.delete(key); cache.set(key, tile); return tile; }
  tile = { key, url: key, height: image.height, epoch };
  cache.set(key, tile);
  if (cache.size > LIMIT) cache.delete(cache.keys().next().value);
  queue.push(tile); pump();
  queueMicrotask(() => { if (tile.epoch === epoch) window.dispatchEvent(new Event("cw-intensity-status")); });
  return tile;
}
export function intensityStatus(image) {
  if (!image) return '';
  const prefix = new URL(image.src, location.href);
  let loading = false;
  for (const tile of cache.values()) {
    const url = new URL(tile.url);
    if (url.pathname.replace('/api/intensity/', '/api/spectrogram/') + '.png' !== prefix.pathname
        || url.searchParams.get('channel') !== prefix.searchParams.get('channel')
        || url.searchParams.get('view') !== prefix.searchParams.get('view')) continue;
    if (tile.error) return 'Intensity data unavailable';
    if (!tile.values) loading = true;
  }
  return loading ? 'Loading intensity…' : '';
}
export function paintIntensity(ctx, image, sx, sy, sw, sh, dx, dy, dw, dh, min, max) {
  [min, max] = normalizeIntensityRange(min, max);
  if (min === 0 && max === 100) { ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh); return; }
  const stride = 2 ** Math.max(0, Math.min(16, Math.floor(Math.log2(Math.max(1, sw / Math.max(1, dw))))));
  const span = SIZE * stride, end = Math.min(image.width, sx + sw);
  for (let start = Math.floor(sx / span) * span; start < end; start += span) {
    const tile = getTile(image, start, stride);
    if (!tile?.values) continue;
    const range = `${min}:${max}`;
    if (tile.range !== range) {
      tile.canvas ||= document.createElement('canvas');
      tile.canvas.width = tile.width; tile.canvas.height = tile.height;
      const context = tile.canvas.getContext('2d');
      const pixels = context.createImageData(tile.width, tile.height);
      pixels.data.set(colorIntensity(tile.values, min, max));
      context.putImageData(pixels, 0, 0); tile.range = range;
    }
    const left = Math.max(sx, start), right = Math.min(end, start + tile.width * stride);
    if (right > left) ctx.drawImage(tile.canvas, (left - start) / stride, sy, (right - left) / stride, sh,
      dx + (left - sx) / sw * dw, dy, (right - left) / sw * dw, dh);
  }
}
