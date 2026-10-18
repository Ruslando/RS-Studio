import assert from 'node:assert/strict';
import { notePreviewLayout } from '../../web/editor-preview-layout.js';

for (const width of [260, 320, 420, 799, 800, 1180]) {
  const { notes, cellWidth, rowHeight, gridTop } = notePreviewLayout(width);
  assert.equal(notes[0].y - notes[1].y, 3 * rowHeight, 'G4 is three pitch rows above E4');
  for (const note of notes) {
    assert.equal(note.x % cellWidth, 0, 'attack starts on a grid line');
    assert.equal((note.x + note.width) % cellWidth, 0, 'release ends on a grid line');
    assert.equal((note.y - gridTop) % rowHeight, 0, 'note starts on a pitch row');
    assert.equal(note.height, rowHeight, 'note fills exactly one pitch row');
    assert.ok(note.x >= cellWidth && note.x + note.width <= width - cellWidth, 'notes leave space for slide glyphs');
  }
}
console.log('Example notes align with their grid at every preview width');
