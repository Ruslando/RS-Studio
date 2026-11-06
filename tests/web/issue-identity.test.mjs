import assert from 'node:assert/strict';
import { issueId, migrateIgnoredIssues } from '../../web/issue-identity.js';
import { laneIssues } from '../../web/note-issues.js';

const tuning = [43, 38, 33, 28];
const note = more => ({ id: 'n', start: 1, end: 2, pitch: 33, ...more });
const issues = more => laneIssues({ notes: [note(more)] }, tuning, 20);
assert.equal(issues({ trill: 'half' })[0].id, 'editor.adapt.trill');
assert.equal(issues({ gp: { noteExtras: { ornament: 1 } } })[0].id, 'editor.import.ornament');
assert.equal(issues({ ornament: 'turn' })[0].id, 'editor.adapt.ornament');
assert.equal(issues({ pitch: 10 })[0].id, 'editor.note.outOfRange');
const shape = laneIssues({ notes: [28, 33, 38, 43, 48].map(pitch => note({ pitch })) }, tuning, 20);
assert.equal(shape[0].id, 'editor.shape.impossible');
assert.equal(shape[0].kind, 'shape', 'rendering keeps its existing kind');

const ignored = migrateIgnoredIssues([
  'I35', 'I29', 'No valid shape found', 'Trill as hammer-ons and pull-offs',
  'trill', 'flag-anchor', 'not-exported',
  'Ignored Rocksmith tone switch outside the song at 25.000s',
  'Phrase boundary at 1.234s was snapped to the nearest beat',
]);
for (const id of ['I35', 'I29', 'export.chord-dead-note-removed', 'editor.shape.impossible',
  'editor.adapt.trill', 'export.trill', 'marker.anchor-out-of-reach', 'export.no-voiced-notes',
  'export.tone-outside-song', 'export.phrase-snapped']) assert.ok(ignored.has(id), id);
assert.deepEqual(migrateIgnoredIssues([...ignored]), ignored, 'migration is idempotent');
assert.equal(issueId('editor.adapt.trill'), 'editor.adapt.trill');
assert.equal(issueId('future.condition'), 'future.condition', 'preserve unknown saved IDs');
console.log('issue identity passed');
