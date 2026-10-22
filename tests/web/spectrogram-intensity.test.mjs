import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
const saved = globalThis.window;
globalThis.window = new EventTarget();
try {
  const { colorIntensity, normalizeIntensityRange, paintIntensity } = await mockImport(new URL('../../web/spectrogram-intensity.js', import.meta.url), { './repaint.js': { draw() {} } });
  const values = new Uint16Array([0, 6554, 13107, 32768, 58982, 65535]);
  const full = colorIntensity(values, 0, 100), filtered = colorIntensity(values, 20, 90);
  assert.equal(filtered[3], 0);
  assert.equal(filtered[7], 0, 'weak values are removed');
  assert.equal(filtered[11], 255, 'lower bound is inclusive');
  assert.equal(filtered[23], 0, 'values above the maximum are removed');
  assert.deepEqual(filtered.slice(8, 16), full.slice(8, 16), 'retained values keep their colors without rescaling');
  assert.deepEqual(normalizeIntensityRange(-4, 103), [0, 100]);
  let drawn;
  const image = {};
  paintIntensity({ drawImage: (...args) => { drawn = args; } }, image, 0, 0, 100, 20, 0, 0, 500, 100, 0, 100);
  assert.equal(drawn[0], image, 'default range uses the original image unchanged');
  const large = new Uint16Array(1024 * 132); large.fill(32768);
  const start = performance.now();
  for (let i = 0; i < 16; i++) colorIntensity(large, i, 100);
  console.log(`16 numeric tiles recolored in ${(performance.now() - start).toFixed(1)} ms`);
} finally { globalThis.window = saved; }
console.log('Numeric spectrogram display cutoffs preserve intensity and colors');
