import assert from 'node:assert/strict';
import { renderCoverPreview } from '../../web/cover-preview.js';

const originalDocument = globalThis.document;
globalThis.document = { createElement: tagName => ({ tagName }) };
try {
  let hasCover;
  const fields = { thumb: { children: [],
    classList: { toggle: (_name, enabled) => { hasCover = enabled; } },
    replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } },
    title: {}, sub: {}, clear: {} };
  const url = 'cover/"<image>.png';
  renderCoverPreview({ coverArtUrl: url, coverArtName: '<My cover>' }, fields);
  assert.equal(hasCover, true);
  assert.deepEqual(fields.thumb.children, [{ tagName: 'img', src: url, alt: '' }]);
  assert.equal(fields.title.textContent, '<My cover>', 'cover names stay text');
  assert.equal(fields.clear.hidden, false);
  renderCoverPreview({ coverArtUrl: 'other.png' }, fields);
  assert.equal(fields.thumb.children.length, 1, 'replacing a cover removes the previous thumbnail');
  assert.equal(fields.title.textContent, 'Cover art');
  renderCoverPreview({}, fields);
  assert.equal(hasCover, false);
  assert.equal(fields.thumb.children.length, 0);
  assert.equal(fields.title.textContent, 'Choose image');
  assert.equal(fields.clear.hidden, true);
  assert.equal(fields.sub.textContent, '');
} finally { globalThis.document = originalDocument; }
console.log('Cover replacement, clearing and literal URL/name rendering passed');
