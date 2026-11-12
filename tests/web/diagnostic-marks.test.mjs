import assert from 'node:assert/strict';
import { warningMarks, diagnosticMarksAt } from '../../web/diagnostic-marks.js';

const note = { id: 'n1' }, otherNote = { id: 'n2' };
const lane = { id: 'a' }, otherLane = { id: 'b' };
const entry = { lane, issue: { id: 'editor.note.stack', notes: [note] } };
const repeatedEntry = { lane, issue: { id: 'editor.note.stack', notes: [note] } };
const distinctNote = { lane, issue: { id: 'editor.note.stack', notes: [otherNote] } };
const distinctLane = { lane: otherLane, issue: entry.issue };
const bounds = { x0: 10, x1: 20, y0: 30, y1: 40 };
try {
  warningMarks.push(...[entry, repeatedEntry, distinctNote, distinctLane].map(diagnostic =>
    ({ ...bounds, tip: { diagnostic } })), { ...bounds, tip: { title: 'Tooltip only' } });
  assert.deepEqual(diagnosticMarksAt(10, 30), [repeatedEntry, distinctNote, distinctLane],
    'overlapping marks deduplicate by issue occurrence while preserving note and lane identity');
  assert.equal(diagnosticMarksAt(20, 40).length, 3, 'edges are included');
  assert.deepEqual(diagnosticMarksAt(9, 30), []);
  assert.deepEqual(diagnosticMarksAt(10, 41), []);
  warningMarks.length = 0;
  assert.deepEqual(diagnosticMarksAt(15, 35), [], 'a cleared frame cannot retain stale hit targets');
  warningMarks.push({ ...bounds, tip: { diagnostic: entry } });
  assert.deepEqual(diagnosticMarksAt(15, 35), [entry], 'the next frame publishes fresh targets');
} finally { warningMarks.length = 0; }
console.log('Diagnostic bounds, occurrence deduplication and frame clearing passed');
