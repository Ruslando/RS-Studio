import { findRepeats } from './repeats-core.js';
self.onmessage = ({ data: notes }) => {
  const repeats = findRepeats(notes);
  self.postMessage(repeats.map(r => ({ copies: r.copies.map(c => c.notes.map(({ note }) => note.id)) })));
};
