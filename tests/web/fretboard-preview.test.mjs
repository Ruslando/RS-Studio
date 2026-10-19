import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { hexA, noteName } from '../../web/util.js';

const text = [], rectangles = [], circles = [], polygons = [], noop = () => {};
let path = [];
const canvas = { clientWidth: 800, clientHeight: 164, getContext: () => ctx };
const ctx = new Proxy({ canvas, globalAlpha: 1, measureText: text => ({ width: text.length * 7 }),
  beginPath() { path = []; },
  moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); },
  arc(x, y, radius) { circles.push({ x, y, radius }); },
  fill() { polygons.push({ points: [...path], color: this.fillStyle }); },
  fillRect(x, y, width, height) { rectangles.push({ x, y, width, height }); },
  fillText(value, x, y) { assert.ok(Number.isFinite(x) && Number.isFinite(y)); text.push({ value, x, y, baseline:this.textBaseline }); } },
  { get: (target, key) => key in target ? target[key] : noop });
const controls = { fretboardSettingsPreview: canvas, fretboardStringOrder: { value: 'low-bottom' },
  fretNumbering: { value: 'capo' }, fretboardAnimations: { checked: true }, fretboardOnionEnabled: { checked: true },
  onionAlphaPrev: { value: '35' }, onionAlphaNext: { value: '35' } };
const saved = { document: globalThis.document, localStorage: globalThis.localStorage };
let labels = 'both';
try {
  Object.assign(globalThis, { document: { querySelector: () => ({ value: labels }) }, localStorage: { getItem: () => null } });
  const { drawFretboardSettingsPreview } = await mockImport(new URL('../../web/fretboard.js', import.meta.url), {
    './dom.js': { $: id => controls[id] }, './layer-role.js': { selectedTablatureLane: () => null },
    './store.js': { S: { state: null } },
    './stage-paint.js': { WASH: .18, UI_PAINT: { chrome: '#111111', ground: '#222222', hint: '#666666', label: '#aaaaaa', ok: '#77aacc', ink: '#000000', paper: '#ffffff', text: '#ffffff' } },
    './util.js': { dpr: () => 1, hexA, noteName },
  }, { './fretboard-core.js': true, './constants.js': true, './articulations.js': true,
    './fretboard-preview-phrase.js': true, './string-glow.js': true, './string-techniques.js': true, './whammy.js': true });
  drawFretboardSettingsPreview(1.5);
  assert.ok(!text.some(item => /Capo|Hand position/.test(item.value)), 'no preview-only captions');
  assert.deepEqual(text.filter(item => item.baseline === 'top').map(item => item.value), ['1','3','5','7','10'],
    'the cropped neck uses the live board’s inlay-fret numbering');
  const neck = polygons[0].points;
  const neckLeft = Math.min(...neck.map(point => point[0])), neckRight = Math.max(...neck.map(point => point[0]));
  assert.ok(polygons.some(shape => shape.color === hexA('#77aacc', .18) && shape.points.length === 4), 'hand position has a filled fret-space band');
  const capoBar = rectangles.find(rect => rect.x > neckLeft + 10 && rect.x < neckRight && rect.height > 50 && rect.width < 20);
  assert.ok(capoBar, 'a physical capo is drawn across the strings, not just named');
  const nutLabels = text.filter(item => ['E4', 'B3', 'G3', 'D3', 'A2', 'E2'].includes(item.value) && item.x < neckLeft);
  assert.equal(nutLabels.length, 6, 'all open string names are painted left of the physical nut');
  for (const circle of circles) assert.ok(circle.x - circle.radius >= neckLeft && circle.x + circle.radius <= neckRight, 'every finger and ghost stays inside the neck');
  assert.ok(text.some(item => /[A-G]/.test(item.value) && item.x >= neckLeft), 'real note labels appear');
  const finger = text.find(item => item.value === '1' && item.baseline === 'middle');
  assert.ok(finger, 'finger numbers are rendered using the grip renderer');
  controls.fretboardStringOrder.value = 'low-top'; text.length = 0;
  drawFretboardSettingsPreview(1.5);
  const flipped = text.find(item => item.value === '1' && item.baseline === 'middle');
  assert.ok(Math.abs(finger.y + flipped.y - 165) < .01, 'string order mirrors the preview contacts');
  labels = 'none'; controls.fretNumbering.value = 'nut'; controls.fretboardOnionEnabled.checked = false; text.length = 0;
  drawFretboardSettingsPreview();
  assert.deepEqual(text.map(item => item.value), ['3', '5', '7', '9', '12', 'E4', 'B3', 'G3', 'D3', 'A2', 'E2'],
    'inlay-fret numbers and tuning remain visible independently of contact label settings');
  for (const width of [260, 420, 800]) for (const time of [0, 1.5, 3]) {
    canvas.clientWidth = width; polygons.length = 0; circles.length = 0; text.length = 0;
    drawFretboardSettingsPreview(time);
    const board = polygons[0].points, left = Math.min(...board.map(p => p[0])), right = Math.max(...board.map(p => p[0]));
    for (const circle of circles) assert.ok(circle.x - circle.radius >= left && circle.x + circle.radius <= right, `contacts fit at width ${width}, time ${time}`);
    for (const number of text.filter(item => /^\d+$/.test(item.value))) assert.ok(number.x >= left && number.x <= right, 'fret numbers stay below their actual frets');
  }
} finally { Object.assign(globalThis, saved); }
console.log('Settings fretboard uses the live neck through fret twelve, labels, numbering and string order');
