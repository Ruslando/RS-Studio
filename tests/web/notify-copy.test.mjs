import assert from 'node:assert/strict';
import { toast } from '../../web/notify.js';

const names = ['document', 'window', 'navigator', 'requestAnimationFrame', 'setTimeout'];
const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
function element() {
  return {
    children: [], listeners: {}, classList: { add() {}, remove() {} },
    append(child) { this.children.push(child); },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    setAttribute() {},
    querySelector(selector) { return this.children.find(child => `.${child.className}` === selector); },
  };
}
const body = element();
const text = 'Missing tone presets: Clean, Crunch. Choose an available preset for the marked tone switches.';
let selected = null;
let clipboardText = null;
let commands = [];
let copyResult = true;
const selection = {
  removeAllRanges() { selected = null; },
  addRange(range) { selected = range.node; },
};
const document = {
  body, createElement: element,
  createRange() { return { selectNodeContents(node) { this.node = node; } }; },
  execCommand(command) {
    commands.push(command);
    if (copyResult instanceof Error) throw copyResult;
    if (copyResult) clipboardText = selected.textContent;
    return copyResult;
  },
};
try {
  const globals = { document, window: { getSelection: () => selection }, navigator: {},
    requestAnimationFrame: fn => fn(), setTimeout: () => 0 };
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

  for (const scenario of ['clipboard', 'denied', 'unavailable', 'copy-false', 'copy-throws']) {
    selected = null; clipboardText = null; commands = [];
    copyResult = scenario === 'copy-false' ? false : scenario === 'copy-throws' ? new Error('disabled') : true;
    navigator.clipboard = scenario === 'unavailable' ? undefined : {
      async writeText(value) {
        if (scenario !== 'clipboard') throw new Error('NotAllowedError');
        clipboardText = value;
      },
    };
    toast(text, 10000, 'warn');
    const notification = body.children[0].children.at(-1);
    const button = notification.querySelector('.toast-copy');
    await button.listeners.click();
    if (scenario === 'copy-false' || scenario === 'copy-throws') {
      assert.equal(button.textContent, 'Press Ctrl+C', scenario);
      assert.equal(selected.textContent, text, 'keyboard fallback keeps the complete text selected');
    } else {
      assert.equal(button.textContent, 'Copied', scenario);
      assert.equal(clipboardText, text, 'copies the complete warning without button text');
    }
    assert.deepEqual(commands, scenario === 'clipboard' ? [] : ['copy'], scenario);
  }
} finally {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
console.log('Notification clipboard and denied-permission fallbacks passed');
