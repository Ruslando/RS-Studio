import assert from 'node:assert/strict';
import { toast } from '../../web/notify.js';

const timers = [];
const original = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame, setTimeout: globalThis.setTimeout };
function element() {
  return {
    children: [], classList: { add() {}, remove() {} },
    append(child) { this.children.push(child); },
    addEventListener() {}, setAttribute() {},
  };
}
try {
  globalThis.document = { body: element(), createElement: element };
  globalThis.requestAnimationFrame = fn => fn();
  globalThis.setTimeout = (fn, ms) => { timers.push(ms); return timers.length; };
  toast('Warning', 2200, 'warn');
  toast('Another warning');
  toast('Detailed warning', 6000, 'warn');
  toast('Saved', 2200, 'ok');
  assert.deepEqual(timers, [5000, 5000, 6000, 2200]);
  assert.equal(document.body.children.length, 1, 'notifications share one stack');
  assert.equal(document.body.children[0].children.length, 4, 'new toasts preserve existing ones');
} finally {
  Object.assign(globalThis, original);
}
console.log('Toast lifetime and stacking passed');
