import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const stack = [], ids = new Set(), parents = new Map();
for (const match of html.matchAll(/<\/?([a-z][\w-]*)\b[^>]*>/gi)) {
  const tag = match[1].toLowerCase(), source = match[0];
  if (voidTags.has(tag) && source.startsWith('</')) continue;
  if (source.startsWith('</')) {
    assert.equal(stack.pop()?.tag, tag, `valid nesting at ${source}`);
    continue;
  }
  const id = source.match(/\bid="([^"]+)"/)?.[1];
  if (id) {
    assert.ok(!ids.has(id), `unique id ${id}`); ids.add(id);
    parents.set(id, stack.map(element => element.id).filter(Boolean));
  }
  if (!voidTags.has(tag) && !source.endsWith('/>')) stack.push({ tag, id });
}
assert.equal(stack.length, 0);
for (const id of ['playbackScrollMode', 'noteAppearancePreview', 'tracePlacement'])
  assert.ok(parents.get(id)?.includes('spectrogramSettings'), `${id} belongs to Spectrogram`);
for (const id of ['fretNumbering', 'fretboardOnionEnabled', 'fretboardSettingsPreview'])
  assert.ok(parents.get(id)?.includes('fretboardSettings'), `${id} belongs to Fretboard`);
assert.ok(parents.get('layerInstr')?.includes('spLayer'), 'layer instrument controls retain their own section');
console.log('Editor settings hierarchy, nesting and unique IDs passed');
